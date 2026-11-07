import * as assert from 'assert';
import { getAlignmentEdits, getAutoAlignmentEdits, mapAlignmentOffset } from '../src/latexAlignment';
import { getAlignmentColumnEdits, getAlignmentStructure } from '../src/latexColumns';
import { applyTextEditsToString, getSmartEnterPlan, getSmartTabPlan } from '../src/latexEdit';
import { getLatexContext } from '../src/latexContext';
import { LatexDocumentState } from '../src/latexDocumentState';

function synchronize(text: string) {
  const offset = text.indexOf('\n') + 1;
  const state = new LatexDocumentState(text);
  const edits = getAutoAlignmentEdits(text, offset, {}, 4, new Map(), state);
  assert.deepStrictEqual(edits, getAutoAlignmentEdits(text, offset));
  for (let i = 1; i < edits.length; i++) assert.ok(edits[i - 1].end <= edits[i].start, 'edits must not overlap');
  const result = applyTextEditsToString(text, edits);
  assert.deepStrictEqual(getAutoAlignmentEdits(result, result.indexOf('\n') + 1), [], 'live synchronization is stable');
  return result;
}

for (const [source, expected] of [
  ['a & b & \\\\\nc & d| \\\\', 'a&b\\\\\nc&d\\\\'],
  ['a & b & value \\\\\nc & d| \\\\', 'a&b&value\\\\\nc&d&\\\\'],
  ['a & & value & \\\\\nc & d &| \\\\', 'a&&value\\\\\nc&d&\\\\'],
  ['a & b \\\\\nc & d &| \\\\', 'a&b&\\\\\nc&d&\\\\'],
  [' & & \\\\\n| \\\\', '\\\\\n\\\\'],
  [' & & \\\\\n\\midrule\n| \\\\', '\\\\\n\\midrule\n\\\\'],
  ['a & \\text{b & c} & \\\\\nd & e| \\\\', 'a&\\text{b&c}\\\\\nd&e\\\\'],
  ['a & b\\&c & \\\\\nd & e| \\\\', 'a&b\\&c\\\\\nd&e\\\\'],
  ['a & $b & c$ & \\\\\nd & e| \\\\', 'a&$b&c$\\\\\nd&e\\\\'],
  ['\\multicolumn{3}{c}{value} & \\\\\nc & d| \\\\', '\\multicolumn{3}{c}{value}\\\\\nc&d&\\\\'],
  ['a & \\[\nx+y\n\\] & \\\\\nc & d| \\\\', 'a&\\[\nx+y\n\\]\\\\\nc&d\\\\'],
  ['a & b & \\\\ % & ignored\nc & d| \\\\', 'a&b\\\\%&ignored\nc&d\\\\'],
  ['a & b & \\\\\nc & d| \\label{eq:demo} \\\\', 'a&b\\\\\nc&d\\label{eq:demo}\\\\'],
] as const) {
  const marked = '\\begin{tabular}{lll}\n' + source + '\n\\end{tabular}';
  const offset = marked.indexOf('|'), text = marked.replace('|', '');
  const edits = getAutoAlignmentEdits(text, offset, {}, 4, new Map(), new LatexDocumentState(text));
  for (let i = 1; i < edits.length; i++) assert.ok(edits[i - 1].end <= edits[i].start);
  const result = applyTextEditsToString(text, edits);
  assert.strictEqual(result.split('\n').slice(1, -1).join('\n').replace(/[ \t]/g, ''), expected,
    'active-row empty columns follow the edit without removing occupied columns');
  const mapped = mapAlignmentOffset(offset, edits);
  assert.deepStrictEqual(getAutoAlignmentEdits(result, mapped), [], 'shrinking and growing are stable');
}

for (const peer of ['a', '']) {
  const text = '\\begin{tabular}{lll}\n  ' + peer + ' \\\\\n  b\n\\end{tabular}';
  const offset = text.indexOf('\n  b') + 4;
  const enter = getSmartEnterPlan(text, offset, {}, new LatexDocumentState(text), true);
  assert.ok(enter.handled);
  assert.ok(!applyTextEditsToString(text, enter.edits).includes('&'), 'Enter keeps an existing one-column table');
}
{
  const caption = '\\begin{longtable}{ll}\n\\caption{Demo}\n\\\\\n a & b \\\\\n c & d & \\\\\n\\end{longtable}';
  const changed = applyTextEditsToString(caption, getAutoAlignmentEdits(caption, caption.indexOf('a &')));
  assert.match(changed, /\\caption\{Demo\}\n[ \t]*\\\\/, 'caption-only rows never receive extra columns');
}

