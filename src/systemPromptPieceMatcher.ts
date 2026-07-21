import { findAllMatchesWithStackFallback } from './safeRegexMatch';

const MIN_ANCHOR = 12;
const MAX_OCCURRENCES = 250;

type MatchToken =
  | { kind: 'literal'; value: string }
  | { kind: 'backslash' }
  | { kind: 'quote'; value: string }
  | { kind: 'newline' }
  | { kind: 'non-ascii'; value: string; code: number }
  | { kind: 'interpolation' }
  | { kind: 'member' }
  | { kind: 'capture'; index: number };

interface AnchorPlan {
  anchor: string;
  tokenIndex: number;
}

interface CompiledPromptMatcher {
  tokens: MatchToken[];
  plan: AnchorPlan | null;
}

export interface PromptMatchSpec {
  regex: string;
  pieces: string[];
  version: string;
  buildTime?: string;
}

export interface PromptMatchSplice {
  start: number;
  end: number;
  replacementLength: number;
}

export interface PromptMatchText {
  length: number;
  charAt(index: number): string;
  slice(start: number, end: number): string;
  toString(): string;
}

type PromptMatchSource = string | PromptMatchText;

interface MatchState {
  token: number;
  position: number;
  captures: string[];
}

const sourceLength = (content: PromptMatchSource): number => content.length;

const sourceCharAt = (content: PromptMatchSource, index: number): string =>
  typeof content === 'string' ? (content[index] ?? '') : content.charAt(index);

const sourceSlice = (
  content: PromptMatchSource,
  start: number,
  end: number
): string => content.slice(start, end);

const sourceString = (content: PromptMatchSource): string =>
  typeof content === 'string' ? content : content.toString();

const replaceMarkers = (
  text: string,
  version: string,
  buildTime: string | undefined
): string => {
  let result = text.replace(/<<CCVERSION>>/g, version);
  if (buildTime) result = result.replace(/<<BUILD_TIME>>/g, buildTime);
  return result;
};

const tokensForPiece = (piece: string, pieceIndex: number): MatchToken[] => {
  const tokens: MatchToken[] = [];
  let rest = piece;
  if (pieceIndex > 0) {
    const member = rest.match(/^\[[A-Za-z_$][\w$]*\](?=\})/);
    if (member) {
      tokens.push({ kind: 'member' });
      rest = rest.slice(member[0].length);
    }
  }
  for (let i = 0; i < rest.length; ) {
    if (rest.startsWith('${', i)) {
      let end = i + 2;
      while (end < rest.length && rest[end] !== '{' && rest[end] !== '}') {
        end++;
      }
      if (rest[end] === '}') {
        tokens.push({ kind: 'interpolation' });
        i = end + 1;
        continue;
      }
    }
    const value = rest[i];
    const code = rest.charCodeAt(i);
    if (value === '\\') tokens.push({ kind: 'backslash' });
    else if (value === '"' || value === "'" || value === '`') {
      tokens.push({ kind: 'quote', value });
    } else if (value === '\n') tokens.push({ kind: 'newline' });
    else if (code > 0x7f) {
      tokens.push({ kind: 'non-ascii', value, code });
    } else tokens.push({ kind: 'literal', value });
    i++;
  }
  return tokens;
};

const compileTokens = (
  pieces: string[],
  version: string,
  buildTime: string | undefined
): MatchToken[] => {
  const tokens: MatchToken[] = [];
  let capture = 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = replaceMarkers(pieces[i], version, buildTime);
    for (const token of tokensForPiece(piece, i)) tokens.push(token);
    if (i < pieces.length - 1) {
      tokens.push({ kind: 'capture', index: capture++ });
    }
  }
  return tokens;
};

const buildAnchorPlan = (tokens: MatchToken[]): AnchorPlan | null => {
  let best: AnchorPlan | null = null;
  let runStart = 0;
  let run = '';
  const consider = (): void => {
    const leading = run.match(/^ */)?.[0].length ?? 0;
    const trailing = run.match(/ *$/)?.[0].length ?? 0;
    const anchor = run.slice(leading, run.length - trailing);
    if (
      anchor.length >= MIN_ANCHOR &&
      (!best || anchor.length > best.anchor.length)
    ) {
      best = { anchor, tokenIndex: runStart + leading };
    }
  };
  for (let i = 0; i <= tokens.length; i++) {
    const token = tokens[i];
    if (token?.kind === 'literal' && /[A-Za-z0-9 ]/.test(token.value)) {
      if (run.length === 0) runStart = i;
      run += token.value;
      continue;
    }
    consider();
    run = '';
  }
  return best;
};

