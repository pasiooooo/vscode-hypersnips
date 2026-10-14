import * as assert from 'assert';
import { getFontCharacterWidths } from '../src/fontMetrics';
import { getAlignmentEdits } from '../src/latexAlignment';
import { applyTextEditsToString } from '../src/latexEdit';

export async function testFontMetrics() {
  if (process.platform != 'win32') return;
  let font = { family: 'Consolas, monospace', size: 14, weight: 'normal', letterSpacing: 0 };
  let mono = await getFontCharacterWidths(font, '示例 iW');
  assert.strictEqual(mono.get(' '), 1, 'native font measurement must succeed');
  assert.strictEqual(mono.get('i'), mono.get('W'));
  assert.ok(mono.get('示')! > mono.get('i')!);
  assert.deepStrictEqual(await getFontCharacterWidths(font, '示例 iW'), mono, 'reuse cached widths');

  let source = String.raw`\begin{tabular}{ll}
  iii & 示例 \\ % one
  WWW & 演示文字 \\ % two
\end{tabular}`;
  let proportional = await getFontCharacterWidths({ ...font, family: 'Arial' }, source);
  assert.ok(proportional.get('W')! > proportional.get('i')! * 2, 'use actual Latin glyph widths');
  assert.notStrictEqual(proportional.get('W'), proportional.get('w'), 'font keys are case sensitive');
  let offset = source.indexOf('\n') + 1;
  let edits = getAlignmentEdits(source, offset, {}, 4, proportional);
  let result = applyTextEditsToString(source, edits);
  assert.deepStrictEqual(getAlignmentEdits(result, offset, {}, 4, proportional), [], 'measured alignment is stable');
  assert.strictEqual(result.replace(/ /g, ''), source.replace(/ /g, ''));
  let rows = result.split('\n').slice(1, 3);
  for (let symbol of ['&', '\\\\', '%']) {
    let positions = rows.map((row) => [...row.slice(0, row.indexOf(symbol))]
      .reduce((sum, char) => sum + proportional.get(char)!, 0));
    assert.ok(Math.abs(positions[0] - positions[1]) <= 1,
      `${symbol} must align within one space using measured glyph widths`);
  }
}
