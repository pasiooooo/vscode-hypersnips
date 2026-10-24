import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { runInNewContext } from 'vm';
import { EditorFont } from '../src/fontMetrics';

interface Launch {
  request?: { font: EditorFont; characters: string[] };
  finish: (error?: Error, result?: Record<string, number> | string) => void;
}

function loadFontMetrics(coverageUnavailable = false) {
  const launches: Launch[] = [];
  let collectedCharacters = 0;
  let coverageCompilations = 0;
  const exported: { getFontCharacterWidths?: (
    font: EditorFont, text: string, isCurrent?: () => boolean
  ) => Promise<Map<string, number>> } = {};
  const source = readFileSync(path.join(__dirname, '../src/fontMetrics.js'), 'utf8');
  runInNewContext(source, {
    exports: exported,
    Buffer,
    console,
    Set: class extends Set<unknown> {
      constructor(values?: Iterable<unknown> | null) {
        super(values);
        if (typeof values == 'string') collectedCharacters += values.length;
      }
    },
    RegExp: function(pattern: string, flags: string) {
      coverageCompilations++;
      if (coverageUnavailable) throw new Error('Unavailable coverage expression');
      return new RegExp(pattern, flags);
    },
    process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    queueMicrotask,
    require: (name: string) => {
      if (name == 'path') return path;
      if (name != 'child_process') return require(name);
      return { execFile: (_file: string, _args: string[], _options: unknown,
        callback: (error: Error | null, stdout: string) => void) => {
        const launch: Launch = {
          finish: (error, result = {}) => callback(error || null,
            typeof result == 'string' ? result : JSON.stringify(result)),
        };
        launches.push(launch);
        return { stdin: {
          on() {},
          end(payload: string) { launch.request = JSON.parse(payload); },
        } };
      } };
    },
  });
  return { getWidths: exported.getFontCharacterWidths!, launches,
    collectedCharacters: () => collectedCharacters, coverageCompilations: () => coverageCompilations };
}

function font(family: string): EditorFont {
  return { family, size: 14, weight: 'normal', letterSpacing: 0 };
}

function measured(launch: Launch, width = 1) {
  return Object.fromEntries(launch.request!.characters.map((character) => [character, width]));
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function testMergedRequests() {
  const { getWidths, launches } = loadFontMetrics();
  const first = getWidths(font('A'), 'α');
  const second = getWidths(font('A'), 'β');
  await flush();
  assert.strictEqual(launches.length, 1, 'same-font queued glyphs launch once');
  assert.ok(launches[0].request!.characters.includes('α'));
  assert.ok(launches[0].request!.characters.includes('β'));
  launches[0].finish(undefined, measured(launches[0]));
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a.get('α'), 1);
  assert.strictEqual(b.get('β'), 1);
  a.set('mutated', 2);
  assert.ok(!b.has('mutated'), 'callers receive isolated maps');
}

async function testFourFontCache() {
  const { getWidths, launches } = loadFontMetrics();
  for (let index = 1; index <= 5; index++) {
    const result = getWidths(font(`Font ${index}`), 'x');
    await flush();
    launches[index - 1].finish(undefined, measured(launches[index - 1], index));
    await result;
  }
  assert.strictEqual((await getWidths(font('Font 2'), 'x')).get('x'), 2,
    'the four most recent fonts remain cached');
  assert.strictEqual(launches.length, 5);
  const evicted = getWidths(font('Font 1'), 'x');
  await flush();
  assert.strictEqual(launches.length, 6, 'the fifth-oldest font is evicted');
  launches[5].finish(undefined, measured(launches[5], 6));
  await evicted;
}

async function testObsoleteQueueAndFontSwitching() {
  const { getWidths, launches } = loadFontMetrics();
  let current = true;
  const active = getWidths(font('A'), 'a');
  await flush();
  const obsolete = getWidths(font('B'), 'b', () => current);
  current = false;
  launches[0].finish(undefined, measured(launches[0]));
  await active;
  assert.deepStrictEqual([...(await obsolete)], []);
  assert.strictEqual(launches.length, 1, 'obsolete queued font work never launches');

  const switched = getWidths(font('C'), 'c');
  await flush();
  assert.strictEqual(launches.length, 2, 'a current font still launches after cancellation');
  launches[1].finish(undefined, measured(launches[1], 3));
  assert.strictEqual((await switched).get('c'), 3);
}

async function testFailureFallbacks() {
  const { getWidths, launches } = loadFontMetrics();
  const processError = getWidths(font('Error'), 'e');
  await flush();
  launches[0].finish(new Error('blocked'));
  assert.deepStrictEqual([...(await processError)], []);
  assert.deepStrictEqual([...(await getWidths(font('Error'), 'e'))], [],
    'failed glyphs stay cached as fallback widths');
  assert.strictEqual(launches.length, 1);

  const invalid = getWidths(font('Invalid'), 'i');
  await flush();
  launches[1].finish(undefined, { ...measured(launches[1]), i: 0 });
  assert.deepStrictEqual([...(await invalid)], []);
  assert.strictEqual(launches.length, 2);

  const afterFailure = getWidths(font('Healthy'), 'h');
  await flush();
  launches[2].finish(undefined, measured(launches[2], 4));
  assert.strictEqual((await afterFailure).get('h'), 4, 'one failed request does not poison later promises');
}

