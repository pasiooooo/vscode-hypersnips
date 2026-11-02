import * as assert from 'assert';
import { getAutoAlignmentEdits } from '../src/latexAlignment';
import { getAlignmentColumnCompletion, getAlignmentStructure } from '../src/latexColumns';
import { getLatexContext, LatexContextOptions, resolveLatexContextOptions } from '../src/latexContext';
import { LatexDocumentState } from '../src/latexDocumentState';
import { applyTextEditsToString, getSmartEnterPlan, getSmartTabPlan } from '../src/latexEdit';

const cases = ['cases', 'cases*', 'dcases', 'dcases*', 'rcases', 'rcases*', 'drcases', 'drcases*'];
const matrices = ['', 'p', 'b', 'B', 'v', 'V'].flatMap((prefix) =>
  [`${prefix}matrix`, `${prefix}matrix*`, `${prefix}smallmatrix`, `${prefix}smallmatrix*`]);
const alignats = ['alignat', 'alignat*', 'xalignat', 'xalignat*', 'xxalignat', 'alignedat', 'alignedat*'];
const displays = ['align', 'align*', 'aligned', 'flalign', 'flalign*', 'eqnarray', 'eqnarray*', 'split'];
const tables = ['array', 'tabular', 'tabular*', 'tabularx', 'longtable'];
const rowOnly = ['gather', 'gather*', 'gathered', 'lgathered', 'rgathered', 'multline', 'multline*', 'multlined'];
const alignment = [...cases, ...matrices, ...alignats, ...displays, ...tables];

function argumentsFor(name: string) {
  if (alignats.includes(name)) return name.startsWith('alignedat') ? '[t]{2}' : '{2}';
  if (tables.includes(name)) return name === 'tabular*' || name === 'tabularx' ? '{\\linewidth}[t]{cc}' : '[t]{cc}';
  if (matrices.includes(name) && name.endsWith('*')) return '[r]';
  return name === 'aligned' ? '[t]' : '';
}

function fixture(name: string, body: string, args = argumentsFor(name)) {
  return `\\begin{${name}}${args}\n${body}\n\\end{${name}}`;
}

function marked(source: string) {
  const offset = source.indexOf('<cursor>');
  assert.ok(offset >= 0, source);
  return { text: source.replace('<cursor>', ''), offset };
}

function snapshots(text: string, options: LatexContextOptions = {}) {
  // Exercise a prefix edit on a live snapshot as well as a fresh full parse.
  const initial = new LatexDocumentState('prefix\n' + text, 1, options);
  return [undefined, new LatexDocumentState(text, 1, options),
    initial.update([{ rangeOffset: 0, rangeLength: 7, text: '' }])];
}

