// Synthetic benchmarks. Run the same baseline and current code in one process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { performance } = require('perf_hooks');
const root = path.resolve(__dirname, '..');
const built = path.join(root, '.test-out');
const baselineContext = require(path.join(built, 'test/reference/latexContext'));
const baselineEnvironment = require(path.join(built, 'test/reference/environmentConvert'));
const baselineAlignment = require(path.join(built, 'test/reference/latexAlignment'));
const baselineParser = require(path.join(built, 'test/reference/parser'));
const currentContext = require(path.join(built, 'src/latexContext'));
const currentEnvironment = require(path.join(built, 'src/environmentConvert'));
const currentAlignment = require(path.join(built, 'src/latexAlignment'));
const currentParser = require(path.join(built, 'src/parser'));
const { LatexDocumentState } = require(path.join(built, 'src/latexDocumentState'));
const samples = 200;
const report = {
  environment: { date: new Date().toISOString(), node: process.version, cpu: os.cpus()[0].model, platform: process.platform },
  samples, measurements: [], gates: [],
  method: 'Synthetic input; 10 warmups, 200 measurements. Same process/runtime. Function timings exclude editor IPC/rendering, 150ms debounce, native font processes and other extensions.',
};
function timed(name, fn, details = {}) {
  for (let i = 0; i < 10; i++) fn();
  const times = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const result = { name, ...details, medianMs: +times[Math.floor(samples / 2)].toFixed(4),
    p95Ms: +times[Math.ceil(samples * .95) - 1].toFixed(4), maxMs: +times.at(-1).toFixed(4) };
  report.measurements.push(result);
  console.log(JSON.stringify(result));
  return result;
}
const paragraph = 'Example paragraph with $x + y = z$ and \\text{sample}, next item. % note\n';
function fixture(prefixBytes, rows = 10, cols = 4) {
  const prefix = paragraph.repeat(Math.ceil(prefixBytes / paragraph.length));
  const body = Array.from({length: rows}, (_, r) => '  ' +
    Array.from({length: cols}, (_, c) => 'v' + r + '_' + c).join(' & ') + ' \\\\ % example');
  const text = prefix + '\\begin{align}\n' + body.join('\n') + '\n\\end{align}\n';
  return { text, offset: prefix.length + '\\begin{align}\n'.length + 4 };
}
for (const kib of [10, 100, 500, 1024]) {
  const {text, offset} = fixture(kib * 1024);
  const change = { rangeOffset: offset, rangeLength: 0, text: 'q' };
  const after = text.slice(0, offset) + 'q' + text.slice(offset);
  const original = new LatexDocumentState(text);
  const updated = original.update([change]);
  assert.deepEqual(updated.contextAt(offset + 1), baselineContext.getLatexContext(after, offset + 1));
  const baseline = timed('typing baseline', () => {
    baselineContext.getLatexContext(after, offset + 1);
    baselineEnvironment.createEnvironmentNameSyncPlan(text, after, change);
  }, {kib});
  let lastState;
  const current = timed('typing incremental', () => {
    lastState = original.update([change]);
    currentContext.getLatexContext(after, offset + 1, {}, lastState);
    currentEnvironment.createEnvironmentNameSyncPlan(text, after, change, {}, original);
  }, {kib});
  report.measurements.push({ name: 'reuse', kib, parsedBlocks: lastState.parsedBlocks, reusedBlocks: lastState.reusedBlocks });
  assert.ok(lastState.reusedBlocks > 0, 'ordinary edit must reuse parsed blocks');
  if (kib === 1024) {
    report.gates.push({ name: '1 MiB typing median >=70% faster', passed: current.medianMs <= baseline.medianMs * .3,
      reductionPercent: +(100 * (1 - current.medianMs / baseline.medianMs)).toFixed(1) });
    report.gates.push({ name: '1 MiB typing P95 <=10ms', passed: current.p95Ms <= 10, p95Ms: current.p95Ms });
  }
}
const large = fixture(1024 * 1024);
for (const [position, offset] of [['start', 7], ['middle', Math.floor(large.offset / 2)], ['end', large.offset]]) {
  const state = new LatexDocumentState(large.text);
  timed('ordinary position update', () => {
    const updated = state.update([{ rangeOffset: offset, rangeLength: 0, text: 'q' }]);
    updated.contextAt(offset + 1);
  }, {position});
}
timed('cold 1 MiB parse', () => new LatexDocumentState(large.text));
const structural = new LatexDocumentState(large.text);
timed('structural fence insertion', () => structural.update([{ rangeOffset: 0, rangeLength: 0, text: '~~~\n' }]));
const wide = fixture(0, 100, 128);
const wideState = new LatexDocumentState(wide.text);
assert.deepEqual(currentAlignment.getAlignmentEdits(wide.text, wide.offset, {}, 4, new Map(), wideState),
  baselineAlignment.getAlignmentEdits(wide.text, wide.offset));
const baseWide = timed('wide alignment baseline', () => baselineAlignment.getAlignmentEdits(wide.text, wide.offset));
const nowWide = timed('wide alignment current', () => currentAlignment.getAlignmentEdits(wide.text, wide.offset, {}, 4, new Map(), wideState));
report.gates.push({ name: '100x128 alignment >=50% faster', passed: nowWide.medianMs <= baseWide.medianMs * .5,
  reductionPercent: +(100 * (1 - nowWide.medianMs / baseWide.medianMs)).toFixed(1) });
for (const count of [1000, 10000]) {
  const source = Array.from({length:count}, (_,i) => 'snippet trigger'+i+' "Demo" wA\nvalue\nendsnippet\n').join('');
  timed('snippet compile baseline', () => baselineParser.parse(source), {count});
  timed('snippet compile current', () => currentParser.parse(source), {count});
}
if (global.gc) {
  function releasedBatch() {
    for (let i = 0; i < 20; i++) {
      const state = new LatexDocumentState(large.text);
      const updated = state.update([{ rangeOffset: large.offset, rangeLength: 0, text: 'q' }]);
      updated.contextAt(large.offset + 1);
    }
  }
  releasedBatch();
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const batches = [];
  for (let batch = 0; batch < 5; batch++) {
    releasedBatch();
    global.gc();
    batches.push(process.memoryUsage().heapUsed);
  }
  report.memory = { cycles: 100, warmupCycles: 20, beforeBytes: before, afterBytes: batches.at(-1), batchHeapBytes: batches,
    note: 'Synthetic parse/edit/release cycles with references leaving helper scope; post-GC heap trend is not proof of absence of all leaks.' };
}
const out = path.join(root, 'dist/performance/results.json');
fs.mkdirSync(path.dirname(out), {recursive:true});
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({gates:report.gates,memory:report.memory,report:out}));
if (process.argv.includes('--assert-targets') && report.gates.some(g => !g.passed)) process.exitCode = 1;

