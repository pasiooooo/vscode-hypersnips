import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { runInNewContext } from 'vm';
import { performance } from 'perf_hooks';
import { HSnippet } from '../src/hsnippet';

class Position {
  constructor(public line: number, public character: number) {}
  translate(line: number, character: number) {
    return new Position(this.line + line, this.character + character);
  }
}
class Range {
  start: Position;
  end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    this.start = typeof a === 'number' ? new Position(a, b as number) : a;
    this.end = typeof a === 'number' ? new Position(c!, d!) : b as Position;
  }
}
function load(relative: string, instrument = true) {
  const exports: any = {};
  const code = readFileSync(path.join(__dirname, relative), 'utf8');
  runInNewContext(
    (instrument ? 'let checks = 0; const endsWith = String.prototype.endsWith;' +
      'String.prototype.endsWith = function(...args) { checks++; return endsWith.apply(this, args); };\n' : '') +
    code + (instrument ? '\nexports.checks = () => checks; exports.reset = () => { checks = 0; };' : ''),
    { exports, require: (name: string) => {
      if (name === 'vscode') return {
        Position, Range, workspace: { getConfiguration: () => ({ get: () => 2 }) },
      };
      if (name === './utils') return {
        lineRange: (character: number, position: Position) =>
          new Range(position.line, character, position.line, position.character),
      };
      throw new Error('Unexpected completion dependency: ' + name);
    } }
  );
  return exports;
}
const current = load('../src/completion.js');
const baseline = load('./reference/completion.js');
function documentAt(text: string) {
  const lines = text.split('\n');
  const position = new Position(lines.length - 1, lines[lines.length - 1].length);
  const offset = (p: Position) => lines.slice(0, p.line).reduce((sum, line) => sum + line.length + 1, 0) + p.character;
  return {
    position,
    document: {
      getText: (range: Range) => text.slice(offset(range.start), offset(range.end)),
      getWordRangeAtPosition: () => undefined,
    },
  };
}
function snippet(trigger: string | RegExp, flags: string) {
  return new HSnippet({ trigger, flags, description: 'Synthetic completion' }, () => [[], []], 0);
}
function normalize(value: any): any {
  if (Array.isArray(value)) return Array.from(value, normalize);
  return value && {
    label: value.label, trigger: value.snippet.trigger, flags: {
      automatic: value.snippet.automatic, inword: value.snippet.inword,
    }, start: [value.range.start.line, value.range.start.character],
    end: [value.range.end.line, value.range.end.character], groups: Array.from(value.groups),
  };
}
for (const text of ['', 'a', 'alpha', 'prefixalpha', '  alpha', 'x alpha', 'x\nalpha', '\u793a\u4f8b']) {
  for (const flag of ['A', 'iA', 'wA', 'bA', 'i', 'w', 'b']) {
    for (const method of ['getAutomaticCompletion', 'getCompletions']) {
      const { document, position } = documentAt(text);
      const make = () => [snippet('alphabet', flag), snippet('alpha', flag),
        snippet(/\w+$/, 'A'), snippet(/x\n(\w+)$/, 'AM'), snippet('\u793a\u4f8b', flag)];
      assert.deepStrictEqual(normalize(current[method](document, position, make())),
        normalize(baseline[method](document, position, make())), method + ': ' + text + ': ' + flag);
    }
  }
}
const { document, position } = documentAt('q');
const snippets = Array.from({ length: 1000 }, (_, i) => snippet('synthetic' + i + '_suffix', 'iA'));
current.reset();
assert.strictEqual(current.getAutomaticCompletion(document, position, snippets), undefined);
assert.ok(current.checks() <= snippets.length, 'automatic misses must not compute unused trigger prefixes');
console.log('Completion/reference parity and bounded automatic prefix work passed.');

if (process.argv.includes('--benchmark')) {
  const original = load('./reference/completion.js', false);
  const optimized = load('../src/completion.js', false);
  for (const count of [1000, 10000]) {
    const candidates = Array.from({ length: count }, (_, i) => snippet('synthetic' + i + '_suffix', 'iA'));
    for (const [name, api] of [['baseline', original], ['current', optimized]] as const) {
      const run = () => api.getAutomaticCompletion(document, position, candidates);
      for (let i = 0; i < 10; i++) run();
      const samples = [];
      for (let i = 0; i < 200; i++) {
        const start = performance.now();
        run();
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      console.log(JSON.stringify({ name, count, samples: samples.length,
        medianMs: samples[100], p95Ms: samples[189] }));
    }
  }
}
