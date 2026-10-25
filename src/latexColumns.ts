import { LatexEnvironmentFrame, sanitizeLatexForParsing } from './latexContext';
import type { LatexDocumentSnapshot } from './latexDocumentState';
import type { TextEdit } from './latexEdit';

// Incomplete user input must not expand an arbitrary repetition into edits.
const MAX_COLUMNS = 1024;
const MAX_SPEC_DEPTH = 16;
const TABLES = new Set(['array', 'tabular', 'tabular*', 'tabularx', 'longtable']);

interface Group { value: string; end: number }
interface Row { start: number; end: number; columns: number; valid: boolean; content: boolean; complete: boolean }

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

function specColumns(spec: string, depth = 0): number | undefined {
  if (depth > MAX_SPEC_DEPTH) return undefined;
  let columns = 0;
  for (let index = 0; index < spec.length;) {
    const char = spec[index++];
    if (/\s/.test(char) || char === '|') continue;
    if ('lcrX'.includes(char)) columns++;
    else if ('pmb@!><'.includes(char)) {
      const group = groupAt(spec, index);
      if (!group) return undefined;
      index = group.end;
      if ('pmb'.includes(char)) columns++;
    } else if (char === '*') {
      const count = groupAt(spec, index);
      const repeated = count && groupAt(spec, count.end);
      const times = count && positiveInteger(count.value);
      const width = repeated && specColumns(repeated.value, depth + 1);
      if (!repeated || !times || !width) return undefined;
      columns += times * width;
      index = repeated.end;
    } else return undefined;
    if (columns > MAX_COLUMNS) return undefined;
  }
  return columns || undefined;
}

function optionalPosition(text: string, index: number): number | undefined {
  index = skipSpace(text, index);
  if (text[index] !== '[') return index;
  return groupAt(text, index, '[', ']')?.end;
}

function declaration(text: string, name: string): { start: number; columns?: number; appendOffset?: number } | undefined {
  if (!TABLES.has(name) && !/^alignedat\*?$/.test(name)) {
    return { start: 0, columns: name === 'cases' ? 2 : undefined };
  }
  let index = optionalPosition(text, 0);
  if (index === undefined) return undefined;
  if (name === 'tabular*' || name === 'tabularx') {
    const width = groupAt(text, index);
    if (!width) return undefined;
    index = optionalPosition(text, width.end);
    if (index === undefined) return undefined;
  }
  const argument = groupAt(text, index);
  if (!argument) return undefined;
  const columns = TABLES.has(name) ? specColumns(argument.value) : positiveInteger(argument.value);
  const count = columns && (TABLES.has(name) ? columns : columns * 2);
  if (!count || count > MAX_COLUMNS) return undefined;
  const trailingBars = argument.value.match(/[|\s]*$/)![0].length;
  return { start: argument.end, columns: count,
    appendOffset: TABLES.has(name) ? argument.end - 1 - trailingBars : undefined };
}

function scanRows(text: string, start: number, name: string) {
  const rows: Row[] = [];
  const nested: string[] = [];
  let rowStart = start, columns = 1, valid = true, content = false, cellContent = false;
  function finish(end: number, complete: boolean) {
    rows.push({ start: rowStart, end, columns, valid: valid && nested.length === 0, content, complete });
    columns = 1; valid = true; content = false; cellContent = false;
  }
  for (let index = start; index < text.length;) {
    const char = text[index];
    if (/\s/.test(char)) { index++; continue; }
    if (char === '{') {
      const group = groupAt(text, index);
      if (!group) { valid = false; break; }
      if (!nested.length) content = cellContent = true;
      index = group.end;
      continue;
    }
    if (char === '}') valid = false;
    if (char === '\\') {
      const command = /^\\([a-zA-Z]+\*?|[^\r\n])/.exec(text.slice(index));
      if (!command) { valid = false; index++; continue; }
      const commandStart = index;
      index += command[0].length;
      const word = command[1];
      if (word === 'begin' || word === 'end') {
        const environment = groupAt(text, index);
        if (!environment) { valid = false; continue; }
        index = environment.end;
        const environmentName = environment.value.trim();
        if (word === 'begin') {
          if (!nested.length) content = cellContent = true;
          nested.push(environmentName);
        } else if (nested.length) {
          if (nested.pop() !== environmentName) valid = false;
        } else {
          if (environmentName !== name) valid = false;
          finish(commandStart, false);
          return { rows, closed: environmentName === name };
        }
        continue;
      }
      if (word === 'verb' || word === 'verb*') {
        if (!nested.length) valid = false;
        const delimiter = text[index];
        const end = delimiter && text.indexOf(delimiter, index + 1);
        if (typeof end !== 'number' || end < 0 || /[\r\n]/.test(text.slice(index, end))) {
          valid = false;
          break;
        }
        index = end + 1;
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
      if (/^(?:hline|endfirsthead|endhead|endfoot|endlastfoot|morecmidrules)$/.test(word)) continue;
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
        continue;
      }
      if (/^(?:cline|noalign|label|caption\*?|specialrule)$/.test(word)) {
        if (word === 'caption' || word === 'caption*') {
          const optional = optionalPosition(text, index);
          if (optional === undefined) valid = false;
          else index = optional;
        }
        for (let count = word === 'specialrule' ? 3 : 1; count > 0; count--) {
          const argument = groupAt(text, index);
          if (!argument) { valid = false; break; }
          index = argument.end;
        }
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
      content = cellContent = true;
      if (columns > MAX_COLUMNS) valid = false;
      continue;
    }
    if (!nested.length) {
      content = true;
      if (char === '&') { columns++; cellContent = false; }
      else cellContent = true;
      if (columns > MAX_COLUMNS) valid = false;
    }
    index++;
  }
  finish(text.length, false);
  return { rows, closed: false };
}

/** Complete trailing cells and extend known declarations; ambiguous input stays untouched. */
export function getAlignmentColumnCompletion(
  text: string,
  offset: number,
  frame: LatexEnvironmentFrame,
  snapshot?: LatexDocumentSnapshot
): { missing: number; columnSpecEdit?: TextEdit } {
  if (!Number.isInteger(offset) || offset < frame.beginEnd || offset > text.length || frame.beginEnd < 0) return { missing: 0 };
  const pair = snapshot?.environmentPairAt(offset);
  const end = pair?.beginStart === frame.beginStart ? pair.endEnd : text.length;
  const local = sanitizeLatexForParsing(text.slice(frame.beginEnd, end));
  const declared = declaration(local, frame.name);
  if (!declared) return { missing: 0 };
  const position = offset - frame.beginEnd;
  const prefixRows = scanRows(local.slice(0, position), declared.start, frame.name).rows;
  const current = prefixRows[prefixRows.length - 1];
  if (!current?.valid || !current.content) return { missing: 0 };
  let peerColumns = 0;
  const { rows, closed } = scanRows(local, declared.start, frame.name);
  for (const row of rows) {
    if (!(row.start <= position && position <= row.end) && row.valid && row.content &&
        (closed || (row.complete && row.end < position))) {
      peerColumns = Math.max(peerColumns, row.columns);
    }
  }
  const expected = Math.max(current.columns, peerColumns > 1 ? peerColumns : declared.columns || 0);
  let columnSpecEdit: TextEdit | undefined;
  if (declared.appendOffset !== undefined && declared.columns && expected > declared.columns) {
    const start = frame.beginEnd + declared.appendOffset;
    columnSpecEdit = { start, end: start, text: 'l'.repeat(expected - declared.columns) };
  }
  return { missing: expected - current.columns, columnSpecEdit };
}
