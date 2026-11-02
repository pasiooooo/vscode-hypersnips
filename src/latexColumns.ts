import { LatexEnvironmentFrame, sanitizeLatexForParsing } from './latexContext';
import type { LatexDocumentSnapshot } from './latexDocumentState';
import type { TextEdit } from './latexEdit';

// Incomplete user input must not expand an arbitrary repetition into edits.
const MAX_COLUMNS = 1024;
const MAX_SPEC_DEPTH = 16;
const TABLES = new Set(['array', 'tabular', 'tabular*', 'tabularx', 'longtable']);

interface Group { value: string; end: number }
interface Row {
  start: number; end: number; dataStart?: number; bodyEnd: number; columns: number;
  occupiedColumns: number; separators: { start: number; column: number }[];
  valid: boolean; content: boolean; complete: boolean; nonData: boolean; controlEnd: number;
}

function skipSpace(text: string, start: number) {
  while (/\s/.test(text[start] || '')) start++;
  return start;
}

function groupAt(text: string, start: number, open = '{', close = '}'): Group | undefined {
  start = skipSpace(text, start);
  if (text[start] !== open) return undefined;
  let depth = 1;
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (open !== '{' && text[index] === '{') {
      const group = groupAt(text, index);
      if (!group) return undefined;
      index = group.end - 1;
    } else if (text[index] === open) depth++;
    else if (text[index] === close && --depth === 0) {
      return { value: text.slice(start + 1, index), end: index + 1 };
    }
  }
  return undefined;
}

function positiveInteger(value: string): number | undefined {
  if (!/^\s*\d+\s*$/.test(value)) return undefined;
  const count = Number(value);
  return count >= 1 && count <= MAX_COLUMNS ? count : undefined;
}

function specColumns(spec: string, depth = 0): { columns: number; appendOffset: number } | undefined {
  if (depth > MAX_SPEC_DEPTH) return undefined;
  let columns = 0, appendOffset = 0;
  for (let index = 0; index < spec.length;) {
    const char = spec[index++];
    if (/\s/.test(char) || char === '|') continue;
    if ('lcrX'.includes(char)) { columns++; appendOffset = index; }
    else if ('pmb@!><'.includes(char)) {
      const group = groupAt(spec, index);
      if (!group) return undefined;
      index = group.end;
      if ('pmb'.includes(char)) columns++;
      if ('pmb<'.includes(char)) appendOffset = index;
    } else if (char === '*') {
      const count = groupAt(spec, index);
      const repeated = count && groupAt(spec, count.end);
      const times = count && positiveInteger(count.value);
      const width = repeated && specColumns(repeated.value, depth + 1);
      if (!repeated || !times || !width) return undefined;
      columns += times * width.columns;
      index = repeated.end;
      appendOffset = index;
    } else return undefined;
    if (columns > MAX_COLUMNS) return undefined;
  }
  return columns ? { columns, appendOffset } : undefined;
}

function optionalPosition(text: string, index: number): number | undefined {
  index = skipSpace(text, index);
  if (text[index] !== '[') return index;
  return groupAt(text, index, '[', ']')?.end;
}

