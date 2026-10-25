import * as assert from 'assert';
import { getAlignmentColumnCompletion } from '../src/latexColumns';
import { getLatexContext } from '../src/latexContext';
import { LatexDocumentState } from '../src/latexDocumentState';

function missing(source: string, expected: number, snapshot = false) {
  const offset = source.lastIndexOf('|');
  assert.ok(offset >= 0, 'fixture needs a cursor marker');
  const text = source.slice(0, offset) + source.slice(offset + 1);
  const state = snapshot ? new LatexDocumentState(text) : undefined;
  const context = state ? state.contextAt(offset) : getLatexContext(text, offset);
  const frame = context.currentEnvironmentFrame;
  assert.ok(frame, source);
  assert.strictEqual(getAlignmentColumnCompletion(text, offset, frame!, state).missing, expected, source);
}

for (const snapshot of [false, true]) {
  for (const [source, expected] of [
    [String.raw`\begin{tabular}{lcr} first|\end{tabular}`, 2],
    [String.raw`\begin{array}{ccc} first & second|\end{array}`, 1],
    [String.raw`\begin{tabular}{cc} first & second & third|\end{tabular}`, 0],
    [String.raw`\begin{tabular}[t]{|l|c|r|} first|\end{tabular}`, 2],
    [String.raw`\begin{tabular*}{\linewidth}[t]{cc} first|\end{tabular*}`, 1],
    [String.raw`\begin{tabularx}[b]{\linewidth}{lXr} first|\end{tabularx}`, 2],
    [String.raw`\begin{longtable}{p{2cm}m{3cm}b{4cm}} first|\end{longtable}`, 2],
    [String.raw`\begin{tabular}{>{\bfseries}l@{\quad}c!{\vrule}<{}r} first|`, 2],
    [String.raw`\begin{array}{*{2}{c*{2}{r}}} first|`, 5],
    [String.raw`\begin{tabular}{cc} \multicolumn{2}{c}{wide}|`, 0],
    [String.raw`\begin{tabular}{cccc} \multicolumn{2}{c}{wide} & value|`, 1],
    [String.raw`\begin{tabular}{cccc} value & \multicolumn{2}{c}{wide}|`, 1],
    [String.raw`\begin{tabular}{ccc} escaped\&value & {group&value}|`, 1],
    [String.raw`\begin{tabular}{ccc} \begin{matrix}a&b\\c&d\end{matrix}|`, 2],
    [String.raw`\begin{tabular}{ccc} \verb!a&b!|`, 0],
    [String.raw`\begin{tabular}{ccc} \multicolumn{\count}{c}{wide}|`, 0],
    [String.raw`\begin{tabular}{ccc} \multicolumn{0}{c}{wide}|`, 0],
    [String.raw`\begin{tabular}{ccc} \multicolumn{2}{c}|`, 0],
    [String.raw`\begin{tabular}{ccc} text \multicolumn{2}{c}{wide}|`, 0],
    [String.raw`\begin{array}{cQ} a&b&c\\ first|\end{array}`, 0],
    [String.raw`\begin{tabular}{\unknown} a&b&c\\ first|`, 0],
    [String.raw`\begin{array}{*{\count}{c}} first|`, 0],
    [String.raw`\begin{array}{*{0}{c}} first|`, 0],
    [String.raw`\begin{array}{*{1025}{c}} first|`, 0],
    [String.raw`\begin{array}{*{1024}{c}} first|`, 1023],
    [String.raw`\begin{array}{p} first|`, 0],
    [String.raw`\begin{tabular} first|`, 0],
    [String.raw`\begin{cases} first|`, 1],
    [String.raw`\begin{alignedat}{2} first|`, 3],
    [String.raw`\begin{alignedat}[t]{2} first & second|`, 2],
    [String.raw`\begin{alignedat}{\count} first|`, 0],
    [String.raw`\begin{matrix} a&b&c\\ first|\end{matrix}`, 2],
    [String.raw`\begin{matrix} first|\\ a&b&c\\\end{matrix}`, 2],
    [String.raw`\begin{matrix} first|\\ a&b&c\\`, 0],
    [String.raw`\begin{matrix} a&b&c\\ first|`, 2],
    [String.raw`\begin{matrix} a&b\\ first| & later text`, 1],
    [String.raw`\begin{matrix} first|\end{matrix}`, 0],
    [String.raw`\begin{align} a&=b\\ c&=d&e\\ first|\end{align}`, 2],
    [String.raw`\begin{matrix} a&b\\ \multicolumn{\n}{c}{x}&c&d\\ first|`, 1],
    [String.raw`\begin{matrix} \hline \cline{1-2} \toprule \midrule \bottomrule \noalign{&} first|`, 0],
    [String.raw`\begin{tabular}{ccc} \toprule[1pt]|`, 0],
    [String.raw`\begin{tabular}{ccc} \midrule[.5pt]|`, 0],
    [String.raw`\begin{tabular}{ccc} \bottomrule[1pt]|`, 0],
    [String.raw`\begin{tabular}{ccc} \addlinespace[2pt]|`, 0],
    [String.raw`\begin{tabular}{ccc} \addlinespace|`, 0],
    [String.raw`\begin{tabular}{ccc} \cmidrule(lr){1-2}|`, 0],
    [String.raw`\begin{tabular}{ccc} \cmidrule[.5pt](lr){1-2}|`, 0],
    [String.raw`\begin{tabular}{ccc} \cmidrule[.5pt](lr){1-2} first|`, 2],
    [String.raw`\begin{tabular}{ccc} \cmidrule[.5pt](lr) first|`, 0],
    [String.raw`\begin{longtable}{ccc} \endfirsthead|`, 0],
    [String.raw`\begin{longtable}{ccc} \endhead|`, 0],
    [String.raw`\begin{longtable}{ccc} \endfoot|`, 0],
    [String.raw`\begin{longtable}{ccc} \endlastfoot|`, 0],
    [String.raw`\begin{longtable}{ccc} \caption[Short]{Example title}\label{tab:example}|`, 0],
    [String.raw`\begin{longtable}{ccc} \caption*{Example title}|`, 0],
    [String.raw`\begin{tabular}{ccc} \specialrule{1pt}{2pt}{2pt}|`, 0],
    [String.raw`\begin{tabular}{ccc} \span first|`, 0],
    [String.raw`\begin{tabular}{ccc} \multispan{2} first|`, 0],
    [String.raw`\begin{tabular}{ccc} \omit first|`, 0],
    [String.raw`\begin{matrix} a&b\\ \hline first|\end{matrix}`, 1],
    [String.raw`\begin{matrix} a&b&c\\ first & second|\\ x&y\\\end{matrix}`, 1],
    [String.raw`\begin{tabular}{ccc} first| \\[2pt] % note
\end{tabular}`, 2],
    [String.raw`\begin{tabular}{cc} first| % & ignored
\end{tabular}`, 1],
    [String.raw`\begin{tabular}{c% format comment
c} first|`, 1],
    [String.raw`\begin{tabular}[t]% argument comment
{cc} first|`, 1],
    [String.raw`\begin{matrix} first &
second & third \\
next|\end{matrix}`, 2],
    [String.raw`\begin{matrix} a & \begin{matrix} b&c\\ d&e\end{matrix}\\ first|\end{matrix}`, 1],
  ] as [string, number][]) missing(source, expected, snapshot);
}

