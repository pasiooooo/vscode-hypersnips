import * as assert from 'assert';
import { performance } from 'perf_hooks';
import { sanitizeLatexForParsing as current } from '../src/latexContext';
import { sanitizeLatexForParsing as baseline } from './reference/latexContext';

const fixtures = [
  'Example text with $x + y$ and \\alpha.\nSecond line.\r\n',
  '\\begin{align}\na &= b \\\\\n\\end{align}',
  '~~~\nplain % comment\n~~~\nend',
  '```\ntext $x$\n```\nafter',
  'before <!-- hidden % body --> after',
  'before <!-- unfinished comment',
  'a `inline % code` b % comment\nc \\% escaped',
  'a % hidden\nb \\% visible\nc \\\\% hidden',
  '~~ not a fence\n<not a comment>\n',
  '\u793a\u4f8b \u0301 \ud83d\ude00 and tabs\t',
];
for (const text of fixtures) {
  for (let offset = 0; offset <= text.length; offset++) {
    const prefix = text.slice(0, offset);
    assert.strictEqual(current(prefix), baseline(prefix));
    assert.strictEqual(current(prefix, [{ start: 0, end: 4 }]),
      baseline(prefix, [{ start: 0, end: 4 }]), 'caller-supplied mask ranges are respected');
  }
}
const plain = 'Example text with $x + y$ and \\alpha.\n'.repeat(30000);
let copies = 0;
const split = String.prototype.split;
String.prototype.split = function(separator: any, limit?: number): string[] {
  if (separator === '') copies++;
  return split.call(this, separator, limit);
};
try { assert.strictEqual(current(plain), plain); }
finally { String.prototype.split = split; }
assert.strictEqual(copies, 0, 'unmasked text should not be copied into character arrays');
console.log('Sanitization/reference parity, explicit masks and plain-text allocation checks passed.');

if (process.argv.includes('--benchmark')) {
  for (const [name, fn] of [['baseline', baseline], ['current', current]] as const) {
    for (let i = 0; i < 10; i++) fn(plain);
    const samples = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      fn(plain);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ name, chars: plain.length, samples: samples.length,
      medianMs: samples[100], p95Ms: samples[189] }));
  }
}
