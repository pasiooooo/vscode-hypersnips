import { getAlignmentDeclaration } from './latexColumns';
import {
  findInlineLatexLiteralEnd,
  findMatchingBrace,
  INLINE_LATEX_LITERAL_COMMAND,
  LATEX_ENVIRONMENT_TOKEN,
  VERBATIM_LIKE_ENVIRONMENTS,
} from './latexContext';
import type { TextEdit } from './latexEdit';

const VISUAL_PAIRS = new Map([['(', ')'], ['[', ']'], ['\\{', '\\}']]);
const MATH_PAIRS = new Map([['\\(', '\\)'], ['\\[', '\\]'], ['$', '$'], ['$$', '$$']]);
const OPENERS = new Map([...VISUAL_PAIRS, ...MATH_PAIRS, ['{', '}'], ['\\left', '\\right'],
  ['\\begingroup', '\\endgroup'], ['\\bgroup', '\\egroup']]);
const CLOSERS = new Set(OPENERS.values());
const VISUAL_CLOSERS = new Set(VISUAL_PAIRS.values());
const MATH_CLOSERS = new Set(MATH_PAIRS.values());
const OPAQUE_ENVIRONMENTS = new Set([...VERBATIM_LIKE_ENVIRONMENTS,
  'BVerbatim', 'LVerbatim', 'SaveVerbatim', 'VerbatimOut', 'filecontents', 'filecontents*']);
const OPAQUE_ARGUMENT = /%|\\(?:verb|Verb|lstinline|mintinline)\b/;
const COMMAND_ARITIES = new Map<string, number>([
  ...'text textit textbf texttt textrm textsf textsl textsc textup textmd textnormal emph mbox underline overline mathbf mathrm mathit mathsf mathtt mathcal mathbb mathfrak mathnormal boldsymbol operatorname operatorname* sqrt'.split(' ')
    .map(name => [`\\${name}`, 1] as const),
  ...'frac dfrac tfrac binom dbinom tbinom overset underset stackrel textcolor href texorpdfstring'.split(' ')
    .map(name => [`\\${name}`, 2] as const),
  ['\\multicolumn', 3], ['\\resizebox', 3], ['\\resizebox*', 3],
]);

export type DeleteDirection = 'left' | 'right';

export interface PairedDeleteProgress {
  direction: DeleteDirection;
  boundary: TextEdit;
  partner: TextEdit;
  extras: TextEdit[];
}

export interface CommandArguments {
  command: TextEdit;
  groups: TextEdit[];
}

interface CommandHeader extends CommandArguments {
  arity: number;
  nextStart: number;
}

interface OpeningBoundary {
  start: number;
  end: number;
  closesWith: string;
  editable: boolean;
  environment?: string;
  owner?: CommandHeader;
}

type OpeningEdit = TextEdit & { environment?: string; arguments?: CommandArguments };

function skipSpace(text: string, offset: number) {
  while (/\s/.test(text[offset] || '')) offset++;
  return offset;
}

function commandArguments(text: string, header: CommandHeader): CommandArguments | undefined {
  const groups = [...header.groups];
  let start = header.nextStart;
  while (groups.length < header.arity) {
    if (text[start] === '%' || text[start] === '[') return;
    if (text[start] !== '{') break;
    const end = findMatchingBrace(text, start, text.length) + 1;
    if (!end || OPAQUE_ARGUMENT.test(text.slice(start, end))) return;
    groups.push({ start, end, text: '' });
    start = skipSpace(text, end);
  }
  return { command: header.command, groups };
}

