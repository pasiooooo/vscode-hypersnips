import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { runInNewContext } from 'vm';
import * as latexEdit from '../src/latexEdit';
import * as latexAlignment from '../src/latexAlignment';
import { LatexDocumentState } from '../src/latexDocumentState';

async function check(navigate: boolean) {
  let text = '\\begin{matrix}\n  ax&b \\\\\n  longer&c \\\\\n\\end{matrix}';
  const offset = text.indexOf('ax') + 2;
  let timer: (() => Promise<void>) | undefined, finish: ((value: boolean) => void) | undefined;
  class Range { constructor(public start: number, public end: number) {} }
  class Selection {
    readonly isEmpty = true;
    constructor(public anchor: number, public active: number) {}
    get start() { return this.active; }
    get end() { return this.active; }
  }
  const document = { version: 1, uri: {}, languageId: 'latex', getText: () => text,
    offsetAt: (value: number) => value, positionAt: (value: number) => value };
  const editor = {
    document, options: { tabSize: 4 }, selections: [new Selection(offset, offset)],
    get selection() { return this.selections[0]; },
    set selection(value: Selection) { this.selections = [value]; },
    revealRange() {},
    async edit(callback: (builder: { replace(range: Range, value: string): void }) => void) {
      const edits: latexEdit.TextEdit[] = [];
      callback({ replace: (range, value) => edits.push({ start: range.start, end: range.end, text: value }) });
      text = latexEdit.applyTextEditsToString(text, edits);
      document.version++;
      // Model native right affinity when spaces are inserted exactly at the caret.
      editor.selection = new Selection(text.indexOf('&'), text.indexOf('&'));
      return await new Promise<boolean>(resolve => { finish = resolve; });
    },
  };
  const vscode = { Range, Selection, env: {}, window: { activeTextEditor: editor },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) } };
  const exported: any = {};
  runInNewContext(readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8') +
    '\nexports.selectionTest = {scheduleAlignment, smartTab};', {
    exports: exported, console, setTimeout: (callback: typeof timer) => { timer = callback; return 1; }, clearTimeout() {},
    require: (name: string) => {
      if (name === 'vscode') return vscode;
      if (name === './latexEdit') return latexEdit;
      if (name === './latexAlignment') return latexAlignment;
      if (name === './latexDocumentState') return { LatexDocumentState };
      if (name === './fontMetrics') return { getFontCharacterWidths: async () => new Map() };
      return {};
    },
  });
  exported.selectionTest.scheduleAlignment(editor, { document,
    contentChanges: [{ rangeOffset: offset - 1, rangeLength: 0, text: 'x' }] });
  const running = timer!();
  for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
  assert.equal(typeof finish, 'function');
  if (navigate) await exported.selectionTest.smartTab(editor);
  const expected = navigate ? text.indexOf('& b') + 2 : offset;
  if (navigate) assert.equal(editor.selection.active, expected);
  else assert.notEqual(editor.selection.active, expected, 'the ordinary control must actually require caret correction');
  finish!(true);
  await running;
  assert.equal(editor.selection.active, expected, 'late alignment acknowledgement must not undo Tab navigation');
}
void (async () => {
  await check(false);
  await check(true);
  console.log('Alignment caret restoration: ordinary edits and Tab during delayed acknowledgement passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