const compileMatcher = (spec: PromptMatchSpec): CompiledPromptMatcher => {
  const tokens = compileTokens(spec.pieces, spec.version, spec.buildTime);
  return { tokens, plan: buildAnchorPlan(tokens) };
};

const caseInsensitiveEqual = (
  left: string | undefined,
  right: string
): boolean => {
  if (left === undefined) return false;
  if (left === right) return true;
  const leftCode = left.charCodeAt(0);
  const rightCode = right.charCodeAt(0);
  if (leftCode < 0x80 && rightCode < 0x80) {
    const fold = (code: number): number =>
      code >= 65 && code <= 90 ? code + 32 : code;
    return fold(leftCode) === fold(rightCode);
  }
  let matcher = nonAsciiCaseMatchers.get(right);
  if (!matcher) {
    matcher = new RegExp(
      `^(?:${right.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`,
      'i'
    );
    nonAsciiCaseMatchers.set(right, matcher);
  }
  return matcher.test(left);
};

const nonAsciiCaseMatchers = new Map<string, RegExp>();

const isWord = (value: string | undefined): boolean => {
  if (value === '$' || value === '_') return true;
  if (value === undefined) return false;
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
};

const matchTokensAt = (
  tokens: MatchToken[],
  content: PromptMatchSource,
  start: number
): RegExpExecArray | null => {
  let tokenIndex = 0;
  let position = start;
  let captures: string[] = [];
  const alternatives: MatchState[] = [];
  const fail = (): boolean => {
    const state = alternatives.pop();
    if (!state) return false;
    tokenIndex = state.token;
    position = state.position;
    captures = state.captures;
    return true;
  };

  while (true) {
    if (tokenIndex === tokens.length) {
      const result = [
        sourceSlice(content, start, position),
        ...captures,
      ] as unknown as RegExpExecArray;
      result.index = start;
      result.input = typeof content === 'string' ? content : '';
      return result;
    }
    const token = tokens[tokenIndex];
    if (token.kind === 'literal') {
      if (!caseInsensitiveEqual(sourceCharAt(content, position), token.value)) {
        if (!fail()) return null;
        continue;
      }
      position++;
      tokenIndex++;
      continue;
    }
    if (token.kind === 'backslash') {
      if (sourceCharAt(content, position) !== '\\') {
        if (!fail()) return null;
        continue;
      }
      if (sourceCharAt(content, position + 1) === '\\') {
        alternatives.push({
          token: tokenIndex + 1,
          position: position + 2,
          captures: [...captures],
        });
      }
      position++;
      tokenIndex++;
      continue;
    }
    if (token.kind === 'quote') {
      if (sourceCharAt(content, position) === token.value) {
        position++;
        tokenIndex++;
        continue;
      }
      if (
        sourceCharAt(content, position) === '\\' &&
        sourceCharAt(content, position + 1) === token.value
      ) {
        position += 2;
        tokenIndex++;
        continue;
      }
      if (!fail()) return null;
      continue;
    }
    if (token.kind === 'newline') {
      if (sourceCharAt(content, position) === '\n') {
        position++;
        tokenIndex++;
        continue;
      }
      if (
        sourceCharAt(content, position) === '\\' &&
        caseInsensitiveEqual(sourceCharAt(content, position + 1), 'n')
      ) {
        position += 2;
        tokenIndex++;
        continue;
      }
      if (!fail()) return null;
      continue;
    }
    if (token.kind === 'non-ascii') {
      if (caseInsensitiveEqual(sourceCharAt(content, position), token.value)) {
        position++;
        tokenIndex++;
        continue;
      }
      const uForm = token.code.toString(16).padStart(4, '0');
      const sourceU = sourceSlice(content, position, position + 6);
      if (
        sourceU[0] === '\\' &&
        caseInsensitiveEqual(sourceU[1], 'u') &&
        sourceU.slice(2).toLowerCase() === uForm
      ) {
        position += 6;
        tokenIndex++;
        continue;
      }
      if (token.code <= 0xff) {
        const xForm = token.code.toString(16).padStart(2, '0');
        const sourceX = sourceSlice(content, position, position + 4);
        if (
          sourceX[0] === '\\' &&
          caseInsensitiveEqual(sourceX[1], 'x') &&
          sourceX.slice(2).toLowerCase() === xForm
        ) {
          position += 4;
          tokenIndex++;
          continue;
        }
      }
      if (!fail()) return null;
      continue;
    }
    if (token.kind === 'interpolation') {
      if (
        sourceCharAt(content, position) !== '$' ||
        sourceCharAt(content, position + 1) !== '{'
      ) {
        if (!fail()) return null;
        continue;
      }
      let end = position + 2;
      while (
        end < sourceLength(content) &&
        sourceCharAt(content, end) !== '{' &&
        sourceCharAt(content, end) !== '}'
      ) {
        end++;
      }
      if (sourceCharAt(content, end) !== '}') {
        if (!fail()) return null;
        continue;
      }
      position = end + 1;
      tokenIndex++;
      continue;
    }
    let end = position;
    if (token.kind === 'member') {
      if (sourceCharAt(content, end) !== '[') {
        if (!fail()) return null;
        continue;
      }
      end++;
      const wordStart = end;
      while (isWord(sourceCharAt(content, end))) end++;
      if (end === wordStart || sourceCharAt(content, end) !== ']') {
        if (!fail()) return null;
        continue;
      }
      position = end + 1;
      tokenIndex++;
      continue;
    }
    while (isWord(sourceCharAt(content, end))) end++;
    if (end === position) {
      if (!fail()) return null;
      continue;
    }
    for (let alternateEnd = position + 1; alternateEnd < end; alternateEnd++) {
      const nextCaptures = [...captures];
      nextCaptures[token.index] = sourceSlice(content, position, alternateEnd);
      alternatives.push({
        token: tokenIndex + 1,
        position: alternateEnd,
        captures: nextCaptures,
      });
    }
    captures = [...captures];
    captures[token.index] = sourceSlice(content, position, end);
    position = end;
    tokenIndex++;
  }
};

