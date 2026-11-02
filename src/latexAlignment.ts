import type { LatexDocumentSnapshot } from './latexDocumentState';
import {
  findLatexCommentStart,
  getLatexContext,
  LatexContextOptions,
  resolveLatexContextOptions,
  sanitizeLatexForParsing,
} from './latexContext';
import { findLatexEnvironmentPairAt } from './environmentConvert';
import { TextEdit } from './latexEdit';
import { AlignmentStructure, getAlignmentColumnEdits, getAlignmentStructure } from './latexColumns';

interface Anchor {
  start: number;
  end: number;
  symbol: string;
  cell: number;
}

interface AlignmentRow {
  start: number;
  source: string;
  anchors: Anchor[];
  cells: { operators: Anchor[]; separator?: Anchor }[];
  rowBreak?: Anchor;
  comment?: Anchor;
  cursor: number;
  output: string;
  width: number;
}

function displayWidth(
  text: string,
  tabSize: number,
  characterWidths: ReadonlyMap<string, number>,
  width = 0
) {
  for (let char of text) {
    let code = char.codePointAt(0)!;
    if (char == '\t') {
      width += tabSize - width % tabSize;
    } else if (characterWidths.has(char)) {
      width += characterWidths.get(char)!;
    } else if (!/\p{Mark}/u.test(char)) {
      // Fall back to Unicode columns when native font measurements are unavailable.
      width += code >= 0x1100 && (
        code <= 0x115f || code == 0x2329 || code == 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code != 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff01 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x20000 && code <= 0x3fffd)
      ) ? 2 : 1;
    }
  }
  return width;
}

function alignAnchors(
  entries: { row: AlignmentRow; anchor: Anchor }[],
  tabSize: number,
  characterWidths: ReadonlyMap<string, number>
) {
  if (!entries.length) return;
  let segments = entries.map(({ row, anchor }) =>
    row.source.slice(row.cursor, anchor.start).replace(/^[ \t]+|[ \t]+$/g, '')
  );
  let widths = segments.map((segment, index) =>
    displayWidth(segment, tabSize, characterWidths, entries[index].row.width)
  );
  let column = Math.max(...widths.map((width, index) =>
    width + (/[ \t]$/.test(segments[index] || entries[index].row.output) ? 0 : 1)
  ));
  entries.forEach(({ row, anchor }, index) => {
    let suffix = ' '.repeat(Math.max(0, Math.round(column - widths[index]))) + anchor.symbol;
    if (anchor.symbol != '\\\\' && anchor.symbol != '%') suffix += ' ';
    row.output += segments[index] + suffix;
    row.width = displayWidth(suffix, tabSize, characterWidths, widths[index]);
    row.cursor = anchor.end;
  });
}

function whitespaceEdits(row: AlignmentRow): TextEdit[] {
  let suffix = row.source.slice(row.cursor);
  if (!['\\\\', '%'].includes(row.anchors[row.anchors.length - 1].symbol)) {
    suffix = suffix.replace(/^[ \t]+/, '');
  }
  let formatted = row.output + suffix;
  let edits: TextEdit[] = [];
  const sourceRuns = /[ \t]+/g;
  const formattedRuns = /[ \t]+/g;
  let sourceRun = sourceRuns.exec(row.source);
  let formattedRun = formattedRuns.exec(formatted);
  let sourceWhitespace = 0, formattedWhitespace = 0;
  while (sourceRun || formattedRun) {
    // Removing horizontal whitespace gives matching runs the same content offset.
    const sourceKey = sourceRun ? sourceRun.index - sourceWhitespace : Infinity;
    const formattedKey = formattedRun ? formattedRun.index - formattedWhitespace : Infinity;
    const key = Math.min(sourceKey, formattedKey);
    const start = key + sourceWhitespace;
    const before = sourceKey == key ? sourceRun![0] : '';
    const after = formattedKey == key ? formattedRun![0] : '';
    if (before != after) edits.push({ start: row.start + start, end: row.start + start + before.length, text: after });
    if (sourceKey == key) {
      sourceWhitespace += before.length;
      sourceRun = sourceRuns.exec(row.source);
    }
    if (formattedKey == key) {
      formattedWhitespace += after.length;
      formattedRun = formattedRuns.exec(formatted);
    }
  }
  return edits;
}

