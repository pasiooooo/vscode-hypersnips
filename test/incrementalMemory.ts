import * as assert from 'assert';
import { LatexDocumentState } from '../src/latexDocumentState';

const collect = global.gc!;
assert.strictEqual(typeof collect, 'function', 'run this regression with --expose-gc');
const line = 'Example paragraph with $x + y = z$ and \\text{sample}, next item. % note\n';
const source = line.repeat(Math.ceil(1024 * 1024 / line.length));
const retained: { current: LatexDocumentState; previous?: LatexDocumentState } = {
  current: new LatexDocumentState(source),
};
function editLines(first: number, count: number) {
  for (let index = first; index < first + count; index++) {
    retained.previous = retained.current;
    const offset = index * line.length + index;
    retained.current = retained.current.update([{ rangeOffset: offset, rangeLength: 0, text: 'q' }]);
    retained.current.contextAt(offset + 1);
  }
}
function heap() {
  collect();
  collect();
  return process.memoryUsage().heapUsed;
}
editLines(0, 20);
const before = heap();
editLines(20, 100);
const growth = heap() - before;
assert.strictEqual(retained.current.text.length, source.length + 120);
assert.strictEqual(retained.current.version, 121);
assert.strictEqual(retained.previous!.version, 120);
assert.ok(growth < 12 * 1024 * 1024,
  `reused blocks must not retain entire previous document strings; observed ${growth} bytes after 100 edits`);
console.log(`same-document incremental memory regression passed (${growth} bytes growth after 100 edits)`);

function shrinkDocument() {
  const snapshots: { current: LatexDocumentState; previous?: LatexDocumentState } = {
    current: new LatexDocumentState('A'.repeat(16 * 1024 * 1024) + '\nlast line\n'),
  };
  for (const length of [snapshots.current.text.length - 128, 1, 1, 1]) {
    snapshots.previous = snapshots.current;
    snapshots.current = snapshots.current.update([{ rangeOffset: 0, rangeLength: length, text: '' }]);
    snapshots.current.contextAt(snapshots.current.text.length);
  }
  return snapshots;
}
const beforeShrink = heap();
const shrunken = shrinkDocument();
const retainedAfterShrink = heap() - beforeShrink;
assert.strictEqual(shrunken.current.text.length, 125);
assert.strictEqual(shrunken.previous!.text.length, 126);
assert.ok(retainedAfterShrink < 8 * 1024 * 1024,
  `small snapshots must release deleted large document storage; observed ${retainedAfterShrink} retained bytes`);
console.log(`large-deletion memory regression passed (${retainedAfterShrink} retained bytes)`);

const environmentName = 'synthetic_environment_long_name_123456';
const pending = new LatexDocumentState('\\begin{' + environmentName + '} \\text\n' +
  (' '.repeat(63) + '\n').repeat(16384));
const beforeContexts = heap();
for (let index = 0; index < 32; index++) {
  assert.strictEqual(pending.contextAt(pending.text.length - index - 1).currentEnvironment, environmentName);
}
const contextGrowth = heap() - beforeContexts;
assert.strictEqual(pending.contextAt(pending.text.length - 32).currentEnvironment, environmentName);
assert.ok(contextGrowth < 8 * 1024 * 1024,
  `cached environment names must not retain large temporary prefix strings; observed ${contextGrowth} bytes`);
console.log(`large-prefix context-cache memory regression passed (${contextGrowth} bytes growth)`);
