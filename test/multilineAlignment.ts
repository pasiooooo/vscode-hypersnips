import * as assert from 'assert';
import { getAlignmentEdits, getAutoAlignmentEdits } from '../src/latexAlignment';
import { applyTextEditsToString } from '../src/latexEdit';

for (const cell of [
  '\\(\n    \\frac{a+b}{c}\n  \\)',
  '\\[\n    \\begin{aligned}\n      x &= y \\\\\n      z &= w\n    \\end{aligned}\n  \\]',
  '\\multicolumn{2}{c}{\n  Example\n}',
  '\\begin{verbatim}\n  a & b\n\\end{verbatim}',
]) for (const eol of ['\n', '\r\n']) {
  const extra = cell.startsWith('\\multicolumn');
  const text = ('\\begin{tabular}{' + (extra ? 'lll' : 'll') + '}\n  A & B' + (extra ? ' & C' : '') + ' \\\\\n  ' + cell + ' & C \\\\\n\\end{tabular}').replace(/\n/g, eol);
  const offset = text.indexOf('\n') + 1;
  assert.deepStrictEqual(getAlignmentEdits(text, offset), [], 'multiline cell formatting stays reverted');
  assert.strictEqual(applyTextEditsToString(text, getAutoAlignmentEdits(text, offset)), text, 'keep handwritten multiline indentation');
}
for (const literal of ['\\lstinline|a  &  b|', '\\lstinline[language=TeX]|a  \\\\  b|',
  '\\mintinline{tex}|a  &  b|', '\\Verb[showspaces=true]|a  \\\\  b|']) {
  for (const gap of [' ', '\n  ']) {
    const text = '\\begin{tabular}{ll}\n  A & B \\\\\n  ' + literal + gap + '& C \\\\\n\\end{tabular}';
    const offset = text.indexOf('\n') + 1;
    assert.deepStrictEqual(getAlignmentEdits(text, offset), [], 'opaque inline code remains untouched');
    assert.deepStrictEqual(getAutoAlignmentEdits(text, offset), [], 'literal delimiters cannot create table columns');
  }
}
console.log('Multiline rollback: handwritten layout, CRLF and inline literal protection passed');
