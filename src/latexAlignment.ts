import type { LatexDocumentSnapshot } from './latexDocumentState';
import {
  findLatexCommentStart,
  getLatexContext,
  LatexContextOptions,
  resolveLatexContextOptions,
  sanitizeLatexForParsing,
} from './latexContext';
import { findLatexEnvironmentPairAt } from './environmentConvert';
import { TextEdit, applyTextEditsToString } from './latexEdit';
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
      } else if (/^\\verb\*?$/.test(symbol)) {
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
  if (rows.length < 2) return [];

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
  return rows.flatMap(whitespaceEdits);
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
  const columns = structure ? getAlignmentColumnEdits(structure) : [];
  if (!columns.length) return getAlignmentEdits(text, offset, options, tabSize, characterWidths, snapshot, structure);

  const parts: string[] = [];
  let cursor = 0, delta = 0;
  const blocks = columns.map((edit) => {
    parts.push(text.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
    const start = edit.start + delta;
    delta += edit.text.length;
    return { start, end: start + edit.text.length, edits: [] as TextEdit[], suffix: '' };
  });
  parts.push(text.slice(cursor));
  const expanded = parts.join('');
  const whitespace = getAlignmentEdits(expanded, mapAlignmentOffset(offset, columns), options, tabSize, characterWidths);
  const result = columns.map((edit) => ({ ...edit }));
  let index = 0;
  delta = 0;
  for (const edit of whitespace) {
    while (index < blocks.length && blocks[index].end < edit.start) {
      delta += columns[index++].text.length;
    }
    const block = blocks[index];
    if (block && edit.start < block.start && edit.end > block.start && edit.end <= block.end) {
      // A control-space can merge original whitespace with the insertion's leading padding.
      result[index].start = edit.start - delta;
      block.edits.push({ start: 0, end: edit.end - block.start, text: edit.text });
    } else if (block && edit.start >= block.start && edit.end <= block.end) {
      block.edits.push({ start: edit.start - block.start, end: edit.end - block.start, text: edit.text });
    } else {
      const shift = delta + (block && edit.start >= block.end ? columns[index].text.length : 0);
      if (block && edit.start === block.end) {
        // Right padding may span the end of an inserted column and the original whitespace.
        result[index].end = edit.end - shift;
        block.suffix = edit.text;
      } else result.push({ start: edit.start - shift, end: edit.end - shift, text: edit.text });
    }
  }
  for (let i = 0; i < columns.length; i++) {
    result[i].text = applyTextEditsToString(columns[i].text, blocks[i].edits) + blocks[i].suffix;
  }
  return result.sort((a, b) => a.start - b.start);
}
