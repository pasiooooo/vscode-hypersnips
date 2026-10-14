import * as assert from 'assert';
import { getAlignmentEdits, mapAlignmentOffset } from '../src/latexAlignment';
import { applyTextEditsToString } from '../src/latexEdit';
import { ALIGNMENT_SEPARATOR_ENVIRONMENTS, LatexContextOptions } from '../src/latexContext';

function format(text: string, options: LatexContextOptions = {}, tabSize = 4) {
  let offset = text.indexOf('\n') + 1;
  let result = applyTextEditsToString(text, getAlignmentEdits(text, offset, options, tabSize));
  assert.deepStrictEqual(getAlignmentEdits(result, offset, options, tabSize), [], 'formatting is stable');
  assert.strictEqual(result.replace(/[ \t]/g, ''), text.replace(/[ \t]/g, ''), 'only whitespace changes');
  return result;
}

export function testLatexAlignment() {
  let table = String.raw`\begin{tabular}{llll}
      示例机构甲 & 测试人员甲 & 示例城 & DEMO           \\
      Demo Lab             & Sample Person & Demo City     &      \\
\end{tabular}`;
  assert.strictEqual(format(table), String.raw`\begin{tabular}{llll}
      示例机构甲 & 测试人员甲    & 示例城    & DEMO \\
      Demo Lab   & Sample Person & Demo City &      \\
\end{tabular}`);

  assert.strictEqual(format(String.raw`\begin{align}
  a+b &= c-d \\ %first
  longer + beta &= gamma - delta \\[2pt]    % second & ignored + =
\end{align}`), String.raw`\begin{align}
  a      + b    & = c     - d     \\      %first
  longer + beta & = gamma - delta \\[2pt] % second & ignored + =
\end{align}`);

  let comments = String.raw`\begin{tabular}{ll}
  A-B & 10\% \\%no added space inside comment
  Longer & 20\% \\     % second
  % standalone comment stays put
\end{tabular}`;
  let formattedComments = String.raw`\begin{tabular}{ll}
  A-B    & 10\% \\ %no added space inside comment
  Longer & 20\% \\ % second
  % standalone comment stays put
\end{tabular}`;
  assert.strictEqual(format(comments), formattedComments);
  assert.strictEqual(applyTextEditsToString(comments,
    getAlignmentEdits(comments, comments.indexOf('second') + 3)), formattedComments);

  let tableMath = String.raw`\begin{tabular}{ll}
  A-B & $a+b$ \\
  Longer & $longer-c$ \\
\end{tabular}`;
  assert.strictEqual(format(tableMath), String.raw`\begin{tabular}{ll}
  A-B    & $a      + b$ \\
  Longer & $longer - c$ \\
\end{tabular}`);

  let protectedContent = String.raw`\begin{align}
  \text{a+b & c = d} &= x^{-1} \\ % leave & + = alone
  z &= -1 \\
\end{align}`;
  let protectedResult = format(protectedContent);
  assert.ok(protectedResult.includes(String.raw`\text{a+b & c = d}`));
  assert.ok(protectedResult.includes(String.raw`x^{-1}`));
  assert.ok(protectedResult.includes('% leave & + = alone'));
  assert.ok(protectedResult.includes('= -1'));

  let optionalArguments = String.raw`\begin{align}
  a&=\sqrt[n+1]{b} \\[1+2pt] %comment
  long&=x \\*[3pt]
\end{align}`;
  let optionalResult = format(optionalArguments);
  assert.ok(optionalResult.includes(String.raw`\sqrt[n+1]{b}`));
  assert.ok(optionalResult.includes(String.raw`\\[1+2pt]`));
  assert.ok(optionalResult.includes(String.raw`\\*[3pt]`));

  let verb = String.raw`\begin{align}
  \verb|a&b=1| \\
  a&b \\
  longer&c \\
\end{align}`;
  assert.ok(format(verb).includes(String.raw`  \verb|a&b=1| \\`));
  let wideSpace = '\\begin{matrix}\n  a\u3000&b \\\\\n  long&c \\\\\n\\end{matrix}';
  assert.ok(format(wideSpace).includes('a\u3000'));

  for (let environment of [...ALIGNMENT_SEPARATOR_ENVIRONMENTS, 'custom']) {
    let source = `\\begin{${environment}}\n  a&b \\\\\n  longer&c \\\\\n\\end{${environment}}`;
    let expected = `\\begin{${environment}}\n  a      & b \\\\\n  longer & c \\\\\n\\end{${environment}}`;
    assert.strictEqual(format(source, { extraAlignmentEnvironments: ['custom'] }), expected, environment);
  }

  let nested = String.raw`\begin{align}
  a&=1 \\
  \begin{matrix}
    a&b \\
    longer&c \\
  \end{matrix} \\
  long&=2 \\
\end{align}`;
  let nestedResult = format(nested);
  assert.ok(nestedResult.includes('    a&b'));
  assert.ok(nestedResult.includes('  a    & = 1'));
  let inner = applyTextEditsToString(nested, getAlignmentEdits(nested, nested.indexOf('a&b')));
  assert.ok(inner.includes('    a      & b'));
  assert.ok(inner.includes('  a&=1'));

  for (let source of [
    'plain a&b\nlonger&c',
    String.raw`\begin{equation}
a&b \\
longer&c \\
\end{equation}`,
    '```latex\n' + table + '\n```',
    '\\begin{verbatim}\n' + table + '\n\\end{verbatim}',
  ]) {
    assert.deepStrictEqual(getAlignmentEdits(source, source.indexOf('&')), []);
  }
  let crlf = table.replace(/\n/g, '\r\n');
  assert.strictEqual(format(crlf), format(table).replace(/\n/g, '\r\n'));
  let tabs = '\\begin{matrix}\n\ta&b \\\\\n\tlong&c \\\\\n\\end{matrix}';
  assert.strictEqual(format(tabs, {}, 8), '\\begin{matrix}\n\ta    & b \\\\\n\tlong & c \\\\\n\\end{matrix}');

  let cursorSource = '\\begin{matrix}\n  a&b \\\\\n  long&c \\\\\n\\end{matrix}';
  let cursorEdits = getAlignmentEdits(cursorSource, cursorSource.indexOf('a&'));
  let cursorResult = applyTextEditsToString(cursorSource, cursorEdits);
  let afterA = mapAlignmentOffset(cursorSource.indexOf('a&') + 1, cursorEdits);
  assert.strictEqual(cursorResult[afterA - 1], 'a');
  let afterC = mapAlignmentOffset(cursorSource.indexOf('&c') + 2, cursorEdits);
  assert.strictEqual(cursorResult[afterC - 1], 'c');
  assert.strictEqual(mapAlignmentOffset(5, [{ start: 3, end: 8, text: ' ' }]), 4);
  assert.strictEqual(mapAlignmentOffset(8, [{ start: 3, end: 8, text: ' ' }]), 4);
}
