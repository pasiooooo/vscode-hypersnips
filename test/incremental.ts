import * as assert from 'assert';
import { LatexDocumentState } from '../src/latexDocumentState';
import * as edit from '../src/latexEdit';
import * as baselineEdit from './reference/latexEdit';
import * as convert from '../src/environmentConvert';
import * as baselineConvert from './reference/environmentConvert';
import { getAlignmentEdits, mapAlignmentOffset } from '../src/latexAlignment';
import * as baselineAlignment from './reference/latexAlignment';
import { getLatexContext } from './reference/latexContext';
import { findLatexEnvironmentPairAt, findDisplayMathDelimiterAt } from './reference/environmentConvert';

function check(state: LatexDocumentState, offsets?: number[]) {
  assert.strictEqual(state.sanitizedText, require('./reference/latexContext').sanitizeLatexForParsing(state.text));
  for (const offset of offsets || Array.from({ length: state.text.length + 1 }, (_, i) => i)) {
    assert.deepStrictEqual(state.contextAt(offset), getLatexContext(state.text, offset, state.options),
      `context offset=${offset} text=${JSON.stringify(state.text)}`);
    assert.deepStrictEqual(state.environmentPairAt(offset), findLatexEnvironmentPairAt(state.text, offset, state.options),
      `environment offset=${offset} text=${JSON.stringify(state.text)}`);
    assert.deepStrictEqual(state.displayDelimiterAt(offset), findDisplayMathDelimiterAt(state.text, offset),
      `delimiter offset=${offset} text=${JSON.stringify(state.text)}`);
    assert.deepStrictEqual(edit.getSmartEnterPlan(state.text, offset, state.options, state), baselineEdit.getSmartEnterPlan(state.text, offset, state.options));
    // Tab now navigates existing separators and accepts completed rows; compare both current parsing paths.
    assert.strictEqual(edit.shouldInsertAlignmentSeparator(state.text, offset, state.options, state), edit.shouldInsertAlignmentSeparator(state.text, offset, state.options));
    assert.deepStrictEqual(edit.getSmartTabPlan(state.text, offset, state.options, state), edit.getSmartTabPlan(state.text, offset, state.options));
    assert.deepStrictEqual(convert.createEnvironmentConversionPlan(state.text, offset, 'array', '{cc}', state.options, state), baselineConvert.createEnvironmentConversionPlan(state.text, offset, 'array', '{cc}', state.options));
    assert.deepStrictEqual(convert.createWrapCurrentMathStructurePlan(state.text, offset, 'aligned', '', state.options, state), baselineConvert.createWrapCurrentMathStructurePlan(state.text, offset, 'aligned', '', state.options));
    assert.deepStrictEqual(convert.createUnwrapMathStructurePlan(state.text, offset, state.options, state), baselineConvert.createUnwrapMathStructurePlan(state.text, offset, state.options));
    const widths = new Map([['x', 1.25], ['中', 2.1]]);
    const edits = getAlignmentEdits(state.text, offset, state.options, 4, widths, state);
    const baselineEdits = baselineAlignment.getAlignmentEdits(state.text, offset, state.options, 4, widths);
    assert.deepStrictEqual(edits, baselineEdits);
    assert.strictEqual(mapAlignmentOffset(offset, edits), baselineAlignment.mapAlignmentOffset(offset, baselineEdits));
  }
}
const fixtures = [
  '', 'plain\r\nUnicode 中文😀é\r\n', '\\begin{align}\na&=b\\\\\nc&=d\n\\end{align}',
  '\\begin{custom}\n\\text {a{b}\nc}\n$xy$\n\\end{custom}',
  '\\begin{verbatim}\n\\begin{align}\n$$\n\\end{verbatim}\n\\end{align}',
  '<!--\n\\begin{align}\n-->\ntext', '<!--\n\\begin{align}\n',
  '```latex\n\\begin{align}\n```\n$$a$$', '~~~\n$hi$\n~~~~\n\\[x\\]',
  '\\begin\n{align}\n\\text\n{x{y}\n}\n\\end\n{align}',
  '\\begin%comment\n{align}\nx\n\\end{align}',
  '\\text%comment\n{a\n}\n', '`$`\n`x $\n%% $\n$abc$$',
  '\\begin{align}\n\\begin{cases}\nx&y\n\\end{align}\n\\end{cases}',
  '\\begin{tabular}{cc}\na&b\\\\\nc&d\n\\end{tabular}',
];
for (const fixture of fixtures) check(new LatexDocumentState(fixture, 1, { extraMathEnvironments: ['custom'] }));
let seed = 0x165ae;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
const fragments = ['x', '', '\n', '\r\n', '$', '{', '}', '\\', '`', '~~~', '<!--', '-->', '%', '😀', '\\begin{align}', '\\end{align}', '\\text{'];
for (const fixture of fixtures) {
  let state = new LatexDocumentState(fixture);
  for (let step = 0; step < 35; step++) {
    const offset = Math.floor(random() * (state.text.length + 1));
    const length = Math.min(Math.floor(random() * 5), state.text.length - offset);
    const change = { rangeOffset: offset, rangeLength: length, text: fragments[Math.floor(random() * fragments.length)] };
    const old = state;
    const before = old.contextAt(Math.floor(old.text.length / 2));
    state = old.update([change]);
    check(state);
    assert.deepStrictEqual(convert.createEnvironmentNameSyncPlan(old.text, state.text, change, old.options, old),
      baselineConvert.createEnvironmentNameSyncPlan(old.text, state.text, change, old.options));
    assert.deepStrictEqual(old.contextAt(Math.floor(old.text.length / 2)), before);
  }
}
const initial = new LatexDocumentState('\\begin{align}\nalpha\nbeta\ngamma\n\\end{align}');
const changed = initial.update([{ rangeOffset: 16, rangeLength: 0, text: 'xyz' }]);
assert.ok(changed.reusedBlocks >= 4 && changed.parsedBlocks == 1, 'ordinary edits reuse line checkpoints');
check(changed);
const multi = initial.update([{ rangeOffset: 16, rangeLength: 2, text: 'Unicode😀' }, { rangeOffset: 26, rangeLength: 0, text: '\r\n' }]);
check(multi);
assert.strictEqual(initial.update([], 99).reusedBlocks, 0, 'version discontinuity rebuilds');
assert.strictEqual(initial.update([], 2, { extraMathEnvironments: ['foo'] }).reusedBlocks, 0, 'configuration change rebuilds');
for (let step = 0; step < 100; step++) {
  const first = Math.floor(random() * (initial.text.length / 2));
  const second = Math.floor(initial.text.length / 2) + Math.floor(random() * (initial.text.length / 2));
  const batch = [
    { rangeOffset: first, rangeLength: Math.min(2, second - first), text: fragments[Math.floor(random() * fragments.length)] },
    { rangeOffset: second, rangeLength: Math.min(2, initial.text.length - second), text: fragments[Math.floor(random() * fragments.length)] },
  ];
  check(initial.update(step % 2 ? batch : batch.reverse()));
}
for (let offset = 0; offset <= initial.text.length; offset++) {
  const current = initial.text.slice(0, offset) + '\n' + initial.text.slice(offset);
  assert.deepStrictEqual(edit.getSmartEnterRecoveryPlan(initial.text, offset, current, initial.options, initial),
    baselineEdit.getSmartEnterRecoveryPlan(initial.text, offset, current, initial.options));
}
assert.throws(() => initial.update([{ rangeOffset: -1, rangeLength: 0, text: '' }]), RangeError);
assert.throws(() => initial.update([{ rangeOffset: 1, rangeLength: 5, text: '' }, { rangeOffset: 2, rangeLength: 2, text: '' }]), RangeError);
console.log('incremental contexts and pairs: fixtures, 525 seeded edits, batch edits, reuse and snapshot independence passed');