export function mapAlignmentOffset(offset: number, edits: TextEdit[]) {
  let result = offset;
  for (let edit of edits) {
    if (offset > edit.end) {
      result += edit.text.length - (edit.end - edit.start);
    } else if (offset >= edit.start) {
      // Keep the caret beside its content instead of moving it across new padding.
      result += Math.min(offset - edit.start, edit.text.length) - (offset - edit.start);
    }
  }
  return result;
}

export function getAlignmentEdits(
  text: string,
  offset: number,
  options: LatexContextOptions = {},
  tabSize = 4,
  characterWidths: ReadonlyMap<string, number> = new Map(),
  snapshot?: LatexDocumentSnapshot,
  structure?: AlignmentStructure
): TextEdit[] {
  let context = getLatexContext(text, offset, options, snapshot);
  if (context.inMarkdownCode || context.inTextLikeCommand || context.inVerbatimLikeEnvironment) {
    return [];
  }
  let pair = findLatexEnvironmentPairAt(text, offset, options, snapshot);
  if (!pair || !resolveLatexContextOptions(options).alignmentEnvironments.includes(pair.name)) {
    return [];
  }

  let sanitized = snapshot ? snapshot.sanitizedText : sanitizeLatexForParsing(text);
  structure ??= getAlignmentStructure(text, pair, snapshot);
  const sharedLayout = structure?.closed && structure.rows.some((row) => row.valid && row.complete &&
    row.dataStart !== undefined && structure!.source.slice(row.dataStart, row.end).includes('\n'));
  function finish(edits: TextEdit[]) {
    if (!sharedLayout) return edits;
    return composeEdits(text, edits, (expanded) => getMultilineWhitespaceEdits(expanded,
      edits.length ? getAlignmentStructure(expanded, pair!) : structure, tabSize, characterWidths));
  }
  const multiline = structure?.rows.filter((row) => row.dataStart !== undefined &&
    structure!.source.slice(row.dataStart, row.complete ? row.end : row.bodyEnd).includes('\n')).map((row) => {
    const first = structure!.base + row.dataStart!;
    const last = text.indexOf('\n', structure!.base + (row.complete ? row.end : row.bodyEnd));
    return { start: text.lastIndexOf('\n', first - 1) + 1, end: last < 0 ? text.length : last + 1 };
  }) || [];
  let multilineIndex = 0;
  let rows: AlignmentRow[] = [];
  let nested = 0;
  let braces = 0;
  let brackets = 0;
  let table = /^(?:tabular\*?|tabularx|longtable)$/.test(pair.name);
  let start = text.indexOf('\n', pair.beginEnd) + 1;
  if (!start) return [];
  while (start < pair.endStart) {
    while (multilineIndex < multiline.length && multiline[multilineIndex].end <= start) multilineIndex++;
    if (multiline[multilineIndex]?.start <= start) {
      start = multiline[multilineIndex].end;
      continue;
    }
    let newline = text.indexOf('\n', start);
    let end = newline == -1 ? text.length : newline;
    if (end > pair.endStart) break;
    let source = text.slice(start, end);
    let line = sanitized.slice(start, end);
    let indent = source.match(/^[ \t]*/)![0];
    let anchors: Anchor[] = [];
    let skip = nested != 0 || braces != 0 || brackets != 0;
    let cell = 0;
    let inlineMath = false;
    let displayMath = false;
    let tokens = /\\(?:begin|end)\s*\{[^}]+\}|\\[a-zA-Z]+\*?|\\[^\r\n]|\$\$?|[{}\[\]&+=\-]/g;
    let token: RegExpExecArray | null;
    while ((token = tokens.exec(line)) !== null) {
      let symbol = token[0];
      if (/^\\begin\b/.test(symbol)) {
        nested++;
        skip = true;
      } else if (/^\\end\b/.test(symbol)) {
        nested--;
        skip = true;
      } else if (/^\\(?:verb\*?|Verb\*?|lstinline\*?|mintinline)$/.test(symbol)) {
        skip = true;
        break;
      } else if (nested == 0) {
        if (symbol == '$') inlineMath = !inlineMath;
        else if (symbol == '$$') displayMath = !displayMath;
        else if (symbol == '\\(') inlineMath = true;
        else if (symbol == '\\)') inlineMath = false;
        else if (symbol == '\\[') displayMath = true;
        else if (symbol == '\\]') displayMath = false;
        else if (symbol == '{') braces++;
        else if (symbol == '}') braces--;
        else if (symbol == '[') brackets++;
        else if (symbol == ']') brackets--;
        else if (braces == 0 && brackets == 0) {
          if ((inlineMath || displayMath) && (symbol == '&' || symbol == '\\\\')) continue;
          if (symbol == '\\\\') {
            if (!/^\*?(?:\[[^\]]*\])?\s*$/.test(line.slice(tokens.lastIndex))) {
              skip = true;
              break;
            }
          } else if (symbol != '&') {
            if (displayMath || (table && !inlineMath) || !/^[+=-]$/.test(symbol)) continue;
            // Signs in exponents, subscripts and unary expressions are not alignment points.
            if (symbol != '=' && (/[+=\-*/(^_&$]$/.test(line.slice(0, token.index).trimEnd()) ||
                !line.slice(indent.length, token.index).trim())) continue;
          }
          anchors.push({ start: token.index, end: tokens.lastIndex, symbol, cell });
          if (symbol == '&') cell++;
          if (symbol == '\\\\') break;
        }
      }
    }
    let comment = findLatexCommentStart(source);
    if (comment != -1 && line.slice(0, comment).trim()) {
      anchors.push({ start: comment, end: comment + 1, symbol: '%', cell });
    }
    if (!skip && braces == 0 && brackets == 0 && anchors.length) {
      let cells: AlignmentRow['cells'] = [];
      let rowBreak: Anchor | undefined;
      let comment: Anchor | undefined;
      for (let anchor of anchors) {
        if (anchor.symbol == '\\\\') rowBreak = anchor;
        else if (anchor.symbol == '%') comment = anchor;
        else {
          let entry = cells[anchor.cell] ||= { operators: [] };
          if (anchor.symbol == '&') entry.separator = anchor;
          else entry.operators.push(anchor);
        }
      }
      rows.push({ start, source, anchors, cells, rowBreak, comment,
        cursor: indent.length, output: indent, width: displayWidth(indent, tabSize, characterWidths) });
    }
    start = end + 1;
  }
  if (rows.length < 2) return finish([]);

  // Padding before an empty first cell is not document indentation.
  const dataRows = rows.filter((row) => row.cells.length || row.rowBreak);
  if (dataRows.length) {
    const contentRows = dataRows.filter((row) => row.source.slice(row.cursor, row.anchors[0].start).trim());
    const base = (contentRows.length ? contentRows : dataRows).reduce((a, b) => a.width <= b.width ? a : b);
    const indent = base.source.slice(0, base.cursor);
    const indentWidth = base.width;
    for (const row of dataRows) {
      row.output = indent;
      row.width = indentWidth;
    }
  }

  let cellCount = Math.max(...rows.map((row) => row.anchors[row.anchors.length - 1].cell));
  for (let cell = 0; cell <= cellCount; cell++) {
    let groups = new Map<string, { row: AlignmentRow; operators: Anchor[] }[]>();
    for (let row of rows) {
      let operators = row.cells[cell]?.operators || [];
      let signature = operators.map((a) => a.symbol == '=' ? '=' : '+-').join(',');
      if (!groups.has(signature)) groups.set(signature, []);
      groups.get(signature)!.push({ row, operators });
    }
    for (let group of groups.values()) {
      for (let index = 0; index < group[0].operators.length; index++) {
        alignAnchors(group.map(({ row, operators }) => ({ row, anchor: operators[index] })), tabSize, characterWidths);
      }
    }
    alignAnchors(rows.flatMap((row) => {
      let anchor = row.cells[cell]?.separator;
      return anchor ? [{ row, anchor }] : [];
    }), tabSize, characterWidths);
  }
  alignAnchors(rows.flatMap((row) => row.rowBreak ? [{ row, anchor: row.rowBreak }] : []),
    tabSize, characterWidths);
  alignAnchors(rows.flatMap((row) => row.comment ? [{ row, anchor: row.comment }] : []),
    tabSize, characterWidths);
  return finish(rows.flatMap(whitespaceEdits));
}

