import type { LatexDocumentSnapshot } from './latexDocumentState';
import { getAlignmentColumnCompletion } from './latexColumns';
import {
  findLatexCommentStart,
  getLatexContext,
  LatexContextOptions,
  resolveLatexContextOptions,
} from './latexContext';

export {
  ALIGNMENT_SEPARATOR_ENVIRONMENTS,
  findLatexCommentStart,
  getLatexContext,
  getOpenLatexEnvironmentFrames,
  getOpenLatexEnvironmentStack,
  isInsideLatexLineComment,
  isInsideMarkdownCode,
  isInsideTextLikeCommand,
  LatexContext,
  LatexContextOptions,
  LatexEditorContext,
  LatexEnvironmentFrame,
  MATH_ENVIRONMENTS,
  ROW_BREAK_ENVIRONMENTS,
  sanitizeLatexForParsing,
  stripLatexComments,
} from './latexContext';

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export interface SmartEnterPlan {
  handled: boolean;
  edits: TextEdit[];
  cursorOffset?: number;
}

function getLineBounds(text: string, offset: number) {
  let start = text.lastIndexOf('\n', Math.max(offset - 1, 0)) + 1;
  let nextNewline = text.indexOf('\n', offset);
  let end = nextNewline == -1 ? text.length : nextNewline;
  return { start, end };
}

function getLineIndent(line: string) {
  let match = line.match(/^\s*/);
  return match ? match[0] : '';
}

export function applyTextEditsToString(text: string, edits: TextEdit[]) {
  return edits
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce((result, edit) => {
      return result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    }, text);
}

function getTextReplacement(fromText: string, toText: string): TextEdit | undefined {
  if (fromText == toText) {
    return undefined;
  }

  let start = 0;
  while (
    start < fromText.length &&
    start < toText.length &&
    fromText[start] == toText[start]
  ) {
    start++;
  }

  let fromEnd = fromText.length;
  let toEnd = toText.length;
  while (
    fromEnd > start &&
    toEnd > start &&
    fromText[fromEnd - 1] == toText[toEnd - 1]
  ) {
    fromEnd--;
    toEnd--;
  }

  return {
    start,
    end: fromEnd,
    text: toText.slice(start, toEnd),
  };
}

function shouldAppendMathLineBreak(line: string) {
  let commentStart = findLatexCommentStart(line);
  let formulaPart = commentStart == -1 ? line : line.substring(0, commentStart);
  let trimmed = formulaPart.trim();

  if (!trimmed) return false;
  if (/^\\(?:begin|end)\s*\{[^}]+\}$/.test(trimmed)) return false;
  if (/\\\\(?:\[[^\]]+\])?$/.test(trimmed)) return false;

  return true;
}

