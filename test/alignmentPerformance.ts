import * as assert from 'assert';
import { getAlignmentEdits } from '../src/latexAlignment';
import { LatexDocumentState } from '../src/latexDocumentState';
import { applyTextEditsToString } from '../src/latexEdit';
import * as reference from './reference/latexAlignment';

class CountingWidths extends Map<string, number> {
  reads = 0;

  override get(key: string) {
    this.reads++;
    return super.get(key);
  }
}

const widths = new Map<string, number>([
  [' ', 1], ['\t', 1], ['a', 0.1], ['b', 0.2], ['c', 0.3],
  ['x', 1e-12], ['y', 1 + Number.EPSILON], ['z', 1 / 3], ['=', 0.7],
  ['+', 0.9], ['-', 1.1], ['&', 0.4], ['\\', 0.6], ['%', 0.8],
]);

const fixtures = [
  String.raw`\begin{align}
	a+b&=c-d \\ % one
	longer+x&=y+z \\ % two
\end{align}`,
  String.raw`\begin{matrix}
  &a&&b \\
  x&&& \\
  &&c& \\
\end{matrix}`,
  String.raw`\begin{align}
  a_{b+c}&=x^{-1}+{y-z} \\
  longer&=-z \\
  % standalone
\end{align}`,
  String.raw`\begin{align}
  outer&=one \\
  \begin{matrix}
    a&b \\
    longer&c \\
  \end{matrix} \\
  last&=two \\
\end{align}
\begin{align}
  x&=y \\
  xx&=z \\
\end{align}`,
];

for (const text of fixtures) {
  for (const offset of [text.indexOf('\n') + 1, text.indexOf('&'), text.lastIndexOf('&')]) {
    const state = new LatexDocumentState(text);
    const actual = getAlignmentEdits(text, offset, {}, 8, widths, state);
    assert.deepStrictEqual(actual, reference.getAlignmentEdits(text, offset, {}, 8, widths));
    const formatted = applyTextEditsToString(text, actual);
    assert.strictEqual(formatted.replace(/[ \t]/g, ''), text.replace(/[ \t]/g, ''),
      'alignment changes whitespace only');
    assert.deepStrictEqual(getAlignmentEdits(formatted, offset, {}, 8, widths,
      new LatexDocumentState(formatted)), [], 'alignment is idempotent');
  }
}

const floating = '\\begin{align}\n  x\ta+b&z \\\\ % one\n  x\tb+a&y \\\\ % two\n\\end{align}';
for (const magnitude of [0, 1e-12, 2 ** 44]) {
  const extreme = new Map(widths).set('x', magnitude);
  for (const tabSize of [2, 4, 8]) {
    assert.deepStrictEqual(getAlignmentEdits(floating, floating.indexOf('x'), {}, tabSize, extreme),
      reference.getAlignmentEdits(floating, floating.indexOf('x'), {}, tabSize, extreme),
      'zero, tiny and large widths preserve sequential floating-point and mid-cell Tab behavior');
  }
}
const wideRows = Array.from({ length: 12 }, (_, row) => '  ' +
  Array.from({ length: 16 }, (_, cell) => `v${row}_${cell}`).join(' & ') + ' \\\\ % example');
const wide = '\\begin{align}\n' + wideRows.join('\n') + '\n\\end{align}\n';
const counting = new CountingWidths(Array.from(' v_0123456789&\\%example')
  .map((character, index) => [character, (index % 5 + 1) / 7]));
const actual = getAlignmentEdits(wide, wide.indexOf('\n') + 3, {}, 4, counting, new LatexDocumentState(wide));
assert.ok(counting.reads < wide.length * 8,
  `alignment width reads must stay linear; observed ${counting.reads} for ${wide.length} characters`);
assert.deepStrictEqual(actual, reference.getAlignmentEdits(wide, wide.indexOf('\n') + 3, {}, 4,
  new Map(counting)));

const longCell = '\\begin{matrix}\n' + 'x'.repeat(1000) + '&a \\\\\nx&b \\\\\n\\end{matrix}';
const cellWidths = new CountingWidths([['x', 1 / 3]]);
const cellEdits = getAlignmentEdits(longCell, longCell.indexOf('x'), {}, 4, cellWidths);
assert.strictEqual(cellWidths.reads, 1001, 'measured cell content should not be measured a second time');
assert.deepStrictEqual(cellEdits, reference.getAlignmentEdits(longCell, longCell.indexOf('x'), {}, 4,
  new Map(cellWidths)), 'continuing from the measured width preserves fractional padding');