function declaration(text: string, name: string): { start: number; columns?: number; appendOffset?: number } | undefined {
  const counted = /^(?:alignedat\*?|x?alignat\*?|xxalignat)$/.test(name);
  if (!TABLES.has(name) && !counted) {
    const optional = /^[pbBvV]?(?:small)?matrix\*$/.test(name);
    const alignedOption = name === 'aligned' && text[skipSpace(text, 0)] === '[';
    const start = alignedOption ? optionalPosition(text, 0) :
      optional && text[0] === '[' ? groupAt(text, 0, '[', ']')?.end : 0;
    if (start === undefined) return undefined;
    return { start, columns: /^(?:d?r?cases\*?|split)$/.test(name) ? 2 : /^eqnarray\*?$/.test(name) ? 3 : undefined };
  }
  let index = TABLES.has(name) || /^alignedat\*?$/.test(name) ? optionalPosition(text, 0) : 0;
  if (index === undefined) return undefined;
  if (name === 'tabular*' || name === 'tabularx') {
    const width = groupAt(text, index);
    if (!width) return undefined;
    index = optionalPosition(text, width.end);
    if (index === undefined) return undefined;
  }
  const argument = groupAt(text, index);
  if (!argument) return undefined;
  const specification = TABLES.has(name) ? specColumns(argument.value) : undefined;
  const columns = TABLES.has(name) ? specification?.columns : positiveInteger(argument.value);
  const count = columns && (TABLES.has(name) ? columns : columns * 2);
  if (!count || count > MAX_COLUMNS) return undefined;
  return { start: argument.end, columns: count,
    appendOffset: specification ? argument.end - 1 - argument.value.length + specification.appendOffset : undefined };
}