const reverseTokenPositions = (
  token: MatchToken,
  content: PromptMatchSource,
  end: number
): number[] => {
  if (token.kind === 'literal') {
    return caseInsensitiveEqual(sourceCharAt(content, end - 1), token.value)
      ? [end - 1]
      : [];
  }
  if (token.kind === 'backslash') {
    const positions: number[] = [];
    if (sourceCharAt(content, end - 1) === '\\') positions.push(end - 1);
    if (
      sourceCharAt(content, end - 1) === '\\' &&
      sourceCharAt(content, end - 2) === '\\'
    ) {
      positions.push(end - 2);
    }
    return positions;
  }
  if (token.kind === 'quote') {
    const positions: number[] = [];
    if (sourceCharAt(content, end - 1) === token.value) positions.push(end - 1);
    if (
      sourceCharAt(content, end - 1) === token.value &&
      sourceCharAt(content, end - 2) === '\\'
    ) {
      positions.push(end - 2);
    }
    return positions;
  }
  if (token.kind === 'newline') {
    const positions: number[] = [];
    if (sourceCharAt(content, end - 1) === '\n') positions.push(end - 1);
    if (
      caseInsensitiveEqual(sourceCharAt(content, end - 1), 'n') &&
      sourceCharAt(content, end - 2) === '\\'
    ) {
      positions.push(end - 2);
    }
    return positions;
  }
  if (token.kind === 'non-ascii') {
    const positions: number[] = [];
    if (caseInsensitiveEqual(sourceCharAt(content, end - 1), token.value)) {
      positions.push(end - 1);
    }
    const uForm = token.code.toString(16).padStart(4, '0');
    const sourceU = sourceSlice(content, end - 6, end);
    if (
      sourceU[0] === '\\' &&
      caseInsensitiveEqual(sourceU[1], 'u') &&
      sourceU.slice(2).toLowerCase() === uForm
    ) {
      positions.push(end - 6);
    }
    if (token.code <= 0xff) {
      const xForm = token.code.toString(16).padStart(2, '0');
      const sourceX = sourceSlice(content, end - 4, end);
      if (
        sourceX[0] === '\\' &&
        caseInsensitiveEqual(sourceX[1], 'x') &&
        sourceX.slice(2).toLowerCase() === xForm
      ) {
        positions.push(end - 4);
      }
    }
    return positions;
  }
  if (token.kind === 'interpolation') {
    if (sourceCharAt(content, end - 1) !== '}') return [];
    let start = end - 2;
    while (
      start >= 0 &&
      sourceCharAt(content, start) !== '{' &&
      sourceCharAt(content, start) !== '}'
    ) {
      start--;
    }
    return sourceCharAt(content, start) === '{' &&
      sourceCharAt(content, start - 1) === '$'
      ? [start - 1]
      : [];
  }
  if (token.kind === 'member') {
    if (sourceCharAt(content, end - 1) !== ']') return [];
    let start = end - 2;
    const wordEnd = start;
    while (start >= 0 && isWord(sourceCharAt(content, start))) start--;
    return start < wordEnd && sourceCharAt(content, start) === '['
      ? [start]
      : [];
  }
  const positions: number[] = [];
  let start = end - 1;
  while (start >= 0 && isWord(sourceCharAt(content, start))) {
    positions.push(start);
    start--;
  }
  return positions;
};

