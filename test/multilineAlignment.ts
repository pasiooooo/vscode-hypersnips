import * as assert from 'assert';
import { getAlignmentEdits, getAutoAlignmentEdits, mapAlignmentOffset } from '../src/latexAlignment';
import { applyTextEditsToString } from '../src/latexEdit';
import { LatexDocumentState } from '../src/latexDocumentState';

const fixtures = [
  [String.raw`\begin{tabular}{lll}
  Item & Value & Note \\
  A & \(
    \frac{a+b}{c}
  \) & Demo \\
\end{tabular}`, String.raw`\begin{tabular}{lll}
  Item & Value           & Note \\
  A    & \(
           \frac{a+b}{c}
         \)              & Demo \\
\end{tabular}`],
  [String.raw`\begin{tabular}{lll}
  Item & Expression & Note \\
  A & \(
    x+y
  \) & plain \\
  \(
    a+b
  \) & 7 & \(
    c-d
  \) \\
\end{tabular}`, String.raw`\begin{tabular}{lll}
  Item  & Expression & Note  \\
  A     & \(
            x+y
          \)         & plain \\
  \(
    a+b
  \)    & 7          & \(
                         c-d
                       \)    \\
\end{tabular}`],
  [String.raw`\begin{tabular}{lll}
  \(
    a+b
  \)
  & \(
    c+d
  \)
  & \(
    e+f
  \) \\
\end{tabular}`, String.raw`\begin{tabular}{lll}
  \(
    a+b
  \)
        & \(
            c+d
          \)
                & \(
                    e+f
                  \)    \\
\end{tabular}`],
];

for (const [before, after] of fixtures) for (const eol of ['\n', '\r\n']) {
  const text = before.replace(/\n/g, eol), expected = after.replace(/\n/g, eol);
  const offset = text.indexOf('\n') + 1;
  for (const snapshot of [undefined, new LatexDocumentState(text)]) {
    const edits = getAlignmentEdits(text, offset, {}, 4, new Map(), snapshot);
    for (let index = 1; index < edits.length; index++) assert.ok(edits[index - 1].end <= edits[index].start);
    const result = applyTextEditsToString(text, edits);
    assert.strictEqual(result, expected);
    assert.strictEqual(result.replace(/[ \t]/g, ''), text.replace(/[ \t]/g, ''), 'preserve content and line breaks');
    assert.deepStrictEqual(getAlignmentEdits(result, result.indexOf('\n') + 1), [], 'multiline layout is stable');
    assert.strictEqual(applyTextEditsToString(text, getAutoAlignmentEdits(text, offset)), expected);
    for (const match of text.matchAll(/[A-Za-z]+/g)) {
      const caret = mapAlignmentOffset(match.index! + match[0].length, edits);
      assert.strictEqual(result.slice(caret - match[0].length, caret), match[0], 'caret stays beside its token');
    }
  }
}

for (const body of [
  '  Key & Value \\\\\n  \\(\n    x\t+y\n\n  \\) & Demo \\\\ % exact   row  ',
  '  Key & Value \\\\\n  A & \\(\n    x % exact   cell  \n    y\n  \\) \\tabularnewline[2pt] % note',
  '  Key & Value \\\\\n  A & \\(\n    \\begin{aligned}\n      x &= y \\\\\n      z &= w\n    \\end{aligned}\n  \\) \\\\',
  '  名称 & e\u0301 \\\\\n  甲 & \\(\n    x\t+中文\n  \\) \\\\',
  '  a+b & c \\\\\n  longer+r & d \\\\\n  \\(\n    x\n  \\) & y \\\\',
]) for (const tabSize of [4, 8]) for (const widths of [new Map<string, number>(),
  new Map([['甲', 2.3], ['中', 2.1], ['文', 2.1], ['e', 0.8], ['&', 1.2], ['x', 0.9], ['\u0301', 0]])]) {
  const text = '\\begin{tabular}{ll}\n' + body + '\n\\end{tabular}';
  const offset = text.indexOf('\n') + 1;
  const edits = getAlignmentEdits(text, offset, {}, tabSize, widths);
  for (let i = 1; i < edits.length; i++) assert.ok(edits[i - 1].end <= edits[i].start);
  const result = applyTextEditsToString(text, edits);
  assert.strictEqual(result.replace(/[ \t]/g, ''), text.replace(/[ \t]/g, ''));
  assert.deepStrictEqual(getAlignmentEdits(result, result.indexOf('\n') + 1, {}, tabSize, widths), [], body);
  assert.deepStrictEqual(result.match(/%[^\r\n]*/g), text.match(/%[^\r\n]*/g), 'comment text and trailing spaces stay exact');
}
for (const cell of [
  '\\multicolumn{2}{c}{\n  Example\n}',
  '\\verb|a&b|\n  more',
  '\\begin{verbatim}\n  a & b\n\\end{verbatim}',
]) {
  const text = '\\begin{tabular}{ll}\n  A & B \\\\\n  ' + cell + ' \\\\\n\\end{tabular}';
  assert.deepStrictEqual(getAlignmentEdits(text, text.indexOf('\n') + 1), [], 'opaque multiline rows remain untouched');
}
{
  const text = '\\begin{tabular}{lll}\n  \\(\n    x\ta\n  \\) & xx & \\(\n    a\n  \\) \\\\\n  \\(\n    a\n  \\) & a & a\tx \\\\\n\\end{tabular}';
  const widths = new Map([['x', 0.7], ['&', 1.5], ['a', 0.1]]);
  const result = applyTextEditsToString(text, getAlignmentEdits(text, text.indexOf('\n') + 1, {}, 2, widths));
  assert.deepStrictEqual(getAlignmentEdits(result, result.indexOf('\n') + 1, {}, 2, widths), [], 'fractional widths and Tabs must not drift');
}
{
  const text = '\\begin{tabular}{ll}\n  Key & Value \\\\\n  A & \\(\n\t\tx\n\t\\) \\\\\n\\end{tabular}';
  const result = applyTextEditsToString(text, getAlignmentEdits(text, text.indexOf('\n') + 1));
  assert.ok(result.includes('\tx'), 'retain the relative indentation Tab after dedenting the shared outer Tab');
  assert.deepStrictEqual(getAlignmentEdits(result, result.indexOf('\n') + 1), []);
}
{
  const text = '\\begin{aligned}\n  a & {b\n    c} \\\\\n  longer & d \\\\\n\\end{aligned}';
  const edits = getAlignmentEdits(text, text.indexOf('\n') + 1);
  assert.ok(edits.length, 'aligned without an option must include its first multiline row');
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
console.log('Multiline alignment: approved layouts, EOL, snapshots, content and caret mapping passed');
