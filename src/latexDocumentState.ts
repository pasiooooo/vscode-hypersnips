import { getLatexContext, isEscaped, LatexContextOptions, LatexEditorContext, LatexEnvironmentFrame,
  LatexMathKind, resolveLatexContextOptions, sanitizeLatexForParsing } from './latexContext';
import { LatexEnvironmentPair, MathDelimiterPair, SingleTextChange, parseBracedArguments } from './environmentConvert';

export interface LatexDocumentSnapshot {
  readonly text: string;
  contextAt(offset: number): LatexEditorContext;
  environmentPairAt(offset: number): LatexEnvironmentPair | undefined;
  displayDelimiterAt(offset: number): MathDelimiterPair | undefined;
  readonly sanitizedText: string;
  touchesEnvironmentName(change: SingleTextChange): boolean;
}

interface EnvironmentToken { kind: string; name: string; start: number; end: number; nameStart: number; nameEnd: number }
interface DelimiterToken { kind: Exclude<LatexMathKind, 'none' | 'environment'>; start: number; end: number; close: boolean }
interface TokenRef<T> { block: Block; token: T }
interface ParseState {
  environments: TokenRef<EnvironmentToken>[];
  delimiters: TokenRef<DelimiterToken>[];
  depth: number;
  textDepths: number[];
}
interface Block {
  raw: string;
  sanitized: string;
  environments: EnvironmentToken[];
  delimiters: DelimiterToken[];
  braces: { index: number; open: boolean; text: boolean }[];
}
interface Checkpoint { block: Block; before: ParseState; after: ParseState }
const EMPTY: ParseState = { environments: [], delimiters: [], depth: 0, textDepths: [] };
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseBlock(raw: string, command: RegExp, sanitized = sanitizeLatexForParsing(raw)): Block {
  // Detach slices so reused blocks cannot retain entire older document strings.
  raw = (' ' + raw).slice(1);
  sanitized = sanitized == raw ? raw : (' ' + sanitized).slice(1);
  const block: Block = { raw, sanitized, environments: [], delimiters: [], braces: [] };
  for (const match of sanitized.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
    // Cached contexts keep names after their temporary parsing prefix is discarded.
    const name = (' ' + match[2].trim()).slice(1);
    const leading = match[2].search(/\S/);
    const nameStart = match.index! + match[0].indexOf('{') + 1 + Math.max(0, leading);
    block.environments.push({ kind: match[1], name, start: match.index!, end: match.index! + match[0].length,
      nameStart, nameEnd: nameStart + name.length });
  }
  const textBraces = new Set<number>();
  for (const match of sanitized.matchAll(command)) textBraces.add(match.index! + match[0].length - 1);
  for (let index = 0; index < sanitized.length; index++) {
    const char = sanitized[index];
    if ((char == '{' || char == '}') && !isEscaped(sanitized, index)) {
      block.braces.push({ index, open: char == '{', text: textBraces.has(index) });
    }
  }
  for (let index = 0; index < sanitized.length; index++) {
    const char = sanitized[index];
    if (char == '\\') {
      const next = sanitized[index + 1];
      if ('()[]'.includes(next) && next) block.delimiters.push({
        kind: next == '(' || next == ')' ? 'paren' : 'bracket', start: index, end: index + 2,
        close: next == ')' || next == ']',
      });
      index++;
    } else if (char == '$' && !isEscaped(sanitized, index)) {
      const width = sanitized[index + 1] == '$' ? 2 : 1;
      block.delimiters.push({ kind: width == 2 ? 'displayDollar' : 'inlineDollar', start: index,
        end: index + width, close: false });
      index += width - 1;
    }
  }
  return block;
}

