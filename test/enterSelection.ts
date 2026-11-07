import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { runInNewContext } from 'vm';
import * as latexEdit from '../src/latexEdit';
import { LatexDocumentState } from '../src/latexDocumentState';

async function check(kind: 'direct' | 'recovery', interaction: 'none' | 'typing' | 'switch' | 'moveMouse' | 'moveKeyboard') {
  const marked = '\\begin{tabular}{lc}\n a & b & c \\\\\n d|\n\\end{tabular}';
  const offset = marked.indexOf('|'), before = marked.replace('|', '');
  let text = kind === 'recovery' ? before.slice(0, offset) + '\n' + before.slice(offset) : before;
  let finish: ((success: boolean) => void) | undefined;
  let reveals = 0;
  let selectionChanged: ((event: { textEditor: typeof editor; selections: Selection[]; kind: number | undefined }) => void) | undefined;
  let editOptions: { undoStopBefore: boolean; undoStopAfter: boolean } | undefined;
  const afterEnter = '\\begin{tabular}{lcl}\n a & b & c \\\\\n d & & \\\\\n \n\\end{tabular}';
  const caret = afterEnter.indexOf('\n\\end{tabular}');
  const previous = new LatexDocumentState(before, 1);
  const current = new LatexDocumentState(text, kind === 'recovery' ? 2 : 1);
  class Range { constructor(public start: number, public end: number) {} }
  class Selection {
    readonly start: number;
    readonly isEmpty: boolean;
    constructor(public anchor: number, public active: number) {
      this.start = Math.min(anchor, active);
      this.isEmpty = anchor === active;
    }
  }
  const document = { version: current.version, eol: 1, uri: {}, languageId: 'latex',
    getText: () => text, offsetAt: (position: number) => position, positionAt: (position: number) => position };
  const editor = {
    document, selections: [new Selection(offset, offset)],
    get selection() { return this.selections[0]; },
    set selection(value: Selection) { this.selections = [value]; },
    revealRange() { reveals++; },
    async edit(callback: (builder: { replace(range: Range, value: string): void }) => void,
      options: { undoStopBefore: boolean; undoStopAfter: boolean }) {
      editOptions = options;
      const edits: latexEdit.TextEdit[] = [];
      callback({ replace: (range, value) => edits.push({ start: range.start, end: range.end, text: value }) });
      text = latexEdit.applyTextEditsToString(text, edits);
      document.version++;
      editor.selection = new Selection(caret, caret);
      selectionChanged!({ textEditor: editor, selections: editor.selections, kind: undefined });
      // The document change can arrive before the edit acknowledgement.
      return await new Promise<boolean>(resolve => { finish = resolve; });
    },
  };
  const register = () => ({});
  const vscode = { Range, Selection, Disposable: class { constructor(_dispose: () => void) {} },
    EndOfLine: { LF: 1, CRLF: 2 },
    window: { activeTextEditor: editor, onDidChangeVisibleTextEditors: register, onDidChangeActiveTextEditor: register,
      onDidChangeTextEditorSelection(listener: typeof selectionChanged) { selectionChanged = listener; return {}; } },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      onDidSaveTextDocument: register, onDidChangeTextDocument: register, onDidCloseTextDocument: register,
      onDidChangeConfiguration: register },
    commands: { registerCommand: register, registerTextEditorCommand: register, executeCommand: async () => {} },
    languages: { registerCompletionItemProvider: register } };
  const exported: any = {};
  runInNewContext(readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8') +
    '\nloadSnippets = () => Promise.resolve(); exports.testEnter = {smartEnter, recoverSmartEnterAfterPlainEnter};', {
    exports: exported, console, setTimeout, clearTimeout,
    require: (name: string) => {
      if (name === 'vscode') return vscode;
      if (name === './latexEdit') return latexEdit;
      if (name === './latexDocumentState') return { LatexDocumentState };
      if (name === './snippetManager') return { registerSnippetManager() {} };
      return name.startsWith('.') ? {} : require(name);
    },
  });
  exported.activate({ subscriptions: [] });
  assert.equal(typeof selectionChanged, 'function');
  const running = kind === 'recovery'
    ? exported.testEnter.recoverSmartEnterAfterPlainEnter(editor, { rangeLength: 0, rangeOffset: offset, text: '\n' }, previous, current)
    : exported.testEnter.smartEnter(editor);
  assert.equal(typeof finish, 'function');
  assert.equal(text, afterEnter);
  assert.strictEqual(editOptions?.undoStopBefore, kind === 'direct', 'direct Enter starts an undo step; recovery joins native Enter');
  assert.strictEqual(editOptions?.undoStopAfter, false, 'Enter leaves its undo step open for pending alignment');
  if (interaction === 'typing') {
    text = text.slice(0, caret) + 'n' + text.slice(caret);
    document.version++;
    editor.selection = new Selection(caret + 1, caret + 1);
  } else if (interaction === 'switch') {
    editor.selection = new Selection(0, 0);
    vscode.window.activeTextEditor = { ...editor, document: { ...document, uri: {} } };
  } else if (interaction === 'moveMouse' || interaction === 'moveKeyboard') {
    editor.selection = new Selection(0, 0);
    selectionChanged!({ textEditor: editor, selections: editor.selections, kind: interaction === 'moveMouse' ? 2 : 1 });
  }
  const expectedCaret = editor.selection.active, expectedText = text;
  finish!(true);
  await running;
  assert.equal(text, expectedText);
  assert.equal(editor.selection.active, expectedCaret, `${kind}/${interaction}: late completion must preserve the newer selection`);
  assert.equal(reveals, interaction === 'none' ? 1 : 0, `${kind}/${interaction}: stale completion must not reveal an editor`);
}

async function main() {
  const failures: unknown[] = [];
  for (const kind of ['direct', 'recovery'] as const) {
    for (const interaction of ['none', 'typing', 'switch', 'moveMouse', 'moveKeyboard'] as const) {
      try { await check(kind, interaction); }
      catch (error) { failures.push(error); console.error(error); }
    }
  }
  assert.equal(failures.length, 0, 'Enter selection restoration checks failed');
  console.log('Enter caret restoration: current/late edits, own notifications, mouse/keyboard moves and undo options passed.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