function getMultilineWhitespaceEdits(
  text: string, structure: AlignmentStructure | undefined, tabSize: number,
  characterWidths: ReadonlyMap<string, number>
): TextEdit[] {
  if (!structure?.closed) return [];
  const width = (value: string, start = 0) => displayWidth(value, tabSize, characterWidths, start);
  const lineStart = (offset: number) => text.lastIndexOf('\n', offset - 1) + 1;
  const horizontal = (value: string) => /^[ \t]*$/.test(value);
  const rows = structure.rows.filter((row) => row.valid && row.complete && row.dataStart !== undefined &&
    row.columns === row.separators.length + 1 &&
    !/\\(?:multicolumn\b|begin\s*\{(?:verbatim\*?|Verbatim|lstlisting|minted|comment)\})/.test(
      text.slice(structure.base + row.dataStart, structure.base + row.end))).flatMap((row) => {
    const first = structure.base + row.dataStart!;
    const start = lineStart(first);
    if (start < structure.base + structure.declared.start || !horizontal(text.slice(start, first))) return [];
    const ends = [...row.separators.map((separator) => structure.base + separator.start), structure.base + row.end];
    let cursor = start;
    const cells = ends.map((end) => {
      const cellStart = cursor;
      const fragments: { start: number; content: number; end: number; body: string;
        standalone: boolean; indent: string; endWidth: number }[] = [];
      while (cursor < end) {
        const newline = text.indexOf('\n', cursor);
        let limit = newline < 0 ? end : Math.min(newline, end);
        if (text[limit - 1] === '\r') limit--;
        const raw = text.slice(cursor, limit);
        const indent = raw.match(/^[ \t]*/)![0];
        const comment = findLatexCommentStart(raw);
        const body = (comment < 0 ? raw.replace(/[ \t]+$/, '') : raw).slice(indent.length);
        if (body) {
          const standalone = horizontal(text.slice(lineStart(cursor), cursor));
          fragments.push({ start: cursor, content: cursor + indent.length, end: cursor + indent.length + body.length,
            body, standalone, indent: standalone ? indent : '', endWidth: 0 });
        }
        cursor = newline < 0 || newline >= end ? end : newline + 1;
      }
      const standalone = fragments.filter((fragment) => fragment.standalone);
      const base = standalone.length ? standalone.reduce((min, fragment) => Math.min(min, width(fragment.indent)), Infinity) : 0;
      for (const fragment of standalone) {
        let count = 0, removed = 0;
        while (count < fragment.indent.length) {
          const next = width(fragment.indent[count], removed);
          if (next > base) break;
          removed = next; count++;
        }
        fragment.indent = fragment.indent.slice(count);
      }
      cursor = end + 1;
      return { start: cellStart, end, fragments, baseline: 0, inline: 0, before: 0 };
    });
    return [{ cells, start, first, end: structure.base + row.end }];
  });
  if (!rows.some((row) => text.slice(row.first, row.end).includes('\n'))) return [];

  const withFirstCell = rows.filter((row) => row.cells[0].fragments.length);
  const indent = (withFirstCell.length ? withFirstCell : rows).reduce((min, row) =>
    Math.min(min, width(text.slice(row.start, row.first))), Infinity);
  const columnCount = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const starts = [indent], separators: number[] = [];
  for (let column = 0; column < columnCount; column++) {
    let end = starts[column];
    let occupied = false;
    for (const row of rows) {
      const cell = row.cells[column];
      if (!cell) continue;
      cell.baseline = Math.round(starts[column]);
      if (!column) cell.inline = cell.baseline;
      for (const fragment of cell.fragments) {
        const start = fragment.standalone ? width(fragment.indent, cell.baseline) : cell.inline;
        fragment.endWidth = width(fragment.body, start);
        end = Math.max(end, fragment.endWidth);
        occupied = true;
      }
      const last = cell.fragments[cell.fragments.length - 1];
      cell.before = last && lineStart(last.content) === lineStart(cell.end) ? last.endWidth :
        cell.start >= lineStart(cell.end) && column > 0 ? cell.inline - 1 : 0;
    }
    separators[column] = end + (occupied ? 1 : 0);
    starts[column + 1] = width('& ', separators[column]);
    for (const row of rows) {
      const cell = row.cells[column], next = row.cells[column + 1];
      if (next) {
        const actual = cell.before + Math.max(0, Math.round(separators[column] - cell.before));
        next.inline = width('& ', actual);
      }
    }
  }
  const edits: TextEdit[] = [];
  let unsafe = false;
  function whitespace(start: number, end: number, after: string) {
    const before = text.slice(start, end);
    if (!horizontal(before) || start > end) { unsafe = true; return; }
    if (before !== after) edits.push({ start, end, text: after });
  }
  function spaces(start: number, end: number, count: number) {
    whitespace(start, end, ' '.repeat(Math.max(0, Math.round(count))));
  }
  const comments: { start: number; end: number; width: number }[] = [];
  for (const row of rows) {
    for (let column = 0; column < row.cells.length; column++) {
      const cell = row.cells[column];
      for (const fragment of cell.fragments) {
        whitespace(fragment.start, fragment.content,
          fragment.standalone ? ' '.repeat(cell.baseline) + fragment.indent : ' ');
      }
      const boundary = column === row.cells.length - 1 ? separators[columnCount - 1] : separators[column];
      const last = cell.fragments[cell.fragments.length - 1];
      if (last && lineStart(last.content) === lineStart(cell.end)) {
        spaces(last.end, cell.end, boundary - cell.before);
      } else {
        const start = Math.max(cell.start, lineStart(cell.end));
        spaces(start, cell.end, boundary - cell.before);
      }
    }
    const newline = text.indexOf('\n', row.end);
    const limit = newline < 0 ? text.length : newline;
    const tail = text.slice(row.end, limit).replace(/\r$/, '');
    const comment = findLatexCommentStart(tail);
    if (comment >= 0) {
      const body = tail.slice(0, comment).replace(/[ \t]+$/, '');
      comments.push({ start: row.end + body.length, end: row.end + comment,
        width: width(body, separators[columnCount - 1]) });
    }
  }
  const commentColumn = comments.reduce((max, comment) => Math.max(max, comment.width + 1), 0);
  for (const comment of comments) spaces(comment.start, comment.end, commentColumn - comment.width);
  return unsafe ? [] : edits.sort((a, b) => a.start - b.start);
}