function advance(before: ParseState, block: Block, verbatim: string[]): ParseState {
  let environments = before.environments;
  if (block.environments.length) {
    environments = environments.slice();
    for (const token of block.environments) {
      let verbatimIndex = -1;
      for (let i = environments.length - 1; i >= 0; i--) {
        if (verbatim.includes(environments[i].token.name)) { verbatimIndex = i; break; }
      }
      if (verbatimIndex >= 0) {
        if (token.kind == 'end' && token.name == environments[verbatimIndex].token.name) environments.splice(verbatimIndex, 1);
      } else if (token.kind == 'begin') environments.push({ block, token });
      else {
        const index = environments.map((ref) => ref.token.name).lastIndexOf(token.name);
        if (index >= 0) environments.splice(index, 1);
      }
    }
  }
  let delimiters = before.delimiters;
  if (block.delimiters.length) {
    delimiters = delimiters.slice();
    for (const token of block.delimiters) {
      if (delimiters[delimiters.length - 1]?.token.kind == token.kind &&
        (token.close || token.kind == 'inlineDollar' || token.kind == 'displayDollar')) delimiters.pop();
      else if (!token.close) delimiters.push({ block, token });
    }
  }
  let depth = before.depth;
  let textDepths = before.textDepths;
  if (block.braces.length) {
    textDepths = textDepths.slice();
    for (const brace of block.braces) {
      if (brace.open) {
        depth++;
        if (brace.text) textDepths.push(depth);
      } else {
        textDepths = textDepths.filter((item) => item != depth);
        depth--;
      }
    }
  }
  return { environments, delimiters, depth, textDepths };
}

function sameState(a: ParseState, b: ParseState) {
  return a.depth == b.depth && a.textDepths.length == b.textDepths.length &&
    a.textDepths.every((depth, i) => depth == b.textDepths[i]) &&
    a.environments.length == b.environments.length && a.environments.every((ref, i) => ref == b.environments[i]) &&
    a.delimiters.length == b.delimiters.length && a.delimiters.every((ref, i) => ref == b.delimiters[i]);
}

// A block ends only where prefix sanitization cannot retroactively change previous lines.
// shortcut: open multiline constructs share a block; split them only with equivalent prefix-state handling.
function nextBlockEnd(text: string, start: number, pending: RegExp) {
  let end = start;
  let fence: { marker: string; length: number } | undefined;
  let html = false;
  let sanitizedEnd = start;
  let sanitized: string | undefined;
  let pendingCommand = '';
  let pendingEnvironment = false;
  while (end < text.length) {
    let newline = text.indexOf('\n', end);
    const next = newline == -1 ? text.length : newline + 1;
    const line = text.slice(end, newline == -1 ? text.length : newline);
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      if (!fence) fence = { marker: match[1][0], length: match[1].length };
      else if (fence.marker == match[1][0] && match[1].length >= fence.length) fence = undefined;
    }
    let htmlScan = 0;
    while (htmlScan < line.length) {
      const marker = html ? '-->' : '<!--';
      const found = line.indexOf(marker, htmlScan);
      if (found == -1) break;
      html = !html;
      htmlScan = found + marker.length;
    }
    end = next;
    if (!html && !fence) {
      let chunk = sanitizeLatexForParsing(text.slice(sanitizedEnd, end));
      sanitized = sanitizedEnd == start ? chunk : undefined;
      sanitizedEnd = end;
      if (pendingEnvironment) {
        const close = chunk.indexOf('}');
        if (close == -1) continue;
        chunk = chunk.slice(close + 1);
        pendingEnvironment = false;
      }
      const raw = pendingCommand + chunk;
      pendingCommand = '';
      if (/\\(?:begin|end)\s*\{[^}]*$/.test(raw)) {
        pendingEnvironment = true;
        continue;
      }
      const match = pending.exec(raw);
      if (!match) break;
      pendingCommand = match[0].trimEnd() + '\n';
    }
  }
  // Later chunks can change earlier prefix masks, so reuse only one complete chunk.
  return { end, sanitized: sanitizedEnd == end ? sanitized : undefined };
}

export class LatexDocumentState implements LatexDocumentSnapshot {
  readonly options: LatexContextOptions;
  readonly optionsKey: string;
  readonly reusedBlocks: number;
  readonly parsedBlocks: number;
  private readonly checkpoints: Checkpoint[];
  private readonly starts: number[] = [];
  private readonly blockOffsets = new Map<Block, number>();
  private readonly contexts = new Map<number, LatexEditorContext>();
  private readonly command: RegExp;
  private readonly pending: RegExp;
  private sanitizedCache?: string;
  private pairsCache?: LatexEnvironmentPair[];
  private delimitersCache?: MathDelimiterPair[];
  private readonly pairQueries = new Map<number, LatexEnvironmentPair | undefined>();
  private readonly delimiterQueries = new Map<number, MathDelimiterPair | undefined>();
  private readonly resolved: ReturnType<typeof resolveLatexContextOptions>;