const startsForAnchor = (
  tokens: MatchToken[],
  content: PromptMatchSource,
  plan: AnchorPlan,
  anchorPosition: number
): number[] => {
  let positions = new Set([anchorPosition]);
  for (let tokenIndex = plan.tokenIndex - 1; tokenIndex >= 0; tokenIndex--) {
    const next = new Set<number>();
    for (const end of positions) {
      for (const start of reverseTokenPositions(
        tokens[tokenIndex],
        content,
        end
      )) {
        next.add(start);
      }
    }
    if (next.size === 0) return [];
    positions = next;
  }
  return [...positions];
};

const allOccurrences = (
  content: string,
  needle: string,
  limit: number
): number[] | null => {
  const found: number[] = [];
  const regex = new RegExp(
    `(?=${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`,
    'gi'
  );
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    found.push(match.index);
    if (found.length > limit) return null;
    regex.lastIndex = match.index + 1;
  }
  return found;
};

const tokenMatches = (
  compiled: CompiledPromptMatcher,
  content: PromptMatchSource,
  precomputedOccurrences?: number[] | null
): RegExpExecArray[] | null => {
  if (!compiled.plan) return null;
  const occurrences =
    precomputedOccurrences === undefined
      ? typeof content === 'string'
        ? allOccurrences(content, compiled.plan.anchor, MAX_OCCURRENCES)
        : null
      : precomputedOccurrences;
  if (!occurrences || occurrences.length > MAX_OCCURRENCES) return null;
  const starts = new Set<number>();
  for (const occurrence of occurrences) {
    for (const start of startsForAnchor(
      compiled.tokens,
      content,
      compiled.plan,
      occurrence
    )) {
      starts.add(start);
    }
  }
  const matches: RegExpExecArray[] = [];
  for (const start of [...starts].sort((a, b) => a - b)) {
    const match = matchTokensAt(compiled.tokens, content, start);
    if (match) matches.push(match);
  }
  const nonOverlapping: RegExpExecArray[] = [];
  let end = -1;
  for (const match of matches) {
    if (match.index < end) continue;
    nonOverlapping.push(match);
    end = match.index + match[0].length;
  }
  return nonOverlapping;
};

const batchOccurrences = (
  foldedContent: string,
  anchors: string[]
): Map<string, number[] | null> => {
  const unique = [...new Set(anchors.map(anchor => anchor.toLowerCase()))];
  const found = new Map<string, number[] | null>(
    unique.map(anchor => [anchor, []])
  );
  if (foldedContent.length < MIN_ANCHOR) return found;
  const base = 16777619;
  const byHash = new Map<number, string[]>();
  const hashText = (text: string): number => {
    let hash = 0;
    for (let i = 0; i < MIN_ANCHOR; i++) {
      hash = (Math.imul(hash, base) + text.charCodeAt(i)) >>> 0;
    }
    return hash;
  };
  for (const anchor of unique) {
    const hash = hashText(anchor);
    const current = byHash.get(hash);
    if (current) current.push(anchor);
    else byHash.set(hash, [anchor]);
  }
  let power = 1;
  for (let i = 1; i < MIN_ANCHOR; i++) {
    power = Math.imul(power, base) >>> 0;
  }
  let hash = hashText(foldedContent);
  const last = foldedContent.length - MIN_ANCHOR;
  for (let index = 0; index <= last; index++) {
    const candidates = byHash.get(hash);
    if (candidates) {
      for (const anchor of candidates) {
        if (foldedContent.startsWith(anchor, index)) {
          const positions = found.get(anchor);
          if (positions === null || positions === undefined) continue;
          if (positions.length === MAX_OCCURRENCES) found.set(anchor, null);
          else positions.push(index);
        }
      }
    }
    if (index === last) break;
    hash =
      (Math.imul(
        (hash - Math.imul(foldedContent.charCodeAt(index), power)) >>> 0,
        base
      ) +
        foldedContent.charCodeAt(index + MIN_ANCHOR)) >>>
      0;
  }
  return found;
};