export function getSmartEnterPlan(
  text: string,
  offset: number,
  options: LatexContextOptions = {},
  snapshot?: LatexDocumentSnapshot,
  completeAlignmentColumns = false,
  eol?: '\n' | '\r\n'
): SmartEnterPlan {
  let context = getLatexContext(text, offset, options, snapshot);
  if (!context.canSmartEnter && !(completeAlignmentColumns && context.canSmartTab)) {
    return { handled: false, edits: [] };
  }

  let lineBounds = getLineBounds(text, offset);
  const hasCarriageReturn = text[lineBounds.end] == '\n' && text[lineBounds.end - 1] == '\r';
  const newline = eol ?? (completeAlignmentColumns && (hasCarriageReturn || text[lineBounds.start - 2] == '\r') ? '\r\n' : '\n');
  if ((completeAlignmentColumns || eol !== undefined) && hasCarriageReturn) lineBounds.end--;
  let line = text.substring(lineBounds.start, lineBounds.end);
  let column = offset - lineBounds.start;
  let commentStart = findLatexCommentStart(line);
  let formulaLimit = commentStart == -1 ? line.length : commentStart;

  if (column > formulaLimit) {
    return { handled: false, edits: [] };
  }

  if (line.substring(column, formulaLimit).trim().length > 0) {
    return { handled: false, edits: [] };
  }

  let indent = getLineIndent(line);
  let formulaEnd = line.substring(0, formulaLimit).replace(/\s+$/, '').length;
  const existingBreak = line.slice(0, formulaEnd).match(/(?:\\\\|\\tabularnewline)\*?(?:\[[^\]]*\])?$/);
  const frame = context.currentEnvironmentFrame;
  let missing = 0;
  let columnSpecEdit: TextEdit | undefined;
  if (completeAlignmentColumns && context.canSmartTab && frame &&
      resolveLatexContextOptions(options).alignmentEnvironments.includes(frame.name)) {
    const bodyEnd = existingBreak ? line.slice(0, existingBreak.index).trimEnd().length : formulaEnd;
    ({ missing, columnSpecEdit } = getAlignmentColumnCompletion(text, lineBounds.start + bodyEnd, frame, snapshot));
  }
  if (completeAlignmentColumns && existingBreak) {
    if (!missing && !columnSpecEdit) return { handled: false, edits: [] };
    formulaEnd = line.slice(0, existingBreak.index).trimEnd().length;
  } else if (!shouldAppendMathLineBreak(line)) {
    return { handled: false, edits: [] };
  }
  const completedBreak = ' &'.repeat(missing) + ' ' +
    (completeAlignmentColumns && existingBreak ? existingBreak[0] : '\\\\');
  const declarationEdits = columnSpecEdit ? [columnSpecEdit] : [];
  const declarationDelta = columnSpecEdit ? columnSpecEdit.text.length - (columnSpecEdit.end - columnSpecEdit.start) : 0;

  if (commentStart == -1) {
    let replaceStart = lineBounds.start + formulaEnd;
    let insertText = completedBreak + newline + indent;
    return {
      handled: true,
      edits: [...declarationEdits, { start: replaceStart, end: lineBounds.end, text: insertText }],
      cursorOffset: replaceStart + insertText.length + declarationDelta,
    };
  }

  let replaceStart = lineBounds.start + formulaEnd;
  let replaceEnd = lineBounds.start + commentStart;
  let insertText = completedBreak + ' ';
  let lineBreakText = newline + indent;

  return {
    handled: true,
    edits: [
      ...declarationEdits,
      { start: replaceStart, end: replaceEnd, text: insertText },
      { start: lineBounds.end, end: lineBounds.end, text: lineBreakText },
    ],
    cursorOffset: lineBounds.end + insertText.length - (replaceEnd - replaceStart) + lineBreakText.length + declarationDelta,
  };
}

export function getSmartEnterRecoveryPlan(
  beforeEnterText: string,
  offsetBeforeEnter: number,
  currentText: string,
  options: LatexContextOptions = {},
  snapshot?: LatexDocumentSnapshot,
  completeAlignmentColumns = false,
  eol?: '\n' | '\r\n'
): SmartEnterPlan {
  let desiredPlan = getSmartEnterPlan(beforeEnterText, offsetBeforeEnter, options, snapshot, completeAlignmentColumns, eol);
  if (!desiredPlan.handled || typeof desiredPlan.cursorOffset != 'number') {
    return { handled: false, edits: [] };
  }

  let desiredText = applyTextEditsToString(beforeEnterText, desiredPlan.edits);
  let replacement = getTextReplacement(currentText, desiredText);
  if (!replacement) {
    return { handled: false, edits: [] };
  }

  return {
    handled: true,
    edits: [replacement],
    cursorOffset: desiredPlan.cursorOffset,
  };
}

export function shouldInsertAlignmentSeparator(
  text: string,
  offset: number,
  options: LatexContextOptions = {},
  snapshot?: LatexDocumentSnapshot
) {
  let context = getLatexContext(text, offset, options, snapshot);
  if (!context.canSmartTab) {
    return false;
  }

  let lineBounds = getLineBounds(text, offset);
  let line = text.substring(lineBounds.start, lineBounds.end);
  let column = offset - lineBounds.start;
  let commentStart = findLatexCommentStart(line);
  let formulaLimit = commentStart == -1 ? line.length : commentStart;
  let formulaPart = line.substring(0, formulaLimit).trim();

  if (column > formulaLimit) return false;
  if (!formulaPart && line.trim().startsWith('%')) return false;
  if (/^\\(?:begin|end)\s*\{[^}]+\}$/.test(formulaPart)) return false;
  if (/\\\\(?:\[[^\]]+\])?$/.test(formulaPart)) return false;

  return true;
}
