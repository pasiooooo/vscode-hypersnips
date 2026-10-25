import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { runInNewContext } from 'vm';
import * as latexEdit from '../src/latexEdit';
import { LatexDocumentState } from '../src/latexDocumentState';

async function check(kind: 'direct' | 'recovery', interaction: 'none' | 'typing' | 'switch') {
  const marked = '\\begin{tabular}{lc}\n a & b & c \\\\\n d|\n\\end{tabular}';
  const offset = marked.indexOf('|'), before = marked.replace('|', '');
  let text = kind === 'recovery' ? before.slice(0, offset) + '\n' + before.slice(offset) : before;
  let finish: ((success: boolean) => void) | undefined;
  let reveals = 0;
  const previous = new LatexDocumentState(before, 1);
  const current = new LatexDocumentState(text, kind === 'recovery' ? 2 : 1);
  const plan = kind === 'recovery'
    ? latexEdit.getSmartEnterRecoveryPlan(before, offset, text, {}, previous, true, '\n')
    : latexEdit.getSmartEnterPlan(text, offset, {}, current, true, '\n');
  assert.ok(plan.handled && typeof plan.cursorOffset === 'number');
  const caret = plan.cursorOffset!;
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
    document, selections: [new Selection(offset, offset)], selection: new Selection(offset, offset),
    revealRange() { reveals++; },
    async edit(callback: (builder: { replace(range: Range, value: string): void }) => void) {
      const edits: latexEdit.TextEdit[] = [];
      callback({ replace: (range, value) => edits.push({ start: range.start, end: range.end, text: value }) });
      text = latexEdit.applyTextEditsToString(text, edits);
      document.version++;
      editor.selection = new Selection(caret, caret);
      // The document change can arrive before the edit acknowledgement.
      return await new Promise<boolean>(resolve => { finish = resolve; });
    },
  };
  const vscode = { Range, Selection, EndOfLine: { LF: 1, CRLF: 2 }, window: { activeTextEditor: editor },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) } };
  const exported: any = {};
  runInNewContext(readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8') +
    '\nexports.testEnter = {smartEnter, recoverSmartEnterAfterPlainEnter};', {
    exports: exported, console, setTimeout, clearTimeout,
    require: (name: string) => {
      if (name === 'vscode') return vscode;
      if (name === './latexEdit') return latexEdit;
      if (name === './latexDocumentState') return { LatexDocumentState };
      return name.startsWith('.') ? {} : require(name);
    },
  });
  const running = kind === 'recovery'
    ? exported.testEnter.recoverSmartEnterAfterPlainEnter(editor, { rangeLength: 0, rangeOffset: offset, text: '\n' }, previous, current)
    : exported.testEnter.smartEnter(editor);
  assert.equal(typeof finish, 'function');
  if (interaction === 'typing') {
    text = text.slice(0, caret) + 'n' + text.slice(caret);
    document.version++;
    editor.selection = new Selection(caret + 1, caret + 1);
  } else if (interaction === 'switch') {
    editor.selection = new Selection(0, 0);
    vscode.window.activeTextEditor = { ...editor, document: { ...document, uri: {} } };
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
    for (const interaction of ['none', 'typing', 'switch'] as const) {
      try { await check(kind, interaction); }
      catch (error) { failures.push(error); console.error(error); }
    }
  }
  assert.equal(failures.length, 0, 'Enter selection restoration checks failed');
  console.log('Enter caret restoration: current/late edits and active-editor changes passed.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