function scanRows(text: string, start: number, name: string) {
  const rows: Row[] = [];
  const nested: string[] = [];
  let rowStart = start, columns = 1, valid = true, content = false, cellContent = false;
  let occupiedColumns = 0, separators: Row['separators'] = [], nonData = false, controlEnd = 0, caption = false;
  let dataStart: number | undefined, bodyEnd = start, mathEnd: string | undefined;
  function touch(start: number, end: number) {
    dataStart ??= start;
    bodyEnd = end;
    content = true;
  }
  function occupy() {
    cellContent = true;
    occupiedColumns = Math.max(occupiedColumns, columns);
  }
  function finish(end: number, complete: boolean) {
    rows.push({ start: rowStart, end, dataStart, bodyEnd, columns, occupiedColumns, separators, controlEnd,
      nonData: caption || (nonData && !/[\r\n]/.test(text.slice(controlEnd, end))),
      valid: valid && nested.length === 0 && !mathEnd, content, complete });
    columns = 1; valid = true; content = false; cellContent = false;
    occupiedColumns = 0; separators = []; nonData = false; controlEnd = 0; caption = false;
    dataStart = undefined;
  }
  for (let index = start; index < text.length;) {
    const char = text[index];
    if (/\s/.test(char)) { index++; continue; }
    if (char === '{') {
      const group = groupAt(text, index);
      if (!group) { valid = false; break; }
      if (!nested.length) { touch(index, group.end); occupy(); }
      index = group.end;
      continue;
    }
    if (char === '}') valid = false;
    if (char === '$' && !nested.length) {
      const delimiter = text[index + 1] === '$' ? '$$' : '$';
      if (!mathEnd) mathEnd = delimiter;
      else if (mathEnd === delimiter) mathEnd = undefined;
      touch(index, index + delimiter.length);
      occupy();
      index += delimiter.length;
      continue;
    }
    if (char === '\\') {
      const command = /^\\([a-zA-Z]+\*?|[^\r\n])/.exec(text.slice(index));
      if (!command) { valid = false; index++; continue; }
      const commandStart = index;
      index += command[0].length;
      const word = command[1];
      if (mathEnd) {
        if (word === mathEnd) mathEnd = undefined;
        touch(commandStart, index);
        continue;
      }
      if (!nested.length && (word === '[' || word === '(')) {
        mathEnd = word === '[' ? ']' : ')';
        touch(commandStart, index);
        occupy();
        continue;
      }
      if (word === 'begin' || word === 'end') {
        const environment = groupAt(text, index);
        if (!environment) { valid = false; continue; }
        index = environment.end;
        const environmentName = environment.value.trim();
        if (word === 'begin') {
          if (!nested.length) { touch(commandStart, index); occupy(); }
          nested.push(environmentName);
        } else if (nested.length) {
          if (nested.pop() !== environmentName) valid = false;
          if (!nested.length) touch(commandStart, index);
        } else {
          if (environmentName !== name) valid = false;
          finish(commandStart, false);
          return { rows, closed: environmentName === name };
        }
        continue;
      }
      if (/^(?:lstinline\*?|Verb\*?|mintinline)$/.test(word)) {
        // Their package-specific options/delimiters are opaque; never parse literal row/column tokens.
        if (!nested.length) { valid = false; touch(commandStart, index); }
        const newline = text.indexOf('\n', index);
        index = newline < 0 ? text.length : newline;
        continue;
      }
      if (word === 'verb' || word === 'verb*') {
        if (!nested.length) { valid = false; touch(commandStart, index); }
        const delimiter = text[index];
        const end = delimiter && text.indexOf(delimiter, index + 1);
        if (typeof end !== 'number' || end < 0 || /[\r\n]/.test(text.slice(index, end))) {
          valid = false;
          break;
        }
        index = end + 1;
        if (!nested.length) touch(commandStart, index);
        continue;
      }
      if (nested.length) continue;
      if (word === '\\' || /^tabularnewline\*?$/.test(word)) {
        finish(commandStart, true);
        if (text[index] === '*') index++;
        const spacingStart = skipSpace(text, index);
        if (text[spacingStart] === '[') {
          const spacing = groupAt(text, spacingStart, '[', ']');
          if (!spacing) return { rows, closed: false };
          index = spacing.end;
        }
        rowStart = index;
        continue;
      }
      if (/^(?:hline|endfirsthead|endhead|endfoot|endlastfoot|morecmidrules)$/.test(word)) {
        nonData = true;
        if (!content) controlEnd = index;
        continue;
      }
      if (/^(?:toprule|midrule|bottomrule|addlinespace|cmidrule)$/.test(word)) {
        let next = skipSpace(text, index);
        if (text[next] === '[') {
          const thickness = groupAt(text, next, '[', ']');
          if (!thickness) valid = false;
          else index = thickness.end;
        }
        if (word === 'cmidrule') {
          next = skipSpace(text, index);
          if (text[next] === '(') {
            const trim = groupAt(text, next, '(', ')');
            if (!trim) valid = false;
            else index = trim.end;
          }
          const range = groupAt(text, index);
          if (!range) valid = false;
          else index = range.end;
        }
        nonData = true;
        if (!content) controlEnd = index;
        continue;
      }
      if (/^(?:cline|noalign|label|caption\*?|specialrule)$/.test(word)) {
        nonData = true;
        if (word === 'caption' || word === 'caption*') {
          caption = true;
          const optional = optionalPosition(text, index);
          if (optional === undefined) valid = false;
          else index = optional;
        }
        for (let count = word === 'specialrule' ? 3 : 1; count > 0; count--) {
          const argument = groupAt(text, index);
          if (!argument) { valid = false; break; }
          index = argument.end;
        }
        if (!content) controlEnd = index;
        if (word === 'label' && content) { touch(commandStart, index); occupy(); }
        continue;
      }
      if (/^(?:span|omit|multispan|cr)$/.test(word)) valid = false;
      if (word === 'multicolumn') {
        const span = groupAt(text, index);
        const format = span && groupAt(text, span.end);
        const body = format && groupAt(text, format.end);
        const width = span && positiveInteger(span.value);
        if (cellContent || !body || !width) valid = false;
        else columns += width - 1;
        index = body?.end ?? format?.end ?? span?.end ?? index;
      }
      touch(commandStart, index);
      occupy();
      if (columns > MAX_COLUMNS) valid = false;
      continue;
    }
    if (!nested.length) {
      touch(index, index + 1);
      if (char === '&' && !mathEnd) {
        separators.push({ start: index, column: columns });
        columns++; cellContent = false;
      } else occupy();
      if (columns > MAX_COLUMNS) valid = false;
    }
    index++;
  }
  finish(text.length, false);
  return { rows, closed: false };
}

