import * as assert from 'assert';
import { getAutoAlignmentEdits, getAlignmentEdits } from '../src/latexAlignment';
import { getAlignmentColumnEdits, getAlignmentStructure } from '../src/latexColumns';
import { LatexDocumentState } from '../src/latexDocumentState';
import { applyTextEditsToString } from '../src/latexEdit';

for (const [spec, expected] of [
  ['lll', 'll'], ['@{}lll@{}', '@{}ll@{}'], ['|l|c|r|', '|l|c|'],
  ['lc>{\\bfseries}l<{}@{}', 'lc@{}'], ['llp{2cm}|', 'll|'], ['*{2}{c}l@{}', '*{2}{c}@{}'],
  ['*{3}{l}', '*{2}{l}'], ['*{2}{lr}|', '*{1}{lr}|'], ['*{2}{lc}r', '*{1}{lc}'],
  ['*{2}{*{2}{l}}', '*{1}{*{2}{l}}'],
  ['*{3}{l|}c', '*{1}{l|}l'], ['l*{3}{r|}', 'lr|'],
  ['*{2}{l@{gap}r@{edge}}c', 'l@{gap}r'],
]) {
  const text = `\\begin{tabular}{${spec}}\n  a & b & \\\\\n  c & d \\\\\n\\end{tabular}`;
  const offset = text.indexOf('c & d');
  const result = applyTextEditsToString(text, getAutoAlignmentEdits(text, offset));
  assert.strictEqual(result.split('\n')[0], `\\begin{tabular}{${expected}}`, 'delete the removed column format and preserve boundaries');
  assert.deepStrictEqual(getAutoAlignmentEdits(result, result.indexOf('c &')), []);
}
{
  const text = '\\begin{tabular}{@{}*{2}{lr}|}\n  a & b & c & \\\\\n  d & e & f \\\\\n\\end{tabular}';
  const result = applyTextEditsToString(text, getAutoAlignmentEdits(text, text.indexOf('d &')));
  assert.ok(result.startsWith('\\begin{tabular}{@{}*{1}{lr}l|}'), 'retain full repetitions and styles of the partial final group');
  assert.deepStrictEqual(getAutoAlignmentEdits(result, result.indexOf('d &')), []);
}
{
  const text = '\\begin{tabular}{lllll}\n  a\n\\end{tabular}';
  assert.strictEqual(applyTextEditsToString(text, getAutoAlignmentEdits(text, text.indexOf('\n  a') + 4)), text,
    'typing the first row must not erase the template column specification');
}
{
  const text = '\\begin{tabular}{ll}\n  a\n\\end{tabular}';
  const result = applyTextEditsToString(text, getAutoAlignmentEdits(text, text.indexOf('\n  a') + 4, {}, 4, new Map(), undefined, true));
  assert.ok(result.startsWith('\\begin{tabular}{l}'), 'an explicitly removed separator can shrink the first unfinished row');
  const commented = '\\begin{tabular}{ll% keep the comment\nl}\n  a & b & \\\\\n  c & d \\\\\n\\end{tabular}';
  const preserved = applyTextEditsToString(commented, getAutoAlignmentEdits(commented, commented.indexOf('c &')));
  assert.ok(preserved.includes('% keep the comment\nl}'), 'do not discard preamble comments');
}
for (const cell of [
  '\\lstinline!value!', '\\lstinline[language=TeX]!value&code!',
  '\\mintinline{tex}!value!', '\\Verb!value!', '\\verb!value!', '\\text{unfinished',
]) {
  const text = `\\begin{tabular}{lll}\n  a & b \\\\\n  c & d & ${cell} \\\\\n\\end{tabular}`;
  const offset = text.indexOf('a & b');
  const state = new LatexDocumentState(text);
  for (const snapshot of [undefined, state]) {
    const frame = state.contextAt(offset).currentEnvironmentFrame!;
    const structure = getAlignmentStructure(text, frame, snapshot)!;
    const result = applyTextEditsToString(text, getAutoAlignmentEdits(text, offset, {}, 4, new Map(), snapshot));
    assert.strictEqual(result.split('\n')[0], '\\begin{tabular}{lll}', `uncertain occupied cells keep their column format: ${cell}`);
    assert.deepStrictEqual(getAlignmentColumnEdits(structure, offset), [], 'uncertain occupied rows prevent column synchronization');
    assert.ok(result.includes(`c & d & ${cell}`), 'uncertain occupied cells remain intact');
  }
}
{
  const text = '\\begin{tabular}{lll}\n  a & b & c & d \\\\\n  e & f \\\\\n  g & h & \\lstinline!value! \\\\\n\\end{tabular}';
  const offset = text.indexOf('e & f');
  const state = new LatexDocumentState(text);
  const structure = getAlignmentStructure(text, state.contextAt(offset).currentEnvironmentFrame!, state)!;
  const result = applyTextEditsToString(text, getAlignmentColumnEdits(structure, offset));
  assert.strictEqual(result, text.replace('{lll}', '{llll}').replace('e & f \\\\', 'e & f & & \\\\'),
    'known occupied columns can still grow the declaration and complete safe peer rows');
  const emptyTail = '\\begin{tabular}{lll}\n  a & b & \\\\\n  c & d \\\\\n  e & f & \\lstinline!value! \\\\\n\\end{tabular}';
  const tailOffset = emptyTail.indexOf('c & d');
  const tailState = new LatexDocumentState(emptyTail);
  const tailStructure = getAlignmentStructure(emptyTail, tailState.contextAt(tailOffset).currentEnvironmentFrame!, tailState)!;
  assert.deepStrictEqual(getAlignmentColumnEdits(tailStructure, tailOffset), [],
    'uncertain rows protect peer trailing separators as well as the declaration');
}
for (const text of [
  '\\begin{dcases}\n  x&y \\\\\n\\end{dcases}',
  '\\begin{dcases}\n  x & \\text{if condition} \\\\\n  longer & \\text{otherwise} \\\\\n\\end{dcases}',
]) {
  const offset = text.includes('condition') ? text.indexOf('condition') + 2 : text.indexOf('x&') + 1;
  const result = applyTextEditsToString(text, getAlignmentEdits(text, offset));
  assert.notStrictEqual(result, text, 'dcases aligns a single row and edits inside text commands without Enter');
  assert.ok(result.includes(' & '));
  assert.strictEqual(result.replace(/[ \t]/g, ''), text.replace(/[ \t]/g, ''));
  assert.deepStrictEqual(getAlignmentEdits(result, result.indexOf('condition') >= 0 ? result.indexOf('condition') + 2 : result.indexOf('x')), []);
}
console.log('Alignment corrections: safe shrinking, uncertain occupied cells, templates and immediate dcases alignment passed');
