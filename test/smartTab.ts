import * as assert from 'assert';
import { applyTextEditsToString, getSmartTabPlan } from '../src/latexEdit';
import { LatexDocumentState } from '../src/latexDocumentState';

const cases = [
  ['al|pha & beta & gamma \\\\', 'alpha & |beta & gamma \\\\'],
  ['a| &&c', 'a & |&c'],
  ['a & |& c', 'a & & |c'],
  ['a| &\tb', 'a & |b'],
  ['a|\\&b & c', 'a\\&b & |c'],
  ['a| {b&c} & d', 'a {b&c} & |d'],
  ['a| \\[x&y\\] & z', 'a \\[x&y\\] & |z'],
  ['a| $x&y$ & z', 'a $x&y$ & |z'],
  ['a {\n x| & y} & z', 'a {\n x & y} & |z'],
  ['a|\n  & b \\\\', 'a\n  & |b \\\\'],
  ['a|\n  &\n  b \\\\', 'a\n  & |\n  b \\\\'],
  ['a| \\verb!b&c! & d', 'a \\verb!b&c! & |d'],
  ['a| \\begin{matrix}b&c\\end{matrix} & d', 'a \\begin{matrix}b&c\\end{matrix} & |d'],
  ['a| \\\\', 'a & |\\\\'],
  ['a \\\\|', 'a & |\\\\'],
  ['a| \\\\*[2pt] % keep', 'a & |\\\\*[2pt] % keep'],
  ['a \\\\[2pt]| % keep', 'a & |\\\\[2pt] % keep'],
  ['a| \\tabularnewline', 'a & |\\tabularnewline'],
  ['a \\tabularnewline|', 'a & |\\tabularnewline'],
  ['a & b| % & keep', 'a & b & |% & keep'],
  ['a \\\\ b| & c', 'a \\\\ b & |c'],
  ['a| \\\\\nb & c \\\\', 'a & |\\\\\nb & c \\\\'],
  ['a|b', 'a & |b'],
  ['  |', '   & |'],
  ['A & |\\Verb{x{y{z}&q}r} & s \\\\', 'A & \\Verb{x{y{z}&q}r} & |s \\\\'],
  ['A & \\Verb{x{y{z}&q}r} |& s \\\\', 'A & \\Verb{x{y{z}&q}r} & |s \\\\'],
  ['A & |\\verb{x{ & s \\\\', 'A & \\verb{x{ & |s \\\\'],
];
const literals = [
  '\\lstinline!x&y!', '\\lstinline*[language=TeX]!x&y!', '\\lstinline!x&y\\\\z!',
  '\\mintinline{tex}!x&y!', '\\mintinline[breaklines]{tex}{x&y}',
  '\\mintinline{tex}{x&y{nested}}', '\\Verb!x&y!', '\\Verb[showspaces=true]!x&y!',
];
for (const literal of literals) {
  cases.push([`A & |${literal} \\\\`, `A & & |${literal} \\\\`]);
  cases.push([`A & |${literal} & z \\\\`, `A & ${literal} & |z \\\\`]);
  cases.push([`A & ${literal} |& z \\\\`, `A & ${literal} & |z \\\\`]);
}
for (const [body, expected] of cases) {
  for (const eol of ['\n', '\r\n']) {
    const marked = ('\\begin{tabular}{lll}\n' + body + '\n\\end{tabular}').replace(/\n/g, eol);
    const offset = marked.indexOf('|'), text = marked.replace('|', '');
    const plan = getSmartTabPlan(text, offset);
    assert.ok(plan, body);
    assert.deepStrictEqual(getSmartTabPlan(text, offset, {}, new LatexDocumentState(text)), plan);
    const result = applyTextEditsToString(text, plan!.edits);
    const withCaret = result.slice(0, plan!.cursorOffset) + '|' + result.slice(plan!.cursorOffset);
    assert.strictEqual(withCaret, ('\\begin{tabular}{lll}\n' + expected + '\n\\end{tabular}').replace(/\n/g, eol), body);
  }
}
for (const source of [
  'plain| & text',
  '\\begin{matrix}\na % | & comment\n\\end{matrix}',
  '\\begin{matrix}\n\\text{a| & b}\n\\end{matrix}',
  '\\begin{tabular}{ll}\n\\[\n  \\frac{1}{2}|\n\\] & x \\\\\n\\end{tabular}',
  '\\begin{tabular}{ll}\n$x|$ & y \\\\\n\\end{tabular}',
  '\\begin{tabular}{ll}\n\\begin{equation}x|\\end{equation} & y \\\\\n\\end{tabular}',
  '\\begin{matrix}\n\\verb!a|&b!\n\\end{matrix}',
  '```latex\n\\begin{matrix}\na| & b\n\\end{matrix}\n```',
  '\\begin{verbatim}\n\\begin{matrix}\na| & b\n\\end{matrix}\n\\end{verbatim}',
  ...literals.map(literal => `\\begin{tabular}{lll}\nA & ${literal.replace('x&y', 'x|&y')} & z \\\\\n\\end{tabular}`),
  '\\begin{tabular}{lll}\nA & |\\lstinline!x&y & z \\\\\n\\end{tabular}',
  '\\begin{tabular}{lll}\nA & |\\lstinline[language=TeX!x&y! & z \\\\\n\\end{tabular}',
  '\\begin{tabular}{lll}\nA & |\\mintinline{tex!x&y! & z \\\\\n\\end{tabular}',
  '\\begin{tabular}{lll}\nA & |\\lstinline[escapeinside={a}{b}]!x&y! & z \\\\\n\\end{tabular}',
  '\\begin{tabular}{lll}\nA & |\\mintinline[escapeinside={a}{b}]{tex}!x&y! & z \\\\\n\\end{tabular}',
  '\\begin{tabular}{lll}\nA & \\Verb{x{y{z}|&q}r} & s \\\\\n\\end{tabular}',
  '\\begin{tabular}{lll}\nA & |\\Verb{x{y{z}&q}r & s \\\\\n\\end{tabular}',
]) {
  for (const eol of ['\n', '\r\n']) {
    const marked = source.replace(/\n/g, eol), text = marked.replace('|', ''), offset = marked.indexOf('|');
    for (const snapshot of [undefined, new LatexDocumentState(text)]) {
      assert.strictEqual(getSmartTabPlan(text, offset, {}, snapshot), undefined, marked);
    }
  }
}
console.log('Smart Tab navigation, row endings, protected separators and caret plans passed');