missing('\\begin{array}{' + '*{1}{'.repeat(20) + 'c' + '}'.repeat(20) + '} first|', 0);
const fakeFrame = { name: 'array', beginStart: 0, beginEnd: 100, nameStart: 7, nameEnd: 12 };
assert.strictEqual(getAlignmentColumnCompletion('short', 3, fakeFrame).missing, 0);

for (const [spec, grown, peer, row, padding] of [
  ['lc', 'lcl', 'a&b&c', 'd', 2],
  ['lcrrr', 'lcrrr', 'a&b&c', 'd', 2],
  ['|lc|', '|lcl|', 'a&b&c', 'd', 2],
  ['*{2}{c}||', '*{2}{c}l||', 'a&b&c', 'd', 2],
  ['lc', 'lcll', 'a&b', 'c&d&e&f', 0],
] as [string, string, string, string, number][]) {
  const source = `\\begin{tabular}{${spec}}\n${peer} \\\\\n${row}\n\\end{tabular}`;
  const offset = source.indexOf('\n' + row) + 1 + row.length;
  const state = new LatexDocumentState(source);
  const completion = getAlignmentColumnCompletion(source, offset, state.contextAt(offset).currentEnvironmentFrame!, state);
  assert.equal(completion.missing, padding);
  const edit = completion.columnSpecEdit;
  const updated = edit ? source.slice(0, edit.start) + edit.text + source.slice(edit.end) : source;
  assert.equal(updated, source.replace(`{${spec}}`, `{${grown}}`));
}
console.log('Alignment columns: declarations, spans, logical rows, peers, uncertainty and bounds passed.');