assert.ok(Object.isFrozen(initial.contextAt(20)), 'snapshot contexts must be immutable');

const partial = new LatexDocumentState('\\begin{partial\n' + 'name fragment\n'.repeat(200) + '}\nbody\n\\end{partial}');
check(partial, [0, 6, 15, partial.text.length - 20, partial.text.length]);
const sourceOptions = { extraMathEnvironments: ['custom'] };
const configured = new LatexDocumentState('\\begin{custom}\nx', 1, sourceOptions);
sourceOptions.extraMathEnvironments.length = 0;
assert.ok(configured.contextAt(configured.text.length).inMath, 'caller options cannot mutate a snapshot');
assert.ok(Object.isFrozen(initial.environmentPairAt(20)));
assert.throws(() => initial.update([{ rangeOffset: NaN, rangeLength: 0, text: '' }]), RangeError);
console.log('incremental plan/caret parity, 100 seeded multi-edits, immutable results and long partial commands passed');

for (const text of [
  '\\text\n~~~\nopen', '\\text\n<!--\nopen',
  '\\text\n% comment\n{x}', '\\begin\n{align}\nx\n\\end{align}',
  '<!--\n-->\nplain', '~~~\n$x$\n~~~\nplain',
]) check(new LatexDocumentState(text));

const contextModule = require('../src/latexContext') as typeof import('../src/latexContext');
const sanitize = contextModule.sanitizeLatexForParsing;
let sanitizations = 0;
contextModule.sanitizeLatexForParsing = (...args: Parameters<typeof sanitize>) => {
  sanitizations++;
  return sanitize(...args);
};
try {
  const state = new LatexDocumentState('first % hidden\nsecond\nthird');
  assert.strictEqual(sanitizations, state.parsedBlocks, 'complete blocks should be sanitized once');
  sanitizations = 0;
  const next = state.update([{ rangeOffset: state.text.length, rangeLength: 0, text: 'x' }]);
  assert.strictEqual(sanitizations, next.parsedBlocks, 'ordinary updates should reuse complete block sanitization');
} finally {
  contextModule.sanitizeLatexForParsing = sanitize;
}
console.log('complete-block sanitization reuse and incomplete-tail parity passed');