  constructor(readonly text: string, readonly version = 1, options: LatexContextOptions = {},
    previous?: LatexDocumentState, changes: readonly SingleTextChange[] = []) {
    // Small snapshots must not retain a deleted document's larger backing string.
    text = (' ' + text).slice(1);
    this.text = text;
    this.options = JSON.parse(JSON.stringify(options));
    for (const value of Object.values(this.options)) Object.freeze(value);
    Object.freeze(this.options);
    this.optionsKey = JSON.stringify(this.options);
    this.resolved = resolveLatexContextOptions(this.options);
    this.command = new RegExp('\\\\(' + this.resolved.textLikeCommands.map(escapeRegex).join('|') + ')\\s*\\{', 'g');
    this.pending = new RegExp('\\\\(?:' + ['begin', 'end', ...this.resolved.textLikeCommands].map(escapeRegex).join('|') + ')\\s*$');
    let checkpoints: Checkpoint[] = [];
    let start = 0;
    let state = EMPTY;
    let reused = 0;
    let parsed = 0;
    const gaps: { index: number; end: number; delta: number }[] = [];
    let gapIndex = 0;
    if (previous && previous.optionsKey == this.optionsKey && version == previous.version + 1 && changes.length) {
      const sorted = changes.slice().sort((a, b) => a.rangeOffset - b.rangeOffset);
      const dirty: { first: number; last: number; delta: number }[] = [];
      for (const change of sorted) {
        const first = previous.indexAt(change.rangeOffset);
        const last = previous.indexAt(change.rangeOffset + change.rangeLength);
        const delta = change.text.length - change.rangeLength;
        const prior = dirty[dirty.length - 1];
        if (prior && first <= prior.last + 1) {
          prior.last = Math.max(prior.last, last);
          prior.delta += delta;
        } else dirty.push({ first, last, delta });
      }
      const first = dirty[0].first;
      checkpoints = previous.checkpoints.slice(0, first);
      reused = checkpoints.length;
      start = previous.starts[first] || 0;
      state = checkpoints.length ? checkpoints[checkpoints.length - 1].after : EMPTY;
      let delta = 0;
      for (let index = 0; index < dirty.length; index++) {
        delta += dirty[index].delta;
        const first = dirty[index].last + 1;
        const end = dirty[index + 1]?.first ?? previous.checkpoints.length;
        if (first < end) gaps.push({ index: first, end, delta });
      }
    }
    while (start < text.length) {
      let gap = gaps[gapIndex];
      while (previous && gap) {
        while (gap.index < gap.end && previous.starts[gap.index] + gap.delta < start) gap.index++;
        if (gap.index < gap.end) break;
        gap = gaps[++gapIndex];
      }
      if (previous && gap && previous.starts[gap.index] + gap.delta == start) {
        const old = previous.checkpoints[gap.index];
        if (sameState(state, old.before)) {
          for (let index = gap.index; index < gap.end; index++) checkpoints.push(previous.checkpoints[index]);
          reused += gap.end - gap.index;
          state = previous.checkpoints[gap.end - 1].after;
          start = (previous.starts[gap.end] ?? previous.text.length) + gap.delta;
          gap.index = gap.end;
        } else {
          const after = advance(state, old.block, this.resolved.verbatimLikeEnvironments);
          checkpoints.push({ block: old.block, before: state, after });
          state = after;
          start += old.block.raw.length;
          gap.index++;
          reused++;
        }
        continue;
      }
      const { end, sanitized } = nextBlockEnd(text, start, this.pending);
      const block = parseBlock(text.slice(start, end), this.command, sanitized);
      const after = advance(state, block, this.resolved.verbatimLikeEnvironments);
      checkpoints.push({ block, before: state, after });
      state = after;
      start = end;
      parsed++;
    }
    if (!checkpoints.length) {
      const block = parseBlock('', this.command);
      checkpoints.push({ block, before: EMPTY, after: EMPTY });
    }
    this.checkpoints = checkpoints;
    let offset = 0;
    for (const checkpoint of checkpoints) {
      this.starts.push(offset);
      this.blockOffsets.set(checkpoint.block, offset);
      offset += checkpoint.block.raw.length;
    }
    this.reusedBlocks = reused;
    this.parsedBlocks = parsed;
  }