export const foldPromptMatchContent = (content: string): string => {
  return content.replace(/[A-Z]/g, char => char.toLowerCase());
};

export const findAllPromptPieceMatches = async (
  spec: PromptMatchSpec,
  content: string
): Promise<RegExpExecArray[]> => {
  const matches = tokenMatches(compileMatcher(spec), content);
  if (matches) return matches;
  return findAllMatchesWithStackFallback(spec.regex, 'sig', content);
};

export class PromptPieceMatcherCatalog {
  private specs = new Map<string, PromptMatchSpec>();
  private compiled = new Map<string, CompiledPromptMatcher>();
  private anchorRegexes = new Map<string, string[]>();
  private anchorHashes = new Map<number, string[]>();
  private anchorOccurrences = new Map<string, number[] | null>();
  private anchorLengthCounts = new Map<number, number>();
  private maxAnchorLength = MIN_ANCHOR;

  constructor(specs: PromptMatchSpec[]) {
    for (const spec of specs) {
      this.specs.set(spec.regex, spec);
      const matcher = compileMatcher(spec);
      this.compiled.set(spec.regex, matcher);
      if (!matcher.plan) continue;
      const anchor = matcher.plan.anchor.toLowerCase();
      const regexes = this.anchorRegexes.get(anchor);
      if (regexes) regexes.push(spec.regex);
      else {
        this.anchorRegexes.set(anchor, [spec.regex]);
        this.anchorLengthCounts.set(
          anchor.length,
          (this.anchorLengthCounts.get(anchor.length) ?? 0) + 1
        );
        this.maxAnchorLength = Math.max(this.maxAnchorLength, anchor.length);
      }
    }
    for (const anchor of this.anchorRegexes.keys()) {
      const hash = anchorPrefixHash(anchor);
      const anchors = this.anchorHashes.get(hash);
      if (anchors) anchors.push(anchor);
      else this.anchorHashes.set(hash, [anchor]);
    }
  }

  delete(regex: string): void {
    const anchor = this.compiled.get(regex)?.plan?.anchor.toLowerCase();
    this.specs.delete(regex);
    this.compiled.delete(regex);
    if (!anchor) return;
    const regexes = this.anchorRegexes
      .get(anchor)
      ?.filter(item => item !== regex);
    if (regexes && regexes.length > 0) {
      this.anchorRegexes.set(anchor, regexes);
      return;
    }
    this.anchorRegexes.delete(anchor);
    this.anchorOccurrences.delete(anchor);
    const lengthCount = (this.anchorLengthCounts.get(anchor.length) ?? 1) - 1;
    if (lengthCount > 0)
      this.anchorLengthCounts.set(anchor.length, lengthCount);
    else this.anchorLengthCounts.delete(anchor.length);
    if (anchor.length === this.maxAnchorLength && lengthCount === 0) {
      this.maxAnchorLength = Math.max(
        MIN_ANCHOR,
        ...this.anchorLengthCounts.keys()
      );
    }
    const hash = anchorPrefixHash(anchor);
    const anchors = this.anchorHashes
      .get(hash)
      ?.filter(item => item !== anchor);
    if (anchors && anchors.length > 0) this.anchorHashes.set(hash, anchors);
    else this.anchorHashes.delete(hash);
  }

  index(
    content: string,
    foldedContent = foldPromptMatchContent(content)
  ): void {
    if (foldedContent.length !== content.length) {
      this.anchorOccurrences.clear();
      return;
    }
    this.anchorOccurrences = batchOccurrences(
      foldedContent,
      [...this.compiled.values()].flatMap(value =>
        value.plan ? [value.plan.anchor] : []
      )
    );
  }

  async matchCurrent(
    regex: string,
    content: PromptMatchSource
  ): Promise<RegExpExecArray[]> {
    const spec = this.specs.get(regex);
    const matcher = this.compiled.get(regex);
    if (!spec || !matcher) return [];
    const anchor = matcher.plan?.anchor.toLowerCase();
    const indexed = anchor
      ? tokenMatches(matcher, content, this.anchorOccurrences.get(anchor))
      : null;
    const matches =
      indexed ??
      (await findAllMatchesWithStackFallback(
        spec.regex,
        'sig',
        sourceString(content)
      ));
    return matches;
  }