for (const name of [...alignment, ...rowOnly]) {
  const { text, offset } = marked(fixture(name, 'a<cursor> & b \\\\'));
  const full = getLatexContext(text, offset);
  assert.equal(full.currentEnvironment, name);
  assert.equal(full.inMath, true, `${name}: preserve environment math inference`);
  assert.equal(full.canSmartEnter, true, `${name}: row breaks`);
  assert.equal(full.canSmartTab, alignment.includes(name), `${name}: actual alignment capability`);
  assert.equal(full.canInsertAlignmentSeparator, alignment.includes(name));
  for (const snapshot of snapshots(text)) {
    assert.deepStrictEqual(getLatexContext(text, offset, {}, snapshot), full, name);
    assert.equal(getLatexContext(text, text.length, {}, snapshot).inMath, false, `${name}: closed environment`);
    const tab = getSmartTabPlan(text, offset, {}, snapshot);
    if (alignment.includes(name)) {
      assert.ok(tab, name);
      assert.equal(tab!.cursorOffset, text.indexOf('b \\\\'), `${name}: navigate to next cell`);
      assert.equal(applyTextEditsToString(text, tab!.edits), text, `${name}: existing separator`);
    } else assert.equal(tab, undefined, `${name}: Tab must not insert &`);
  }
  const placeholder = text.replace(`{${name}}`, '{unknown}').replace(`\\end{${name}}`, '\\end{unknown}');
  const renamed = new LatexDocumentState(placeholder).update([
    { rangeOffset: placeholder.indexOf('{unknown}') + 1, rangeLength: 7, text: name },
    { rangeOffset: placeholder.lastIndexOf('{unknown}') + 1, rangeLength: 7, text: name },
  ]);
  assert.equal(renamed.text, text);
  assert.deepStrictEqual(renamed.contextAt(offset), full, `${name}: environment name update`);

  if (alignment.includes(name)) {
    const insert = marked(fixture(name, 'a<cursor>b'));
    for (const snapshot of snapshots(insert.text)) {
      const plan = getSmartTabPlan(insert.text, insert.offset, {}, snapshot)!;
      assert.ok(plan, name);
      const result = applyTextEditsToString(insert.text, plan.edits);
      assert.equal(result.slice(0, plan.cursorOffset) + '<cursor>' + result.slice(plan.cursorOffset),
        fixture(name, 'a & <cursor>b'), `${name}: insert separator`);
    }
  }

  const enter = marked(fixture(name, 'a<cursor>'));
  for (const snapshot of snapshots(enter.text)) {
    const plan = getSmartEnterPlan(enter.text, enter.offset, {}, snapshot);
    assert.ok(plan.handled, `${name}: Smart Enter`);
    const result = applyTextEditsToString(enter.text, plan.edits);
    assert.equal(result.slice(0, plan.cursorOffset) + '<cursor>' + result.slice(plan.cursorOffset),
      fixture(name, 'a \\\\\n<cursor>'), name);
  }

  const source = fixture(name, 'a&b\\\\\nlong&c\\\\');
  const active = source.indexOf('long');
  for (const snapshot of snapshots(source)) {
    const edits = getAutoAlignmentEdits(source, active, {}, 4, new Map(), snapshot);
    assert.equal(applyTextEditsToString(source, edits), alignment.includes(name)
      ? fixture(name, 'a    & b \\\\\nlong & c \\\\') : source, `${name}: auto alignment`);
  }
}

// Declarations set initial completion counts and never become first-row content.
for (const name of alignment) {
  const { text, offset } = marked(fixture(name, 'a<cursor>'));
  const expected = alignats.includes(name) ? 4 : cases.includes(name) || name === 'split' || tables.includes(name) ? 2
    : name.startsWith('eqnarray') ? 3 : undefined;
  for (const snapshot of snapshots(text)) {
    const frame = getLatexContext(text, offset, {}, snapshot).currentEnvironmentFrame!;
    const structure = getAlignmentStructure(text, frame, snapshot);
    assert.ok(structure, `${name}: declaration`);
    assert.equal(structure!.declared.columns, expected, `${name}: declared columns`);
    const start = frame.beginEnd + structure!.declared.start;
    assert.equal(text.slice(start, offset).trim(), 'a', `${name}: skip environment arguments`);
    assert.equal(getAlignmentColumnCompletion(text, offset, frame, snapshot).missing,
      (expected || 1) - 1, `${name}: complete initial row`);
    const plan = getSmartEnterPlan(text, offset, {}, snapshot, true);
    assert.ok(plan.handled, name);
    assert.equal(applyTextEditsToString(text, plan.edits),
      fixture(name, 'a' + ' &'.repeat((expected || 1) - 1) + ' \\\\\n'), `${name}: Enter completion`);
  }
}

for (const name of alignats) {
  for (const argument of ['', '{0}', '{-1}', '{1.5}', '{\\count}', '{513}', '{2', '[t]{']) {
    const { text, offset } = marked(fixture(name, 'a<cursor>', argument));
    const frame = getLatexContext(text, offset).currentEnvironmentFrame!;
    assert.equal(getAlignmentStructure(text, frame), undefined, `${name}: reject ambiguous count ${argument}`);
    assert.equal(getAlignmentColumnCompletion(text, offset, frame).missing, 0);
  }
  const { text, offset } = marked(fixture(name, 'a<cursor>', '{512}'));
  const frame = getLatexContext(text, offset).currentEnvironmentFrame!;
  assert.equal(getAlignmentColumnCompletion(text, offset, frame).missing, 1023, `${name}: bounded maximum`);
}