export function findLatexBoundaryPair(text: string, offset: number, direction: DeleteDirection): [OpeningEdit, TextEdit] | undefined {
  const probe = direction === 'left' ? offset - 1 : offset;
  if (!text[probe] || !(direction === 'left' ? /[{}()[\]$]/ : /[{}()[\]$\\]/).test(text[probe])) return;

  const tokens = /\\[a-zA-Z@]+\*?|\\[^\r\n]|\$+|[{}()[\]%&]/g;
  const environmentHeader = new RegExp(LATEX_ENVIRONMENT_TOKEN.source, 'y');
  const sizedDelimiter = /[ \t]*(?:\\(?:[a-zA-Z@]+|[^ \t\r\n])|[()[\]<>./|])/y;
  const commandDefinition = /\s*(?:\{(\\[a-zA-Z@]+)\}|(\\[a-zA-Z@]+))\s*(?:\[(\d)\]\s*)?(?=[\[{])/y;
  const definedArities = new Map<string, number>();
  const stack: OpeningBoundary[] = [];
  let nextArgument: CommandHeader | undefined;
  let target: OpeningBoundary | undefined;
  const top = () => stack[stack.length - 1];
  const atBoundary = (start: number, end: number) => (direction === 'left' ? end : start) === offset;
  function dropVisualScopes() {
    while (top() && VISUAL_CLOSERS.has(top().closesWith)) {
      if (stack.pop() === target) target = undefined;
    }
  }

  let match: RegExpExecArray | null;
  while ((match = tokens.exec(text))) {
    const start = match.index;
    if (start > probe && !target) return;
    const symbol = match[0];
    let end = tokens.lastIndex;

    if (symbol === '%') {
      const newline = text.indexOf('\n', end);
      if (newline < 0) return;
      tokens.lastIndex = newline + 1;
      continue;
    }
    if (INLINE_LATEX_LITERAL_COMMAND.test(symbol)) {
      const literalEnd = findInlineLatexLiteralEnd(text, symbol, end);
      if (literalEnd === undefined) return;
      tokens.lastIndex = literalEnd;
      continue;
    }
    if (/^\\(?:if[a-zA-Z@]*|else|or|fi|unless|catcode)\*?$/.test(symbol)) return;
    if (symbol === '&' || symbol === '\\\\' || /^\\tabularnewline\*?$/.test(symbol)) {
      dropVisualScopes();
      if (top() && MATH_CLOSERS.has(top().closesWith)) top().editable = false;
      continue;
    }

    let closesWith = OPENERS.get(symbol);
    let closingKey = CLOSERS.has(symbol) ? symbol : undefined;
    let editable = /[{}()[\]$]$/.test(symbol);
    let environment: string | undefined;
    if (/^\\(?:begin|end)\*?$/.test(symbol)) {
      environmentHeader.lastIndex = start;
      const header = environmentHeader.exec(text);
      const name = header?.[2].trim();
      if (!header || !name || /[{}\\%\s]/.test(name)) return;
      end = tokens.lastIndex = environmentHeader.lastIndex;
      if (header[1] === 'begin' && OPAQUE_ENVIRONMENTS.has(name)) {
        const escaped = name.replace(/\*/g, '\\*');
        const terminator = new RegExp(`^\\\\end\\{${escaped}\\}\\r?$`, 'gm');
        terminator.lastIndex = end;
        if (!terminator.exec(text)) return;
        tokens.lastIndex = terminator.lastIndex;
        continue;
      }
      const key = `\\end{${name}}`;
      if (header[1] === 'begin') {
        closesWith = key;
        environment = name;
      }
      else closingKey = key;
      editable = !/[\r\n]/.test(header[0]);
    } else if (/^\\(?:left|middle|right|[bB]igg?[lmr]?)$/.test(symbol)) {
      sizedDelimiter.lastIndex = end;
      if (!sizedDelimiter.exec(text)) return;
      end = tokens.lastIndex = sizedDelimiter.lastIndex;
    } else if (symbol.startsWith('$')) {
      const math = stack.find((open) => MATH_CLOSERS.has(open.closesWith));
      if (symbol.length > 2 || (math && math.closesWith !== symbol)) return;
      if (math) closesWith = undefined;
    } else if (MATH_PAIRS.has(symbol) && stack.some((open) => MATH_CLOSERS.has(open.closesWith))) return;

    if (!stack.length && /^\\(?:newcommand|renewcommand|providecommand)\*?$/.test(symbol)) {
      commandDefinition.lastIndex = end;
      const definition = commandDefinition.exec(text);
      const name = definition && (definition[1] || definition[2]);
      if (name && (!symbol.startsWith('\\providecommand') || !(definedArities.has(name) || COMMAND_ARITIES.has(name)))) {
        definedArities.set(name, text[commandDefinition.lastIndex] === '{' ? Number(definition[3] || 0) : 0);
      }
    }
    const arity = definedArities.get(symbol) ?? COMMAND_ARITIES.get(symbol);
    if (arity) {
      const nextStart = skipSpace(text, end);
      nextArgument = text[nextStart] === '{' ? { command: { start, end, text: '' }, groups: [], arity, nextStart } : undefined;
    }
    if (closesWith) {
      const owner = symbol === '{' && nextArgument?.nextStart === start ? nextArgument : undefined;
      if (owner) nextArgument = undefined;
      const opening = { start, end, closesWith, editable, environment, owner };
      stack.push(opening);
      if (editable && atBoundary(start, end)) target = opening;
    } else if (closingKey) {
      const visual = VISUAL_CLOSERS.has(closingKey);
      if (!visual) dropVisualScopes();
      const opening = top();
      if (opening?.closesWith !== closingKey) {
        if (!visual) return;
        dropVisualScopes();
        continue;
      }
      stack.pop();
      if (opening.owner) {
        opening.owner.groups.push({ start: opening.start, end, text: '' });
        opening.owner.nextStart = skipSpace(text, end);
        if (opening.owner.groups.length < opening.owner.arity && text[opening.owner.nextStart] === '{') {
          nextArgument = opening.owner;
        }
      }
      if (opening.editable && editable && (opening === target || atBoundary(start, end))) {
        return [{ start: opening.start, end: opening.end, text: '', environment: opening.environment,
          arguments: opening.owner && commandArguments(text, opening.owner) }, { start, end, text: '' }];
      }
      if (opening === target) return;
    }
  }
}

function finishDeletion(text: string, pair: [OpeningEdit, TextEdit] | undefined, edits: TextEdit[],
  continued: boolean, previousCommand?: CommandArguments) {
  if (!pair) return { edits, continued };
  const [opening, closing] = pair;
  const ownsGroup = (group: TextEdit) => group.start === opening.start && group.end === closing.end;
  const command = previousCommand?.groups.some(ownsGroup) ? previousCommand :
    previousCommand && previousCommand.command.start === opening.arguments?.command.start ? undefined : opening.arguments;
  if (!command) return { edits, continued };
  const groups = command.groups.filter(group => !ownsGroup(group));
  if (!groups.length) return { edits: [...edits, command.command], continued };

  const space = command.command.end === opening.start && /[a-zA-Z@]/.test(text[opening.end] || '');
  if (space) edits = edits.map(edit => edit.start === opening.start ? { ...edit, text: ' ' } : edit);
  const shift = (offset: number) => edits.reduce((next, edit) =>
    edit.end <= offset ? next + edit.text.length - (edit.end - edit.start) : next, offset);
  return { edits, continued, remainingCommand: {
    command: { ...command.command, end: command.command.end + Number(space) },
    groups: groups.map(group => ({ ...group, start: shift(group.start), end: shift(group.end) })),
  } };
}

export function getPairedDeletePlan(text: string, start: number, end: number, direction: DeleteDirection,
  progress?: PairedDeleteProgress, previousCommand?: CommandArguments): {
    edits: TextEdit[]; continued: boolean; progress?: PairedDeleteProgress; remainingCommand?: CommandArguments;
  } | undefined {
  const offset = direction === 'left' ? end : start;
  const isHit = (boundary: TextEdit) => (direction === 'left' ? boundary.end : boundary.start) === offset;
  const continued = Boolean(progress?.direction === direction && isHit(progress.boundary));
  const match = continued ? undefined : findLatexBoundaryPair(text, offset, direction);
  const pair = continued ? [progress!.boundary, progress!.partner] : match;
  if (!pair) return;
  const [boundary, partner] = isHit(pair[0]) ? pair : [pair[1], pair[0]];
  let extras = continued ? progress!.extras : [];
  if (match?.[0].environment) {
    const base = match[0].end;
    const source = text.slice(base, match[1].start);
    const declaration = getAlignmentDeclaration(source, match[0].environment);
    if (declaration?.groups.every(group => !OPAQUE_ARGUMENT.test(group.value) &&
      (source[group.start] !== '[' || /^[bctlr]$/.test(group.value.trim())))) {
      extras = declaration.groups.map(group => ({ start: base + group.start, end: base + group.end, text: '' }));
    }
  }
  const finish = () => finishDeletion(text, match, [boundary, partner, ...extras], continued, previousCommand);
  if (start !== end) {
    if (start === boundary.start && end === boundary.end) return finish();
    return;
  }

  if (direction === 'left') {
    start--;
    if (start > boundary.start && text.codePointAt(start - 1)! > 0xffff) start--;
  } else {
    end += text.codePointAt(end)! > 0xffff ? 2 : 1;
  }
  if (start === boundary.start && end === boundary.end) return finish();

  const length = end - start;
  const shift = (edit: TextEdit) => edit.start < end ? edit : { ...edit, start: edit.start - length, end: edit.end - length };
  return {
    edits: [{ start, end, text: '' }], continued,
    progress: {
      direction, boundary: { ...boundary, end: boundary.end - length },
      partner: shift(partner), extras: extras.map(shift),
    },
  };
}
