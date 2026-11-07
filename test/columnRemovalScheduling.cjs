const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const compiled = path.resolve(__dirname, '../tmp/test-out/src');
const alignment = require(path.join(compiled, 'latexAlignment'));
const edit = require(path.join(compiled, 'latexEdit'));
const columns = require(path.join(compiled, 'latexColumns'));
const { LatexDocumentState } = require(path.join(compiled, 'latexDocumentState'));

async function check(initial, actions, enter = false) {
  let text = initial, timer;
  class Range { constructor(start, end) { this.start = start; this.end = end; } }
  class Selection {
    constructor(anchor, active) { this.anchor = anchor; this.active = active; this.isEmpty = anchor === active; }
    get start() { return this.active; }
  }
  const document = { version: 1, eol: 1, uri: {}, languageId: 'latex', getText: () => text,
    offsetAt: value => value, positionAt: value => value };
  const editor = { document, options: { tabSize: 4 }, selections: [new Selection(0, 0)],
    get selection() { return this.selections[0]; }, set selection(value) { this.selections = [value]; }, revealRange() {},
    async edit(callback) {
      const previous = new LatexDocumentState(text, document.version);
      const edits = [];
      callback({ replace(range, value) { edits.push({ start: range.start, end: range.end, text: value }); } });
      const ordered = [...edits].sort((a, b) => a.start - b.start);
      for (let i = 1; i < ordered.length; i++) assert.ok(ordered[i - 1].end <= ordered[i].start);
      text = edit.applyTextEditsToString(text, edits);
      document.version++;
      exported.checkRemoval.scheduleAlignment(editor, { document, contentChanges: edits.map(value => ({
        rangeOffset: value.start, rangeLength: value.end - value.start, text: value.text,
      })) }, previous);
      return true;
    } };
  const vscode = { Range, Selection, EndOfLine: { CRLF: 2 }, env: {}, window: { activeTextEditor: editor },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
  const exported = {};
  vm.runInNewContext(fs.readFileSync(path.join(compiled, 'extension.js'), 'utf8') +
    '\nexports.checkRemoval = {scheduleAlignment, smartEnter, pendingCount: doc => pendingColumnRemovals.get(doc)?.tokens.size || 0};', {
    exports: exported, console,
    setTimeout: callback => { timer = callback; return 1; }, clearTimeout: () => { timer = undefined; },
    require: name => {
      if (name === 'vscode') return vscode;
      if (name === './latexAlignment') return alignment;
      if (name === './latexColumns') return columns;
      if (name === './latexEdit') return edit;
      if (name === './latexDocumentState') return { LatexDocumentState };
      if (name === './fontMetrics') return { getFontCharacterWidths: async () => new Map() };
      return {};
    },
  });
  for (const action of actions) {
    if (action === 'flush') { await timer?.(); continue; }
    const previous = new LatexDocumentState(text, document.version);
    const changes = action(text);
    text = edit.applyTextEditsToString(text, changes.map(change => ({
      start: change.rangeOffset, end: change.rangeOffset + change.rangeLength, text: change.text,
    })));
    document.version++;
    editor.selection = new Selection(changes[0].rangeOffset + changes[0].text.length, changes[0].rangeOffset + changes[0].text.length);
    exported.checkRemoval.scheduleAlignment(editor, { document, contentChanges: changes }, previous);
  }
  if (enter) await exported.checkRemoval.smartEnter(editor);
  await timer?.();
  assert.strictEqual(exported.checkRemoval.pendingCount(document), 0, 'resolved deletion intent must be released');
  return text;
}
void (async () => {
  const initial = '\\begin{tabular}{ll}\n  a &\n\\end{tabular}';
  const remove = text => [{ rangeOffset: text.indexOf('&'), rangeLength: 1, text: '' }];
  const type = text => [{ rangeOffset: text.indexOf('a ') + 1, rangeLength: 0, text: 'x' }];
  for (const enter of [false, true]) {
    const result = await check(initial, [remove, type], enter);
    assert.ok(result.startsWith('\\begin{tabular}{l}'), 'deletion intent survives typing and Enter before debounce');
    assert.ok(!result.includes('&'));
  }
  const other = initial + '\n\\begin{tabular}{lllll}\n  b\n\\end{tabular}';
  const result = await check(other, [remove,
    text => [{ rangeOffset: text.lastIndexOf('\n  b') + 4, rangeLength: 0, text: 'x' }]]);
  assert.ok(result.startsWith('\\begin{tabular}{l}'));
  assert.ok(result.includes('\\begin{tabular}{lllll}'), 'an unrelated new table retains its template');
  const moved = await check(initial, [remove,
    () => [{ rangeOffset: 0, rangeLength: 0, text: '% prefix\n' }], type]);
  assert.ok(moved.includes('\\begin{tabular}{l}'), 'pending environment anchors follow preceding edits');
  const incomplete = await check(initial, [remove,
    text => [{ rangeOffset: text.indexOf('a ') + 1, rangeLength: 0, text: '\\text{' }], 'flush',
    text => [{ rangeOffset: text.indexOf('\\text{') + 6, rangeLength: 0, text: 'x}' }]]);
  assert.ok(incomplete.startsWith('\\begin{tabular}{l}'), 'incomplete syntax cannot discard deletion intent');
  const peer = '\\begin{tabular}{ll}\n  a & \\\\\n  b &\n\\end{tabular}';
  const shrunk = await check(peer, [text => [{ rangeOffset: text.lastIndexOf('&'), rangeLength: 1, text: '' }]]);
  assert.ok(shrunk.startsWith('\\begin{tabular}{l}'));
  for (const body of ['a \\&', 'a \\text{x&}', 'a % &']) {
    const preserved = await check('\\begin{tabular}{ll}\n  ' + body + '\n\\end{tabular}', [remove]);
    assert.ok(preserved.startsWith('\\begin{tabular}{ll}'), 'non-separator ampersands cannot authorize template shrinking');
  }
  console.log('Column deletion scheduling: debounce, immediate Enter, scope, anchors and false triggers passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
