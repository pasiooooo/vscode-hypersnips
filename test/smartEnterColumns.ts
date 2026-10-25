import * as assert from 'assert';
import { LatexDocumentState } from '../src/latexDocumentState';
import { applyTextEditsToString, getSmartEnterPlan, getSmartEnterRecoveryPlan, LatexContextOptions } from '../src/latexEdit';

function marked(source: string) {
  const offset = source.indexOf('<cursor>');
  assert.ok(offset >= 0);
  return { text: source.replace('<cursor>', ''), offset };
}

function check(source: string, expected: string, enabled = true, options: LatexContextOptions = {}) {
  const { text, offset } = marked(source);
  for (const snapshot of [undefined, new LatexDocumentState(text, 1, options)]) {
    const plan = getSmartEnterPlan(text, offset, options, snapshot, enabled);
    assert.ok(plan.handled, source);
    const updated = applyTextEditsToString(text, plan.edits);
    assert.equal(updated.slice(0, plan.cursorOffset) + '<cursor>' + updated.slice(plan.cursorOffset), expected);
    const plainEnter = text.slice(0, offset) + (text.includes('\r\n') ? '\r\n' : '\n') + text.slice(offset);
    const recovery = getSmartEnterRecoveryPlan(text, offset, plainEnter, options, snapshot, enabled);
    assert.ok(recovery.handled, 'native Enter recovery must produce the same completion');
    assert.equal(applyTextEditsToString(plainEnter, recovery.edits), updated);
    assert.equal(recovery.cursorOffset, plan.cursorOffset);
  }
}

for (const [row, completed] of [
  ['Alpha', 'Alpha & &'],
  ['Alpha & Beta', 'Alpha & Beta &'],
  ['Alpha & Beta & Gamma', 'Alpha & Beta & Gamma'],
  ['Alpha & Beta & Gamma & Delta', 'Alpha & Beta & Gamma & Delta'],
]) {
  check(`\\begin{tabular}{lcr}\n  ${row}<cursor>\n\\end{tabular}`,
    `\\begin{tabular}{${row.includes('Delta') ? 'lcrl' : 'lcr'}}\n  ${completed} \\\\\n  <cursor>\n\\end{tabular}`);
}
check(String.raw`\begin{tabular}{lcr}
  Alpha & Beta<cursor>
\end{tabular}`, String.raw`\begin{tabular}{lcr}
  Alpha & Beta \\
  <cursor>
\end{tabular}`, false);
check(String.raw`\begin{tabular}[t]{*{2}{lr}p{2cm}}
  Alpha<cursor>
\end{tabular}`, String.raw`\begin{tabular}[t]{*{2}{lr}p{2cm}}
  Alpha & & & & \\
  <cursor>
\end{tabular}`);
check(String.raw`\begin{array}{cccc}
  \multicolumn{2}{c}{Demo} & value<cursor>
\end{array}`, String.raw`\begin{array}{cccc}
  \multicolumn{2}{c}{Demo} & value & \\
  <cursor>
\end{array}`);
check(String.raw`\begin{tabular}{ccc}
  A\&B & \text{C & D}<cursor> % note & ignored
\end{tabular}`, String.raw`\begin{tabular}{ccc}
  A\&B & \text{C & D} & \\ % note & ignored
  <cursor>
\end{tabular}`);
for (const suffix of ['\\\\', '\\\\*', '\\\\[2pt]', '\\\\*[2pt]', '\\tabularnewline', '\\tabularnewline[2pt]']) {
  check(`\\begin{tabular}{ccc}\n  Alpha ${suffix}<cursor> % note\n\\end{tabular}`,
    `\\begin{tabular}{ccc}\n  Alpha & & ${suffix} % note\n  <cursor>\n\\end{tabular}`);
}
check(String.raw`\begin{matrix}
  a & b & c \\
  d & e<cursor>
\end{matrix}`, String.raw`\begin{matrix}
  a & b & c \\
  d & e & \\
  <cursor>
\end{matrix}`);
check(String.raw`\begin{demoalign}
  a & b \\
  c<cursor>
\end{demoalign}`, String.raw`\begin{demoalign}
  a & b \\
  c & \\
  <cursor>
\end{demoalign}`, true, { extraAlignmentEnvironments: ['demoalign'] });
check(String.raw`\begin{tabular}{Zc}
  Alpha<cursor>
\end{tabular}`, String.raw`\begin{tabular}{Zc}
  Alpha \\
  <cursor>
\end{tabular}`);
check(String.raw`\begin{tabular}{lc}
  a & b \tabularnewline
  c & d \tabularnewline
  z<cursor>
\end{tabular}`, String.raw`\begin{tabular}{lc}
  a & b \tabularnewline
  c & d \tabularnewline
  z & \\
  <cursor>
\end{tabular}`);
check(String.raw`\begin{tabular}{lc}
  a & b & c \\
  d<cursor>
\end{tabular}`, String.raw`\begin{tabular}{lcl}
  a & b & c \\
  d & & \\
  <cursor>
\end{tabular}`);
for (const comment of ['', ' % note']) {
  check(`\\begin{tabular}{lc}\n  a & b & c \\\\\n  d<cursor>${comment}\n\\end{tabular}`.replace(/\n/g, '\r\n'),
    `\\begin{tabular}{lcl}\n  a & b & c \\\\\n  d & & \\\\${comment}\n  <cursor>\n\\end{tabular}`.replace(/\n/g, '\r\n'));
}
check(String.raw`\begin{tabular}{lcrrr}
  a & b & c \\
  d<cursor>
\end{tabular}`, String.raw`\begin{tabular}{lcrrr}
  a & b & c \\
  d & & \\
  <cursor>
\end{tabular}`);
check(String.raw`\begin{tabular}{|lc|}
  a & b & c \\[2pt]<cursor> % note
\end{tabular}`, String.raw`\begin{tabular}{|lcl|}
  a & b & c \\[2pt] % note
  <cursor>
\end{tabular}`);

for (let fixture = 0; fixture < 35; fixture++) {
  const declared = 1 + fixture % 7;
  const peerColumns = 2 + (fixture * 3) % 6;
  const currentColumns = 1 + (fixture * 5) % 8;
  const target = Math.max(peerColumns, currentColumns);
  const spec = 'c'.repeat(declared);
  const grown = spec + 'l'.repeat(Math.max(0, target - declared));
  const peer = Array.from({ length: peerColumns }, (_, index) => `p${index}`).join(' & ');
  const row = Array.from({ length: currentColumns }, (_, index) => `q${index}`).join(' & ');
  check(`\\begin{tabular}{${spec}}\n${peer} \\\\\n${row}<cursor>\n\\end{tabular}`,
    `\\begin{tabular}{${grown}}\n${peer} \\\\\n${row}${' &'.repeat(target - currentColumns)} \\\\\n<cursor>\n\\end{tabular}`);
}

for (const source of [
  String.raw`\begin{tabular}{cc}
  a<cursor>b
\end{tabular}`,
  String.raw`\begin{tabular}{cc}
  % note<cursor>
\end{tabular}`,
  String.raw`\begin{tabular}{cc}
  a & b \\<cursor>
\end{tabular}`,
  String.raw`\begin{tabular}{cc}
  <cursor>
\end{tabular}`,
]) {
  const { text, offset } = marked(source);
  assert.equal(getSmartEnterPlan(text, offset, {}, new LatexDocumentState(text), true).handled, false);
}

console.log('Smart Enter column completion: exact text/caret, recovery, switch and snapshot parity passed.');