  recordSplice(content: PromptMatchText, splice: PromptMatchSplice): void {
    const delta = splice.replacementLength - (splice.end - splice.start);
    for (const [anchor, positions] of this.anchorOccurrences) {
      if (positions === null) continue;
      const mapped: number[] = [];
      for (const position of positions) {
        if (position + anchor.length <= splice.start) mapped.push(position);
        else if (position >= splice.end) mapped.push(position + delta);
      }
      this.anchorOccurrences.set(anchor, mapped);
    }

    const localStart = Math.max(0, splice.start - this.maxAnchorLength + 1);
    const localEnd = Math.min(
      content.length,
      splice.start + splice.replacementLength + this.maxAnchorLength - 1
    );
    const local = content.slice(localStart, localEnd);
    for (const [anchor, positions] of indexedAnchorOccurrences(
      foldPromptMatchContent(local),
      this.anchorHashes
    )) {
      const current = this.anchorOccurrences.get(anchor);
      if (current === null || positions === null) {
        this.anchorOccurrences.set(anchor, null);
        continue;
      }
      const combined = [
        ...new Set([
          ...(current ?? []),
          ...positions.map(at => localStart + at),
        ]),
      ].sort((a, b) => a - b);
      this.anchorOccurrences.set(
        anchor,
        combined.length > MAX_OCCURRENCES ? null : combined
      );
    }
  }

  async matchBatch(
    content: string,
    foldedContent = foldPromptMatchContent(content)
  ): Promise<Map<string, RegExpExecArray[]>> {
    const results = new Map<string, RegExpExecArray[]>();
    if (foldedContent.length === content.length) {
      this.index(content, foldedContent);
      for (const [regex, matcher] of this.compiled) {
        const matches = tokenMatches(
          matcher,
          content,
          matcher.plan
            ? this.anchorOccurrences.get(matcher.plan.anchor.toLowerCase())
            : undefined
        );
        if (matches) results.set(regex, matches);
      }
    }
    for (const [regex, spec] of this.specs) {
      if (results.has(regex)) continue;
      results.set(
        regex,
        await findAllMatchesWithStackFallback(spec.regex, 'sig', content)
      );
    }
    return results;
  }
}

const ANCHOR_HASH_BASE = 16777619;
let anchorHashPower = 1;
for (let i = 1; i < MIN_ANCHOR; i++) {
  anchorHashPower = Math.imul(anchorHashPower, ANCHOR_HASH_BASE) >>> 0;
}

const anchorPrefixHash = (text: string): number => {
  let hash = 0;
  for (let i = 0; i < MIN_ANCHOR; i++) {
    hash = (Math.imul(hash, ANCHOR_HASH_BASE) + text.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const indexedAnchorOccurrences = (
  foldedContent: string,
  byHash: Map<number, string[]>
): Map<string, number[] | null> => {
  const found = new Map<string, number[] | null>();
  if (foldedContent.length < MIN_ANCHOR) return found;
  let hash = anchorPrefixHash(foldedContent);
  const last = foldedContent.length - MIN_ANCHOR;
  for (let index = 0; index <= last; index++) {
    const candidates = byHash.get(hash);
    if (candidates) {
      for (const anchor of candidates) {
        if (!foldedContent.startsWith(anchor, index)) continue;
        const positions = found.get(anchor);
        if (positions === null) continue;
        if (positions === undefined) found.set(anchor, [index]);
        else if (positions.length === MAX_OCCURRENCES) found.set(anchor, null);
        else positions.push(index);
      }
    }
    if (index === last) break;
    hash =
      (Math.imul(
        (hash - Math.imul(foldedContent.charCodeAt(index), anchorHashPower)) >>>
          0,
        ANCHOR_HASH_BASE
      ) +
        foldedContent.charCodeAt(index + MIN_ANCHOR)) >>>
      0;
  }
  return found;
};

export const findAllPromptPieceMatchesBatch = async (
  specs: PromptMatchSpec[],
  content: string,
  foldedContent = foldPromptMatchContent(content)
): Promise<Map<string, RegExpExecArray[]>> =>
  new PromptPieceMatcherCatalog(specs).matchBatch(content, foldedContent);