/** Synchronize columns and whitespace in one original-coordinate edit batch. */
export function getAutoAlignmentEdits(
  text: string,
  offset: number,
  options: LatexContextOptions = {},
  tabSize = 4,
  characterWidths: ReadonlyMap<string, number> = new Map(),
  snapshot?: LatexDocumentSnapshot
): TextEdit[] {
  const context = getLatexContext(text, offset, options, snapshot);
  if (context.inMarkdownCode || context.inTextLikeCommand || context.inVerbatimLikeEnvironment) return [];
  const pair = findLatexEnvironmentPairAt(text, offset, options, snapshot);
  if (!pair || !resolveLatexContextOptions(options).alignmentEnvironments.includes(pair.name)) return [];
  const structure = getAlignmentStructure(text, pair, snapshot);
  const columns = structure ? getAlignmentColumnEdits(structure, offset) : [];
  if (!columns.length) return getAlignmentEdits(text, offset, options, tabSize, characterWidths, snapshot, structure);

  return composeEdits(text, columns, (expanded) =>
    getAlignmentEdits(expanded, mapAlignmentOffset(offset, columns), options, tabSize, characterWidths));
}

function composeEdits(text: string, first: TextEdit[], next: (expanded: string) => TextEdit[]): TextEdit[] {
  // Source anchors compose insertions, deletions and whitespace changes without overlapping edits.
  type Piece = { text: string; source?: number };
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const edit of first) {
    if (cursor < edit.start) pieces.push({ text: text.slice(cursor, edit.start), source: cursor });
    if (edit.text) pieces.push({ text: edit.text });
    cursor = edit.end;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), source: cursor });
  const expanded = pieces.map((piece) => piece.text).join('');
  const whitespace = next(expanded);
  const formatted: Piece[] = [];
  let index = 0, within = 0, position = 0;
  function consume(end: number, retain: boolean) {
    while (position < end && index < pieces.length) {
      const piece = pieces[index];
      const length = Math.min(end - position, piece.text.length - within);
      if (retain) formatted.push({ text: piece.text.slice(within, within + length),
        source: piece.source === undefined ? undefined : piece.source + within });
      position += length;
      within += length;
      if (within === piece.text.length) { index++; within = 0; }
    }
  }
  for (const edit of whitespace) {
    consume(edit.start, true);
    consume(edit.end, false);
    if (edit.text) formatted.push({ text: edit.text });
  }
  consume(expanded.length, true);
  const result: TextEdit[] = [];
  cursor = 0;
  let replacement = '';
  function flush(end: number) {
    if (text.slice(cursor, end) !== replacement) result.push({ start: cursor, end, text: replacement });
    replacement = '';
  }
  for (const piece of formatted) {
    if (piece.source === undefined) replacement += piece.text;
    else {
      flush(piece.source);
      cursor = piece.source + piece.text.length;
    }
  }
  flush(text.length);
  return result;
}
