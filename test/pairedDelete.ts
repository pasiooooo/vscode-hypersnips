import * as assert from 'assert';
import { createEnvironmentNameSyncPlan, EnvironmentNameLink } from '../src/environmentConvert';
import { applyTextEditsToString } from '../src/latexEdit';
import { CommandArguments, findLatexBoundaryPair, getPairedDeletePlan, PairedDeleteProgress } from '../src/latexPairDelete';

const pairs: [string, 'left' | 'right', string][] = [
  ['pre (|a[b]) post', 'left', 'pre a[b] post'],
  ['{{|x}}', 'left', '{x}'],
  ['{|}', 'right', ''],
  ['(x)|[y]', 'left', 'x[y]'],
  ['(x)|[y]', 'right', '(x)y'],
  ['(left (middle)| right)', 'left', '(left middle right)'],
  ['x|\\[\r\n  😀 + b % \\]\r\n\\]y', 'right', 'x\r\n  😀 + b % \\]\r\ny'],
  ['\\(x|\\)', 'right', 'x'],
  ['$$|x$$', 'left', 'x'],
  ['a$x$|b', 'left', 'axb'],
  ['\\{x\\}|', 'left', 'x'],
  ['\\begin{itemize}\\item x|\\end{itemize}', 'right', '\\item x'],
  ['\\begin{tabular}|[t]{ll}\r\na & b \\\\\r\n\\end{tabular}', 'left', '\r\na & b \\\\\r\n'],
  ['\\begin{a}x\\begin{a}y\\end{a}|z\\end{a}', 'left', '\\begin{a}xyz\\end{a}'],
  ['{|a % }\nb}', 'left', 'a % }\nb'],
  ['{|\\verb!%!} unrelated }', 'left', '\\verb!%! unrelated }'],
  ['\\begin{a}| \\verb!\\end{a}! \\end{a}', 'left', ' \\verb!\\end{a}! '],
  ['(\\left(x\\right))|', 'left', '\\left(x\\right)'],
  ['{|literal ) text} (x)', 'left', 'literal ) text (x)'],
  ['\\textit{test}|', 'left', 'test'],
  ['\\boxed{x}|', 'left', 'x'],
  ['\\section*|{Title}', 'right', 'Title'],
  ['\\emph{prefix \\custom{{nested}}| suffix}', 'left', '\\emph{prefix {nested} suffix}'],
  ['\\emph{|a {b} c}', 'left', 'a {b} c'],
  ['\\textbf|{bold}', 'right', 'bold'],
  ['\\textit{test}{body}|', 'left', '\\textit{test}body'],
  ['\\frac{numerator}|{denominator}', 'left', '\\frac numerator{denominator}'],
  ['\\frac{numerator}{denominator}|', 'left', '\\frac{numerator}denominator'],
  ['\\multicolumn{2}{c}|{cell}', 'left', '\\multicolumn{2}c{cell}'],
  ['\\frac{x}|% keep comment\n{y}', 'left', '\\fracx% keep comment\n{y}'],
  ['\\custom{one}\n  {two}|', 'left', '\\custom{one}\n  two'],
  ['\\custom{one}|\n\n{standalone}', 'left', 'one\n\n{standalone}'],
  ['\\custom{123}|% keep comment\n{456}', 'left', '\\custom123% keep comment\n{456}'],
  ['\\custom{123}|{unclosed', 'left', '\\custom123{unclosed'],
  ['\\alpha{123}|', 'left', '\\alpha123'],
  ['\\sin{123}|', 'left', '\\sin123'],
  ['\\LaTeX{}| guide', 'left', '\\LaTeX guide'],
  ['\\newcommand{\\custom}{123}|', 'left', '\\newcommand{\\custom}123'],
  ['\\providecommand\\textit{123}|', 'left', '\\providecommand\\textit123'],
  ['\\def% keep comment\n\\custom{123}|', 'left', '\\def% keep comment\n\\custom123'],
  ['\\let\\alias=\\custom{123}|', 'left', '\\let\\alias=\\custom123'],
  ['\\newcommand{\\custom}{x}\n\\custom{123}|', 'left', '\\newcommand{\\custom}{x}\n\\custom123'],
  ['\\begin{tabular}{cc}{first cell} & second\\end{tabular}|', 'left', '{first cell} & second'],
  ['\\begin{tabularx}{\\linewidth}[t]{>{\\bfseries}lX}\r\na & b\\end{tabularx}|', 'left', '\r\na & b'],
  ['\\begin{alignat}{2}a&=b\\end{alignat}|', 'left', 'a&=b'],
  ['\\begin{equation}{x}\\end{equation}|', 'left', '{x}'],
  ['\\begin{equation}{x}|\\end{equation}', 'left', '\\begin{equation}x\\end{equation}'],
  ['\\Bigl({x}|\\Bigr)', 'left', '\\Bigl(x\\Bigr)'],
  ['\\begin{tabular}{uncertain body}\\end{tabular}|', 'left', '{uncertain body}'],
  ['\\begin{aligned}[x]y\\end{aligned}|', 'left', '[x]y'],
  ['\\begin{tabular}{c% label\n c}x\\end{tabular}|', 'left', '{c% label\n c}x'],
];