const gapSource = Array.from({ length: 200 }, (_, index) => `row ${index} $x$\n`).join('');
const gapState = new LatexDocumentState(gapSource);
const distant = gapState.update([
  { rangeOffset: 0, rangeLength: 0, text: 'q' },
  { rangeOffset: gapSource.lastIndexOf('row'), rangeLength: 0, text: 'q' },
]);
assert.strictEqual(distant.parsedBlocks, 2, 'distant edits must not reparse the untouched gap');
assert.strictEqual(distant.reusedBlocks, 198);
check(distant, [0, 1, distant.text.indexOf('$'), Math.floor(distant.text.length / 2), distant.text.length]);
const alternating = gapState.update(Array.from({ length: 100 }, (_, index) => ({
  rangeOffset: gapSource.indexOf(`row ${index * 2} `), rangeLength: 0, text: 'q',
})).reverse());
assert.strictEqual(alternating.parsedBlocks, 100);
assert.strictEqual(alternating.reusedBlocks, 100);
check(alternating, [0, Math.floor(alternating.text.length / 2), alternating.text.length]);

const tied = new LatexDocumentState('abcdef');
assert.strictEqual(tied.update([
  { rangeOffset: 2, rangeLength: 0, text: 'A' }, { rangeOffset: 2, rangeLength: 0, text: 'B' },
]).text, 'abBAcdef', 'same-offset insertions retain their original ordering');
assert.strictEqual(tied.update([
  { rangeOffset: 2, rangeLength: 2, text: 'X' }, { rangeOffset: 2, rangeLength: 0, text: 'Y' },
]).text, 'abYXef');
assert.throws(() => tied.update([
  { rangeOffset: 2, rangeLength: 0, text: 'Y' }, { rangeOffset: 2, rangeLength: 2, text: 'X' },
]), /Invalid or overlapping document changes/);

for (const marker of ['~~~\n', '<!--']) {
  const before = new LatexDocumentState('first\nmiddle\nlast\n');
  check(before.update([
    { rangeOffset: 0, rangeLength: 0, text: marker },
    { rangeOffset: before.text.indexOf('last'), rangeLength: 0, text: marker == '<!--' ? '-->' : marker },
  ]));
}
for (const text of ['\\text\n{alpha}\nrest\nlast\n', '\\begin{align}\nalpha\n\\end{align}\ntail\n', 'x\r\nmiddle\r\nlast\r\n']) {
  const before = new LatexDocumentState(text);
  check(before.update([
    { rangeOffset: 1, rangeLength: 1, text: '\n' },
    { rangeOffset: text.length, rangeLength: 0, text: 'q' },
  ]));
}
console.log('multi-change gap reuse, stable insertion ordering and structural boundary parity passed');