async function testQueuedGlyphFiltering() {
  const { getWidths, launches } = loadFontMetrics();
  const active = getWidths(font('A'), 'a');
  await flush();
  let current = true;
  const obsolete = getWidths(font('A'), '\u03b1', () => current);
  const fresh = getWidths(font('A'), '\u03b2');
  const throwing = getWidths(font('A'), '\u03b3', () => { throw new Error('disposed'); });
  current = false;
  launches[0].finish(undefined, measured(launches[0]));
  await active;
  await flush();
  assert.strictEqual(launches.length, 2, 'queued same-font requests share one follow-up process');
  assert.deepStrictEqual(launches[1].request!.characters, ['\u03b2'],
    'only current, still-missing glyphs reach the native process');
  launches[1].finish(undefined, measured(launches[1], 2));
  const results = await Promise.all([obsolete, fresh, throwing]);
  assert.strictEqual(results[1].get('\u03b2'), 2);
  assert.ok(results.every((widths) => !widths.has('\u03b1') && !widths.has('\u03b3')));
  const invalid = getWidths(font('A'), '\u03b4');
  await flush();
  launches[2].finish(undefined, '{broken');
  const afterInvalid = await invalid;
  assert.strictEqual(afterInvalid.get('\u03b2'), 2, 'a failed delta preserves prior valid measurements');
  assert.ok(!afterInvalid.has('\u03b4'), 'invalid JSON uses fallback');
  await getWidths(font('A'), '\u03b4');
  assert.strictEqual(launches.length, 3, 'invalid delta is not repeatedly launched');
}

async function testCachedGlyphCoverage() {
  const { getWidths, launches, collectedCharacters } = loadFontMetrics();
  const known = 'x[]^-\\😀α\ud800A\udc00';
  const first = getWidths(font('Coverage'), known);
  await flush();
  launches[0].finish(undefined, measured(launches[0]));
  await first;
  const before = collectedCharacters();
  const hit = await getWidths(font('Coverage'), (known + '\u0301\n\t\0').repeat(200));
  assert.strictEqual(hit.get('😀'), 1);
  assert.strictEqual(hit.get('\ud800'), 1);
  assert.strictEqual(collectedCharacters(), before, 'cache hits should avoid enumerating known body glyphs');
  assert.strictEqual(launches.length, 1);

  const missing = getWidths(font('Coverage'), known + 'β');
  await flush();
  assert.deepStrictEqual(launches[1].request!.characters, ['β'], 'only missing glyphs are measured');
  launches[1].finish(undefined, measured(launches[1], 2));
  assert.strictEqual((await missing).get('β'), 2);
  const afterDelta = collectedCharacters();
  const updated = await getWidths(font('Coverage'), (known + 'β').repeat(200));
  assert.strictEqual(collectedCharacters(), afterDelta, 'new measurements refresh cached coverage');
  updated.set('β', 99);
  assert.strictEqual((await getWidths(font('Coverage'), 'β')).get('β'), 2, 'coverage hits still return isolated maps');

  const failed = getWidths(font('Coverage'), 'γ');
  await flush();
  launches[2].finish(new Error('blocked'));
  await failed;
  const afterFailure = collectedCharacters();
  assert.ok(!(await getWidths(font('Coverage'), 'γ'.repeat(200))).has('γ'));
  assert.strictEqual(collectedCharacters(), afterFailure, 'failed glyphs use cached fallback coverage');
  assert.strictEqual(launches.length, 3, 'coverage does not retry failed native glyphs');
}

async function testCoverageFallback() {
  const { getWidths, launches, collectedCharacters, coverageCompilations } = loadFontMetrics(true);
  const initial = getWidths(font('Fallback'), 'x');
  await flush();
  launches[0].finish(undefined, measured(launches[0]));
  await initial;
  const before = collectedCharacters();
  assert.strictEqual((await getWidths(font('Fallback'), 'xx')).get('x'), 1);
  assert.strictEqual((await getWidths(font('Fallback'), 'xxx')).get('x'), 1);
  assert.ok(collectedCharacters() > before, 'unavailable coverage uses the original collector');
  assert.strictEqual(coverageCompilations(), 1, 'failed coverage compilation is not retried on each hit');
  assert.strictEqual(launches.length, 1);
  const missing = getWidths(font('Fallback'), 'δ');
  await flush();
  assert.deepStrictEqual(launches[1].request!.characters, ['δ']);
  launches[1].finish(undefined, measured(launches[1], 2));
  assert.strictEqual((await missing).get('δ'), 2, 'unavailable coverage still measures new glyphs');
  assert.strictEqual((await getWidths(font('Fallback'), 'δ')).get('δ'), 2);
  assert.strictEqual(coverageCompilations(), 2, 'new measurements allow coverage to be rebuilt');
}

async function main() {
  await testCachedGlyphCoverage();
  await testCoverageFallback();
  await testQueuedGlyphFiltering();
  await testMergedRequests();
  await testFourFontCache();
  await testObsoleteQueueAndFontSwitching();
  await testFailureFallbacks();
  console.log('font scheduling merge, cache, cancellation and fallback tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