const fallbacks: [string, 'left' | 'right'][] = [
  ['(bo|dy)', 'left'],
  ['(x)|', 'right'],
  ['\\[x\\|]', 'left'],
  ['\\begin{|align}x\\end{align}', 'left'],
  ['\\begin{align|}x\\end{align}', 'left'],
  ['\\begin{a}|x\\end{b}', 'left'],
  ['\\begin{a}|\\begin{b}\\end{a}\\end{b}', 'left'],
  ['\\begin{a}|{x\\end{a}}', 'left'],
  ['\\begin{a}|\\iffalse \\end{a} \\fi x\\end{a}', 'left'],
  ['\\iftrue\\begin{a}\\else\\begin{a}\\fi x\\end{a}|', 'left'],
  ['{|\\begin{a}x}\\end{a}', 'left'],
  ['\\begin% keep this comment\n{a}|x\\end{a}', 'left'],
  ['% {|comment}\n{x}', 'left'],
  ['\\begin{verbatim}\n% \\end{verbatim}\n(|literal)\n\\end{verbatim}', 'left'],
  ['\\begin{comment}\n  \\end{comment}\n(|literal)\n\\end{comment}', 'left'],
  ['\\verb!{|literal}!', 'left'],
  ['\\lstinline[language=TeX]!(|literal)!', 'left'],
  ['\\mintinline{tex}{(|literal)}', 'left'],
  ['\\Verb!(|literal)!', 'left'],
  ['\\left(|x\\right)', 'left'],
  ['\\Bigl[|x\\Bigr]', 'left'],
  ['([|x)]', 'left'],
  ['({x|})', 'left'],
  ['(|x{part) rest}', 'left'],
  ['{(|x} y)', 'left'],
  ['\\( (|x\\) y)', 'left'],
  ['$ (|a $ b $ c ) $', 'left'],
  ['$a$$|b$', 'left'],
  ['\\begin{align}\n(|x & y)\\\\\n\\end{align}', 'left'],
  ['\\begin{align}\n[x\\\\\ny]|\n\\end{align}', 'left'],
  ['\\\\[x\\\\]|', 'left'],
  ['{x\\}|', 'left'],
  ['|\\\\begin{a}x\\end{a}', 'right'],
];

for (const [marked, direction, expected] of pairs) {
  const offset = marked.indexOf('|');
  const text = marked.replace('|', '');
  const edits = findLatexBoundaryPair(text, offset, direction);
  assert.ok(edits, marked);
  let plan = getPairedDeletePlan(text, offset, offset, direction);
  let current = text;
  while (plan) {
    current = applyTextEditsToString(current, plan.edits);
    if (!plan.progress) break;
    const boundary = plan.progress.boundary;
    const next = direction === 'left' ? boundary.end : boundary.start;
    plan = getPairedDeletePlan(current, next, next, direction, plan.progress);
  }
  assert.strictEqual(current, expected, marked);
}

for (const prefix of ['', '\\newcommand{\\testcmd}[4]{#1#2#3#4}\n']) {
  for (const order of ['2314', '4321', '1234']) {
    let text = prefix + '\\testcmd{one}{two}{three}{four}';
    let previous: CommandArguments | undefined;
    for (const [index, digit] of Array.from(order).entries()) {
      const content = ['one', 'two', 'three', 'four'][Number(digit) - 1];
      const offset = text.indexOf(`{${content}}`) + content.length + 2;
      const plan = getPairedDeletePlan(text, offset, offset, 'left', undefined, previous);
      assert.ok(plan, `${order}: argument ${digit}`);
      text = applyTextEditsToString(text, plan.edits);
      previous = plan.remainingCommand;
      assert.strictEqual(text.slice(prefix.length).startsWith('\\testcmd'), index < order.length - 1);
    }
    assert.strictEqual(text, prefix + 'onetwothreefour');
  }
}

let withEmptyArgument = '\\custom{}{word}{last}';
let remainingArguments: CommandArguments | undefined;
for (const [argument, expected] of [
  ['{word}', '\\custom{}word{last}'], ['{}', '\\custom word{last}'], ['{last}', 'wordlast'],
]) {
  const offset = withEmptyArgument.indexOf(argument) + argument.length;
  const plan = getPairedDeletePlan(withEmptyArgument, offset, offset, 'left', undefined, remainingArguments);
  assert.ok(plan, argument);
  withEmptyArgument = applyTextEditsToString(withEmptyArgument, plan.edits);
  remainingArguments = plan.remainingCommand;
  assert.strictEqual(withEmptyArgument, expected);
}

