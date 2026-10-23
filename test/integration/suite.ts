import * as assert from 'assert';
import * as vscode from 'vscode';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, description: string, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out: ' + description);
    await delay(20);
  }
}
async function openMarked(source: string) {
  const cursor = source.indexOf('|');
  assert.ok(cursor >= 0);
  const document = await vscode.workspace.openTextDocument({
    language: 'latex', content: source.slice(0, cursor) + source.slice(cursor + 1),
  });
  const editor = await vscode.window.showTextDocument(document);
  const position = document.positionAt(cursor);
  editor.selection = new vscode.Selection(position, position);
  return editor;
}
async function type(text: string) {
  for (const char of text) await vscode.commands.executeCommand('type', { text: char });
}
async function configure(enabled: boolean) {
  await vscode.workspace.getConfiguration('hsnips').update('autoAlign.enabled', enabled, vscode.ConfigurationTarget.Global);
}
async function closeAll() {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}
export async function run() {
  const extension = vscode.extensions.getExtension('pasiooooo.vscode-hypersnips');
  assert.ok(extension, 'development extension is installed');
  await extension!.activate();
  await configure(false);
  const failures: string[] = [];
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failures.push(name + ': ' + String(error)); console.error(error); }
    finally { await configure(false); await closeAll(); }
  }
  await test('dynamic snippet follows placeholder edits', async () => {
    const editor = await openMarked('dd|');
    // Let queued visibility events finish before starting a snippet session.
    await delay(200);
    const result = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.selection.active);
    const item = result?.items.find(item => item.detail === 'Dynamic fixture');
    assert.ok(item?.command?.arguments?.[0], 'dynamic completion is available');
    await vscode.commands.executeCommand(item!.command!.command, ...item!.command!.arguments!);
    await until(() => editor.document.getText() === ' = SEED', 'dynamic expansion');
    await type('word');
    await until(() => editor.document.getText() === 'word = WORD', 'dynamic placeholder update');
    await vscode.commands.executeCommand('hsnips.leaveSnippet');
  });
  await test('smart Tab and Enter, caret and undo/redo', async () => {
    const editor = await openMarked('\\begin{align}\n  a|\n\\end{align}');
    await vscode.commands.executeCommand('hsnips.smartTab');
    await until(() => editor.document.getText().includes(' & '), 'smart Tab edit');
    assert.strictEqual(editor.document.getText(), '\\begin{align}\n  a & \n\\end{align}');
    assert.strictEqual(editor.selection.active.character, 6);
    const beforeEnter = editor.document.getText();
    await vscode.commands.executeCommand('hsnips.smartEnter');
    await until(() => editor.document.lineCount === 4, 'smart Enter edit');
    assert.strictEqual(editor.document.getText(), '\\begin{align}\n  a & \\\\\n  \n\\end{align}');
    const after = editor.document.getText();
    await vscode.commands.executeCommand('undo');
    await until(() => editor.document.getText() === beforeEnter, 'undo restores pre-Enter text');
    await vscode.commands.executeCommand('redo');
    await until(() => editor.document.getText() === after, 'redo restores Enter text');
    assert.strictEqual(editor.document.getText(), after);
  });
  await test('typing environment name updates matching end', async () => {
    const editor = await openMarked('\\begin{align|}\n  a &= b\n\\end{align}');
    await type('*');
    await until(() => editor.document.getText().includes('\\end{align*}'), 'matching environment name');
    assert.strictEqual(editor.document.getText(), '\\begin{align*}\n  a &= b\n\\end{align*}');
  });
  await test('automatic snippet respects math and text contexts', async () => {
    let editor = await openMarked('|');
    await type('zz');
    await until(() => editor.document.getText() === 'EXPANDED', 'automatic expansion');
    editor = await openMarked('$|$');
    await type('mm');
    await until(() => editor.document.getText() === '$MATH$', 'math expansion');
    editor = await openMarked('|');
    await type('mm');
    assert.strictEqual(editor.document.getText(), 'mm');
    editor = await openMarked('|');
    await type('tt');
    await until(() => editor.document.getText() === 'TEXT', 'text expansion');
  });
  await test('completion provider and accepted manual snippet', async () => {
    const editor = await openMarked('man|');
    const result = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.selection.active);
    const item = result?.items.find(item => item.detail === 'Manual fixture');
    assert.ok(item, 'manual snippet must appear in completion results');
    assert.strictEqual(item!.label, 'manual');
    assert.ok(item!.command, 'completion must carry its expansion command');
    assert.ok(item!.range instanceof vscode.Range);
    await editor.edit(builder => builder.replace(item!.range as vscode.Range, item!.insertText as string));
    await vscode.commands.executeCommand(item!.command!.command, ...(item!.command!.arguments || []));
    await until(() => editor.document.getText() === 'MANUAL', 'accepted manual snippet expansion');
  });
  await test('multi-cursor Tab and comment protection', async () => {
    const editor = await openMarked('\\begin{matrix}\na|x\nby\n\\end{matrix}');
    editor.selections = [new vscode.Selection(1, 1, 1, 1), new vscode.Selection(2, 1, 2, 1)];
    await vscode.commands.executeCommand('hsnips.smartTab');
    await until(() => editor.document.getText().includes(' & '), 'smart Tab edit');
    assert.strictEqual(editor.document.getText(), '\\begin{matrix}\na & x\nb & y\n\\end{matrix}');
    const comment = await openMarked('\\begin{align}\n% comment|\n\\end{align}');
    const version = comment.document.version;
    await vscode.commands.executeCommand('hsnips.smartTab');
    await until(() => comment.document.version > version, 'comment receives normal Tab edit');
    assert.ok(!comment.document.getText().includes('&'), 'comment must not insert an alignment separator');
  });
  await test('auto alignment changes whitespace only and stops when disabled', async () => {
    const source = '\\begin{matrix}\n a|&b \\\\\n longer&c \\\\\n\\end{matrix}';
    const editor = await openMarked(source);
    await configure(true);
    await type('x');
    const unformatted = source.replace('|', 'x');
    await until(() => editor.document.getText() !== unformatted, 'automatic alignment');
    const formatted = editor.document.getText();
    assert.strictEqual(formatted.replace(/[ \t]/g, ''), unformatted.replace(/[ \t]/g, ''));
    assert.strictEqual(editor.document.getText(new vscode.Range(new vscode.Position(1, 0), editor.selection.active)).trim(), 'ax');
    await configure(false);
    await editor.edit(builder => builder.insert(new vscode.Position(1, 1), '   '));
    const disabled = editor.document.getText();
    await delay(400);
    assert.strictEqual(editor.document.getText(), disabled);
  });
  await test('disabled pending alignment and switched document remain untouched', async () => {
    const editor = await openMarked('\\begin{matrix}\n a|&b \\\\\n longer&c \\\\\n\\end{matrix}');
    await configure(true);
    await type('x');
    await configure(false);
    const disabled = editor.document.getText();
    await delay(400);
    assert.strictEqual(editor.document.getText(), disabled);
    await configure(true);
    await type('y');
    const pending = editor.document.getText();
    const other = await openMarked('other|');
    await delay(700);
    assert.strictEqual(editor.document.getText(), pending);
    assert.strictEqual(other.document.getText(), 'other');
  });
  await test('open edit close repeated documents', async () => {
    for (let i = 0; i < 20; i++) {
      const editor = await openMarked('\\begin{align}\nx|&=y\n\\end{align}');
      await type('q');
      assert.ok(editor.document.getText().includes('xq&=y'));
      await closeAll();
      await until(() => editor.document.isClosed, 'closed test document released');
    }
  });
  if (failures.length) throw new Error(failures.join('\n'));
  console.log('All extension-host integration tests passed');
}