for (const eol of ['\n', '\r\n']) {
  const source = '\\begin{tabular}{@{}lc@{}}\n  a & b & c \\\\\n  d & e \\\\\n\\end{tabular}'.replace(/\n/g, eol);
  const expected = '\\begin{tabular}{@{}lcl@{}}\n  a & b & c \\\\\n  d & e &   \\\\\n\\end{tabular}'.replace(/\n/g, eol);
  assert.strictEqual(synchronize(source), expected);
  const controlSpace = String.raw`\begin{tabular}{lll}
  X & Y & Z \\
  a\  \\
\end{tabular}`.replace(/\n/g, eol);
  const controlResult = synchronize(controlSpace);
  assert.strictEqual((controlResult.match(/&/g) || []).length, 4);
  assert.ok(controlResult.includes(String.raw`a\ &`), 'preserve the TeX control-space while adding columns');
}
const multiline = String.raw`\begin{tabular}{lc}
  A & B & C \\
  \[
    \begin{aligned}
      x &= y \\
      z &= w
    \end{aligned}
  \]
  & d \\
  \bottomrule
\end{tabular}`;
assert.strictEqual(synchronize(multiline), multiline.replace('{lc}', '{lcl}').replace('& d ', '& d & '));
const verbatimCell = '\\begin{tabular}{ll}\n  a & b \\\\\n  \\verb!literal!\n  & c \\\\\n\\end{tabular}';
assert.strictEqual(synchronize(verbatimCell), verbatimCell, 'an uncertain multiline cell is preserved as a whole');
const unfinished = '\\begin{tabular}{lll}\n  A & B & C \\\\\n  \\[\n    x\n  \\]\n\\end{tabular}';
assert.strictEqual(synchronize(unfinished), unfinished, 'do not fill a row while its multiline cells are still being written');
for (const body of ['\\[\nx\n\\]|', '\\[\nx\n\\]|\n& y & z \\\\', 'x &\ny|\n& z \\\\', '\\[\nx\n\\]\n&\n2|']) {
  const marked = '\\begin{tabular}{lll}\n' + body + '\n\\end{tabular}';
  const offset = marked.indexOf('|'), text = marked.replace('|', '');
  assert.strictEqual(getSmartEnterPlan(text, offset, {}, new LatexDocumentState(text), true).handled, false,
    'continuing a multiline cell uses a plain newline');
}

for (const [body, allowed] of [
  ['\\[\nx|\n\\] & y \\\\', false],
  ['$x|$ & y \\\\', false],
  ['$$x|$$ & y \\\\', false],
  ['\\(x|\\) & y \\\\', false],
  ['\\begin{equation}x|\\end{equation} & y \\\\', false],
  ['\\[\\begin{matrix}x|&y\\end{matrix}\\] & z \\\\', true],
  ['\\[x\\] |& y \\\\', true],
] as const) {
  const marked = '\\begin{tabular}{ll}\n' + body + '\n\\end{tabular}';
  const offset = marked.indexOf('|'), text = marked.replace('|', '');
  const state = new LatexDocumentState(text);
  assert.strictEqual(state.contextAt(offset).canSmartTab, allowed, body);
  assert.deepStrictEqual(state.contextAt(offset), getLatexContext(text, offset), body);
  assert.strictEqual(Boolean(getSmartTabPlan(text, offset, {}, state)), allowed, body);
  if (!allowed) assert.strictEqual(getSmartEnterPlan(text, offset, {}, state, true).handled, false, body);
}

// A sequential application is an independent check of the original-coordinate edit composition.
let seed = 713;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
for (let attempt = 0; attempt < 120; attempt++) {
  const rows = Array.from({ length: 2 + Math.floor(random() * 5) }, (_, row) => '  ' +
    Array.from({ length: 1 + Math.floor(random() * 8) }, (_, col) =>
      col && random() < 0.6 ? '' : `r${row}c${col}`).join(' & ') + ' \\\\ % note');
  const text = '\\begin{tabular}{|lc|}\n' + rows.join('\n') + '\n\\end{tabular}';
  const offset = text.indexOf(`r${attempt % rows.length}c0`);
  const state = new LatexDocumentState(text);
  const structure = getAlignmentStructure(text, state.contextAt(offset).currentEnvironmentFrame!, state)!;
  const columns = getAlignmentColumnEdits(structure, offset);
  const expanded = applyTextEditsToString(text, columns);
  const widths = new Map([['r', 1.3], ['0', 0.7]]);
  const expected = applyTextEditsToString(expanded, getAlignmentEdits(expanded, mapAlignmentOffset(offset, columns), {}, 4, widths));
  const edits = getAutoAlignmentEdits(text, offset, {}, 4, widths, state);
  const actual = applyTextEditsToString(text, edits);
  assert.strictEqual(actual, expected, `composed edits ${attempt}`);
  for (const match of text.matchAll(/r\dc\d/g)) {
    const caret = mapAlignmentOffset(match.index! + match[0].length, edits);
    assert.strictEqual(actual.slice(caret - match[0].length, caret), match[0], 'content caret stays beside its text');
  }
}
console.log('Live columns: declarations, multiline cells, math scope, edit composition and caret preservation passed');