export function getAlignmentStructure(
  text: string,
  frame: Pick<LatexEnvironmentFrame, 'name' | 'beginStart' | 'beginEnd'>,
  snapshot?: LatexDocumentSnapshot
) {
  const pair = snapshot?.environmentPairAt(frame.beginEnd);
  const end = pair?.beginStart === frame.beginStart ? pair.endEnd : text.length;
  const source = sanitizeLatexForParsing(text.slice(frame.beginEnd, end));
  const declared = declaration(source, frame.name);
  if (!declared) return undefined;
  return { ...scanRows(source, declared.start, frame.name), source, declared, base: frame.beginEnd };
}

export type AlignmentStructure = NonNullable<ReturnType<typeof getAlignmentStructure>>;

export function getAlignmentColumnEdits(structure: AlignmentStructure, offset?: number): TextEdit[] {
  if (!structure.closed) return [];
  const rows = structure.rows.filter((row) => row.valid && (row.content || (row.complete && !row.nonData)));
  if (!rows.length) return [];
  const widest = rows.reduce((width, row) => Math.max(width, row.columns), 0);
  const position = offset === undefined ? undefined : offset - structure.base;
  const active = position === undefined ? undefined : rows.find((row) =>
    row.start <= position && position <= row.end && position >= row.controlEnd && (row.content || row.complete));
  const occupied = rows.reduce((width, row) => Math.max(width, row.occupiedColumns), 1);
  // Empty tails follow the active row; real content, including spans, sets the minimum width.
  const expected = Math.max(occupied, active?.columns ?? widest);
  const edits = rows.filter((row) => row.complete && row.columns < expected).map((row) => ({
    start: structure.base + (row.content ? row.bodyEnd : row.end),
    end: structure.base + (row.content ? row.bodyEnd : row.end),
    text: ' &'.repeat(expected - row.columns),
  }));
  for (const row of rows) {
    for (const separator of row.separators) {
      if (separator.column >= expected) {
        const start = structure.base + separator.start;
        edits.push({ start, end: start + 1, text: '' });
      }
    }
  }
  const { columns, appendOffset } = structure.declared;
  if (columns && appendOffset !== undefined && expected > columns) {
    const start = structure.base + appendOffset;
    edits.push({ start, end: start, text: 'l'.repeat(expected - columns) });
  }
  return edits.sort((a, b) => a.start - b.start);
}

/** Complete trailing cells and extend known declarations; ambiguous input stays untouched. */
export function getAlignmentColumnCompletion(
  text: string,
  offset: number,
  frame: LatexEnvironmentFrame,
  snapshot?: LatexDocumentSnapshot,
  structure?: AlignmentStructure
): { missing: number; columnSpecEdit?: TextEdit } {
  if (!Number.isInteger(offset) || offset < frame.beginEnd || offset > text.length || frame.beginEnd < 0) return { missing: 0 };
  structure ??= getAlignmentStructure(text, frame, snapshot);
  if (!structure) return { missing: 0 };
  const { source: local, declared, rows, closed } = structure;
  const position = offset - frame.beginEnd;
  const prefixRows = scanRows(local.slice(0, position), declared.start, frame.name).rows;
  const current = prefixRows[prefixRows.length - 1];
  if (!current?.valid || !current.content) return { missing: 0 };
  let peerColumns = 0;
  for (const row of rows) {
    if (!(row.start <= position && position <= row.end) && row.valid && row.content &&
        (closed || (row.complete && row.end < position))) {
      peerColumns = Math.max(peerColumns, row.columns);
    }
  }
  const completed = rows.some((row) => row.valid && row.complete && (row.content || !row.nonData));
  // The declaration only seeds a new table; it must not resurrect deleted columns in existing rows.
  const expected = Math.max(current.columns, peerColumns || (completed ? 0 : declared.columns || 0));
  let columnSpecEdit: TextEdit | undefined;
  if (declared.appendOffset !== undefined && declared.columns && expected > declared.columns) {
    const start = frame.beginEnd + declared.appendOffset;
    columnSpecEdit = { start, end: start, text: 'l'.repeat(expected - declared.columns) };
  }
  return { missing: expected - current.columns, columnSpecEdit };
}