for (const [marked, direction] of fallbacks) {
  const offset = marked.indexOf('|');
  assert.strictEqual(findLatexBoundaryPair(marked.replace('|', ''), offset, direction), undefined, marked);
}

const body = '\n  \\begin{quote} {x (y)} \\end{quote}\n% \\end{quote}\n'.repeat(1200);
const longEnvironment = '\\begin{quote}' + body + '\\end{quote}';
for (const offset of ['\\begin{quote}'.length, longEnvironment.length]) {
  const edits = findLatexBoundaryPair(longEnvironment, offset, 'left');
  assert.ok(edits, 'both ends locate their real partner across the full body');
  assert.strictEqual(applyTextEditsToString(longEnvironment, edits), body);
}

for (const [open, close, declaration = ''] of [
  ['\\begin{tabular}', '\\end{tabular}', '{cc}'], ['\\[', '\\]'], ['$$', '$$'], ['{', '}'],
]) {
  for (const direction of ['left', 'right'] as const) {
    for (const side of ['open', 'close'] as const) {
      const original = open + declaration + body + close;
      const boundary = side === 'open' ? open : close;
      const start = side === 'open' ? 0 : open.length + declaration.length + body.length;
      let text = original;
      let progress: PairedDeleteProgress | undefined;
      for (let remaining = boundary.length; remaining > 0; remaining--) {
        const cursor = direction === 'left' ? start + remaining : start;
        const plan = getPairedDeletePlan(text, cursor, cursor, direction, progress);
        assert.ok(plan, `${direction} ${side}: ${boundary} (${remaining} left)`);
        assert.strictEqual(plan.continued, remaining < boundary.length);
        text = applyTextEditsToString(text, plan.edits);
        progress = plan.progress;
        const fragment = direction === 'left' ? boundary.slice(0, remaining - 1) : boundary.slice(1 - remaining);
        assert.strictEqual(text, remaining === 1 ? body : side === 'open' ? fragment + declaration + body + close : open + declaration + body + fragment);
      }
      assert.strictEqual(progress, undefined);
      const selection = getPairedDeletePlan(original, start, start + boundary.length, direction);
      assert.ok(selection && !selection.progress);
      assert.strictEqual(applyTextEditsToString(original, selection.edits), body);
      assert.strictEqual(getPairedDeletePlan(original, start + 1, start + boundary.length + 1, direction), undefined);
    }
  }
}

function syncName(marked: string, length: number, name: string, link?: EnvironmentNameLink) {
  const start = marked.indexOf('|');
  const before = marked.replace('|', '');
  const after = before.slice(0, start) + name + before.slice(start + length);
  const plan = createEnvironmentNameSyncPlan(before, after,
    { rangeOffset: start, rangeLength: length, text: name }, {}, undefined, link);
  return { plan, result: applyTextEditsToString(after, plan.edits) };
}

const nested = '\\begin{tabular}x\\begin{tabular}y\\end{|tabular}z\\end{tabular}';
const erased = syncName(nested, 'tabular'.length, '');
assert.strictEqual(erased.result, nested.replace('|tabular', ''), 'erasing the name leaves the other side intact');
assert.ok(erased.plan.pendingNameLink);
assert.strictEqual(syncName(erased.result.replace('\\end{}', '\\end{|}'), 0, 'array', erased.plan.pendingNameLink).result,
  '\\begin{tabular}x\\begin{array}y\\end{array}z\\end{tabular}');
assert.strictEqual(syncName('\\begin{|tabular}x\\end{tabular}', 'tabular'.length, 'array').result, '\\begin{array}x\\end{array}');
for (const [source, length, replacement] of [
  ['\\begin{tabular}x\\end{tabular|}', 1, ''],
  ['\\begin{tabular}x\\end{|tabular}', 'tabular}'.length, 'array'],
  ['\\begin{tabular}x\\end{|tabular}', 0, '%'],
  ['\\begin{|a}\\begin{b}\\end{a}\\end{b}', 1, 'custom'],
  ['\\verb!\\begin{|tabular}x\\end{tabular}!', 1, 'x'],
  ['\\begin{tabular}\\verb!\\end{|tabular}!x\\end{tabular}', 1, 'x'],
] as const) {
  const { plan } = syncName(source, length, replacement);
  assert.ok(!plan.handled && !plan.pendingNameLink, source);
}

console.log(`paired deletion: ${pairs.length} pairs, ${fallbacks.length} fallbacks, progressive deletion and strict name sync passed`);
