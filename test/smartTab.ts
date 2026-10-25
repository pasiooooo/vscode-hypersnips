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
  ['a {\n x| & y} & z', 'a {\n x & y} & |z'],
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
];
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
for (const marked of [
  'plain| & text',
  '\\begin{matrix}\na % | & comment\n\\end{matrix}',
  '\\begin{matrix}\n\\text{a| & b}\n\\end{matrix}',
  '\\begin{matrix}\n\\verb!a|&b!\n\\end{matrix}',
  '```latex\n\\begin{matrix}\na| & b\n\\end{matrix}\n```',
  '\\begin{verbatim}\n\\begin{matrix}\na| & b\n\\end{matrix}\n\\end{verbatim}',
]) {
  assert.strictEqual(getSmartTabPlan(marked.replace('|', ''), marked.indexOf('|')), undefined, marked);
}
console.log('Smart Tab navigation, row endings, protected separators and caret plans passed');