  update(changes: readonly SingleTextChange[], version = this.version + 1, options = this.options): LatexDocumentState {
    const sorted = changes.slice().sort((a, b) => b.rangeOffset - a.rangeOffset);
    const parts: string[] = [];
    let limit = this.text.length;
    for (const change of sorted) {
      if (!Number.isInteger(change.rangeOffset) || !Number.isInteger(change.rangeLength) ||
        change.rangeOffset < 0 || change.rangeLength < 0 || change.rangeOffset + change.rangeLength > limit) {
        throw new RangeError('Invalid or overlapping document changes');
      }
      parts.push(this.text.slice(change.rangeOffset + change.rangeLength, limit), change.text);
      limit = change.rangeOffset;
    }
    parts.push(this.text.slice(0, limit));
    return new LatexDocumentState(parts.reverse().join(''), version, options, this, changes);
  }

  private indexAt(offset: number) {
    let low = 0, high = this.starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.starts[middle] <= offset) low = middle;
      else high = middle;
    }
    return low;
  }

  contextAt(offset: number): LatexEditorContext {
    offset = Math.max(0, Math.min(this.text.length, offset));
    const cached = this.contexts.get(offset);
    if (cached) return cached;
    const index = this.indexAt(offset);
    const checkpoint = this.checkpoints[index];
    const raw = checkpoint.block.raw.slice(0, offset - this.starts[index]);
    const partial = parseBlock(raw, this.command);
    const state = advance(checkpoint.before, partial, this.resolved.verbatimLikeEnvironments);
    const frames: LatexEnvironmentFrame[] = state.environments.map(({ block, token }) => {
      const base = block == partial ? this.starts[index] : this.blockOffsets.get(block)!;
      return { name: token.name, beginStart: base + token.start, beginEnd: base + token.end,
        nameStart: base + token.nameStart, nameEnd: base + token.nameEnd };
    });
    const local = getLatexContext(raw, raw.length, this.options);
    const environmentStack = frames.map((frame) => frame.name);
    const inVerbatimLikeEnvironment = environmentStack.some((name) => this.resolved.verbatimLikeEnvironments.includes(name));
    const inTextLikeCommand = state.textDepths.length > 0;
    const blocked = local.inComment || local.inMarkdownCode || inVerbatimLikeEnvironment || inTextLikeCommand;
    const delimiter = state.delimiters[state.delimiters.length - 1]?.token.kind;
    const inMath = !blocked && (Boolean(delimiter) || environmentStack.some((name) => this.resolved.mathEnvironments.includes(name)));
    const canSmartEnter = !blocked && environmentStack.some((name) => this.resolved.rowBreakEnvironments.includes(name));
    const canSmartTab = !blocked && environmentStack.some((name) => this.resolved.alignmentEnvironments.includes(name));
    const context: LatexEditorContext = { ...local, environmentStack, environmentFrames: frames,
      currentEnvironment: environmentStack[environmentStack.length - 1], currentEnvironmentFrame: frames[frames.length - 1],
      inVerbatimLikeEnvironment, inTextLikeCommand, inMath, mathKind: inMath ? delimiter || 'environment' : 'none',
      canSmartEnter, canSmartTab, canInsertAlignmentSeparator: canSmartTab, canExpandMathSnippet: inMath };
    frames.forEach(Object.freeze);
    Object.freeze(frames);
    Object.freeze(environmentStack);
    Object.freeze(context);
    if (this.contexts.size >= 32) this.contexts.delete(this.contexts.keys().next().value!);
    this.contexts.set(offset, context);
    return context;
  }

  get sanitizedText() {
    if (this.sanitizedCache == undefined) this.sanitizedCache = this.checkpoints.map(({ block }) => block.sanitized).join('');
    return this.sanitizedCache;
  }

  private buildPairs() {
    if (this.pairsCache) return;
    const pairs: LatexEnvironmentPair[] = [];
    const delimiters: MathDelimiterPair[] = [];
    for (let i = 0; i < this.checkpoints.length; i++) {
      const { block, before } = this.checkpoints[i];
      const base = this.starts[i];
      if (!block.environments.length && !block.delimiters.length) continue;
      const environments = before.environments.slice();
      for (const token of block.environments) {
        const verbatim = [...environments].reverse().find((ref) => this.resolved.verbatimLikeEnvironments.includes(ref.token.name));
        if (verbatim) {
          if (token.kind == 'end' && token.name == verbatim.token.name) environments.splice(environments.indexOf(verbatim), 1);
          continue;
        }
        if (token.kind == 'begin') { environments.push({ block, token }); continue; }
        const index = environments.map((ref) => ref.token.name).lastIndexOf(token.name);
        if (index < 0) continue;
        const begin = environments.splice(index, 1)[0];
        const beginBase = this.blockOffsets.get(begin.block)!;
        const beginEnd = beginBase + begin.token.end;
        pairs.push({ name: token.name, beginStart: beginBase + begin.token.start, beginEnd,
          beginNameStart: beginBase + begin.token.nameStart, beginNameEnd: beginBase + begin.token.nameEnd,
          endStart: base + token.start, endEnd: base + token.end,
          endNameStart: base + token.nameStart, endNameEnd: base + token.nameEnd,
          beginArguments: parseBracedArguments(this.text, beginEnd) });
      }
      const stack = before.delimiters.slice();
      for (const token of block.delimiters) {
        if (stack[stack.length - 1]?.token.kind == token.kind &&
          (token.close || token.kind == 'inlineDollar' || token.kind == 'displayDollar')) {
          const open = stack.pop()!;
          if (token.kind == 'bracket' || token.kind == 'displayDollar') {
            const openBase = this.blockOffsets.get(open.block)!;
            delimiters.push({ kind: token.kind, openStart: openBase + open.token.start, openEnd: openBase + open.token.end,
              closeStart: base + token.start, closeEnd: base + token.end });
          }
        } else if (!token.close) stack.push({ block, token });
      }
    }
    for (const pair of pairs) {
      pair.beginArguments.forEach(Object.freeze);
      Object.freeze(pair.beginArguments);
      Object.freeze(pair);
    }
    delimiters.forEach(Object.freeze);
    this.pairsCache = pairs;
    this.delimitersCache = delimiters;
  }

  environmentPairAt(offset: number) {
    if (this.pairQueries.has(offset)) return this.pairQueries.get(offset);
    this.buildPairs();
    const pair = this.pairsCache!.filter((pair) => pair.beginStart <= offset && offset <= pair.endEnd)
      .sort((a, b) => (a.endEnd - a.beginStart) - (b.endEnd - b.beginStart))[0];
    if (this.pairQueries.size >= 32) this.pairQueries.delete(this.pairQueries.keys().next().value!);
    this.pairQueries.set(offset, pair);
    return pair;
  }
  displayDelimiterAt(offset: number) {
    if (this.delimiterQueries.has(offset)) return this.delimiterQueries.get(offset);
    this.buildPairs();
    const pair = this.delimitersCache!.filter((pair) => pair.openStart <= offset && offset <= pair.closeEnd)
      .sort((a, b) => (a.closeEnd - a.openStart) - (b.closeEnd - b.openStart))[0];
    if (this.delimiterQueries.size >= 32) this.delimiterQueries.delete(this.delimiterQueries.keys().next().value!);
    this.delimiterQueries.set(offset, pair);
    return pair;
  }
  touchesEnvironmentName(change: SingleTextChange) {
    const end = change.rangeOffset + change.rangeLength;
    for (let index = this.indexAt(change.rangeOffset); index < this.checkpoints.length && this.starts[index] <= end; index++) {
      const base = this.starts[index];
      if (this.checkpoints[index].block.environments.some((token) => change.rangeLength == 0
        ? base + token.nameStart <= end && end <= base + token.nameEnd
        : change.rangeOffset < base + token.nameEnd && end > base + token.nameStart)) return true;
    }
    return false;
  }
}