const operatorRow = Array.from({ length: 32 }, () => 'p + q - r = s').join(' & ') + ' \\\\';
const operatorTable = '\\begin{align}\n' + operatorRow + '\nlong + ' + operatorRow + '\n\\end{align}';
const operatorExpected = reference.getAlignmentEdits(operatorTable, operatorTable.indexOf('p'));
let whitespaceChecks = 0, unaryPrefixScans = 0;
const regexTest = RegExp.prototype.test;
RegExp.prototype.test = function(value: string) {
  if (this.source == '[ \\t]') whitespaceChecks++;
  if (this.source == String.raw`[+=\-*/(^_&$]\s*$`) unaryPrefixScans += value.length;
  return regexTest.call(this, value);
};
try {
  assert.deepStrictEqual(getAlignmentEdits(longCell, longCell.indexOf('x'), {}, 4, new Map(cellWidths)), cellEdits);
  assert.deepStrictEqual(getAlignmentEdits(operatorTable, operatorTable.indexOf('p')), operatorExpected);
} finally {
  RegExp.prototype.test = regexTest;
}
assert.strictEqual(whitespaceChecks, 0, 'whitespace edits should scan runs instead of testing every code unit');
assert.strictEqual(unaryPrefixScans, 0, 'unary checks should inspect the trimmed suffix instead of searching growing prefixes');

for (const space of [' ', '\t', '\r', '\v', '\f', '\u00a0', '\u1680', '\u2000', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff']) {
  const text = '\\begin{align}\n' + space + '-p' + space + '+' + space + 'q&=s \\\\\n' +
    'long' + space + '-' + space + 'r&=s \\\\\n\\end{align}';
  assert.deepStrictEqual(getAlignmentEdits(text, text.indexOf('p')),
    reference.getAlignmentEdits(text, text.indexOf('p')), 'Unicode whitespace preserves unary sign classification');
}

console.log('alignment differential fixtures and linear width accumulation passed');

async function testAffectedEnvironments() {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const vm = require('vm') as typeof import('vm');
  const text = String.raw`outside sentinel
\begin{align}
  a&=b \\ % eligible
  longer&=c \\
  \text{ignored % excluded
  }
\end{align}
\begin{matrix}
  x&y \\
  xx&z \\
\end{matrix}
\begin{matrix}
  untouched&only \\
  third&body \\
\end{matrix}`;
  let timer: (() => Promise<void>) | undefined;
  let finishMeasurement: (() => void) | undefined;
  let holdMeasurement = false;
  let currentRequest: (() => boolean) | undefined;
  let measuredText = '';
  let editCalls = 0;
  const offsets: number[] = [];
  const document = {
    version: 1, uri: {}, languageId: 'latex', getText: () => text,
    offsetAt: (offset: number) => offset, positionAt: (offset: number) => offset,
  };
  const editor = {
    document, options: { tabSize: 4 }, selections: [],
    edit: async () => { editCalls++; return true; },
  };
  const vscode = {
    window: { activeTextEditor: editor }, env: {},
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  };
  const exported: { schedule?: (editor: unknown, event: unknown) => void } = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8') +
    '\nexports.schedule = scheduleAlignment;', {
    exports: exported, console,
    setTimeout: (callback: typeof timer) => { timer = callback; return 1; },
    clearTimeout: () => { timer = undefined; },
    require: (name: string) => {
      if (name == 'vscode') return vscode;
      if (name == './fontMetrics') return { getFontCharacterWidths: async (
        _font: unknown, body: string, isCurrent: () => boolean
      ) => {
        measuredText = body;
        currentRequest = isCurrent;
        if (holdMeasurement) await new Promise<void>((resolve) => { finishMeasurement = resolve; });
        return new Map();
      } };
      if (name == './latexAlignment') return {
        ...require(path.join(__dirname, '../src/latexAlignment')),
        getAlignmentEdits: (...args: Parameters<typeof getAlignmentEdits>) => {
          offsets.push(args[1]);
          return getAlignmentEdits(...args);
        },
      };
      if (name == './latexEdit' || name == './latexDocumentState') return require(path.join(__dirname, '../src', name));
      return {};
    },
  });
  const changed = [text.indexOf('a&'), text.indexOf('eligible'), text.indexOf('excluded'), text.indexOf('x&')];
  const event = { document, contentChanges: changed.map((rangeOffset) => ({ rangeOffset, rangeLength: 1, text: 'q' })) };
  exported.schedule!(editor, event);
  await timer!();
  assert.strictEqual(offsets.length, 2, 'each eligible affected environment is aligned once');
  assert.ok(offsets.every((offset) => !new LatexDocumentState(text).contextAt(offset).inTextLikeCommand),
    'ineligible positions cannot replace an eligible representative for the same environment');
  const state = new LatexDocumentState(text);
  const bodies = [changed[0], changed[3]].map((offset) => {
    const pair = state.environmentPairAt(offset)!;
    return text.slice(pair.beginEnd, pair.endStart);
  });
  assert.strictEqual(measuredText, bodies.join(''), 'only the two affected environment bodies request glyphs');
  assert.strictEqual(editCalls, 1, 'multiple environments share one undo-preserving edit transaction');
  assert.strictEqual(currentRequest!(), true);

  holdMeasurement = true;
  exported.schedule!(editor, event);
  const pending = timer!();
  document.version++;
  assert.strictEqual(currentRequest!(), false, 'font task observes document version changes');
  finishMeasurement!();
  await pending;
  assert.strictEqual(editCalls, 1, 'stale measured widths never apply edits');
  assert.strictEqual(offsets.length, 2, 'stale task avoids alignment calculations');
  console.log('affected environment deduplication, glyph scope and stale scheduling passed');
}

testAffectedEnvironments().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