for (const argument of ['[t]', ' [t]', '\n[t]', '\t[b]']) {
  const { text, offset } = marked(fixture('aligned', 'a<cursor>', argument));
  const frame = getLatexContext(text, offset).currentEnvironmentFrame!;
  assert.equal(getAlignmentStructure(text, frame)!.declared.start, argument.length,
    'AMS aligned permits whitespace before its optional position');
}

for (const name of matrices.filter((name) => name.endsWith('*'))) {
  for (const alignment of ['', '[l]', '[c]', '[r]']) {
    const { text, offset } = marked(fixture(name, 'a<cursor>', alignment));
    const frame = getLatexContext(text, offset).currentEnvironmentFrame!;
    const structure = getAlignmentStructure(text, frame)!;
    assert.ok(structure, `${name}${alignment}`);
    assert.equal(structure.declared.start, alignment.length, `${name}: optional alignment prefix`);
  }
  const malformed = fixture(name, 'a', '[r');
  assert.equal(getAlignmentStructure(malformed, getLatexContext(malformed, malformed.indexOf('\na') + 2).currentEnvironmentFrame!),
    undefined, `${name}: incomplete alignment argument`);
}

// mathtools' default disallowspaces keeps a later [c] as literal body content.
for (const name of ['matrix', 'matrix*', 'smallmatrix', 'smallmatrix*', 'bsmallmatrix', 'bsmallmatrix*']) {
  const source = fixture(name, '[c] & a \\\\ \n b & c', '');
  const frame = getLatexContext(source, source.indexOf('&')).currentEnvironmentFrame!;
  assert.equal(getAlignmentStructure(source, frame)!.declared.start, 0, `${name}: bracket-starting body`);
}

for (const name of ['dcases', 'pmatrix*', 'alignat', 'split']) {
  for (const body of ['% a<cursor>', '\\text{a<cursor>}', '\\mathrm{a<cursor>}']) {
    const { text, offset } = marked(fixture(name, body));
    for (const snapshot of snapshots(text)) {
      assert.equal(getSmartTabPlan(text, offset, {}, snapshot), undefined, `${name}: blocked context`);
      assert.equal(getSmartEnterPlan(text, offset, {}, snapshot).handled, false);
    }
  }
  for (const wrap of [(text: string) => '```latex\n' + text + '\n```',
    (text: string) => '\\begin{verbatim}\n' + text + '\n\\end{verbatim}']) {
    const { text, offset } = marked(wrap(fixture(name, 'a<cursor>')));
    assert.equal(getSmartTabPlan(text, offset), undefined);
    assert.equal(getSmartEnterPlan(text, offset).handled, false);
  }
}

// Custom extensions retain their independent capabilities and imply math as before.
for (const [name, options, tab, enter] of [
  ['custommath', { extraMathEnvironments: ['custommath'] }, false, false],
  ['customrows', { extraRowBreakEnvironments: ['customrows'] }, false, true],
  ['customcolumns', { extraAlignmentEnvironments: ['customcolumns'] }, true, false],
] as [string, LatexContextOptions, boolean, boolean][]) {
  const { text, offset } = marked(fixture(name, 'a<cursor>', ''));
  for (const snapshot of snapshots(text, options)) {
    const context = getLatexContext(text, offset, options, snapshot);
    assert.equal(context.inMath, true);
    assert.equal(context.canSmartTab, tab);
    assert.equal(context.canSmartEnter, enter);
  }
}
const resolved = resolveLatexContextOptions({ extraAlignmentEnvironments: ['dcases', 'customcolumns', 'customcolumns'] });
assert.equal(resolved.alignmentEnvironments.filter((name) => name === 'dcases').length, 1);
assert.equal(resolved.mathEnvironments.filter((name) => name === 'customcolumns').length, 1);
for (const name of ['xxalignat*', 'split*', 'aligned*', 'gathered*', 'multlined*', 'tabularx*', 'tabulary', 'tblr', 'tabbing']) {
  const { text, offset } = marked(fixture(name, 'a<cursor>', ''));
  const context = getLatexContext(text, offset);
  assert.equal(context.canSmartTab, false, `${name}: no invented or unparsed variants`);
  assert.equal(context.canSmartEnter, false);
}

console.log(`Environment variants: ${alignment.length} alignment and ${rowOnly.length} row-only environments passed context, snapshot, smart keys, declarations and auto alignment.`);
