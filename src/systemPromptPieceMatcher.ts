import { SHADOW, shadowFail, TRACE } from './perfTrace';
import { findAllMatchesWithStackFallback } from './safeRegexMatch';
import {
  generalizeExpressionIdentifiers,
  IDENTIFIER_SENTINEL,
} from './systemPromptExpressionIdentifiers';

const MIN_ANCHOR = 12;
const MAX_OCCURRENCES = 250;
export const MAX_ANCHOR_OCCURRENCES = MAX_OCCURRENCES;
export const PRISTINE_RESCANS_BEFORE_INDEX = 32;

type MatchToken =
  | { kind: 'literal'; value: string }
  | { kind: 'backslash' }
  | { kind: 'quote'; value: string }
  | { kind: 'newline' }
  | { kind: 'non-ascii'; value: string; code: number }
  | { kind: 'interpolation' }
  | { kind: 'identifier' }
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

const tokensForPiece = (piece: string): MatchToken[] => {
  const tokens: MatchToken[] = [];
  for (let i = 0; i < piece.length; ) {
    if (piece.startsWith(IDENTIFIER_SENTINEL, i)) {
      tokens.push({ kind: 'identifier' });
      i += IDENTIFIER_SENTINEL.length;
      continue;
    }
    if (piece.startsWith('${', i)) {
      let end = i + 2;
      while (end < piece.length && piece[end] !== '{' && piece[end] !== '}') {
        end++;
      }
      if (piece[end] === '}') {
        tokens.push({ kind: 'interpolation' });
        i = end + 1;
        continue;
      }
    }
    const value = piece[i];
    const code = piece.charCodeAt(i);
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
  const generalized = generalizeExpressionIdentifiers(
    pieces.map(piece => replaceMarkers(piece, version, buildTime))
  );
  for (let i = 0; i < generalized.length; i++) {
    for (const token of tokensForPiece(generalized[i])) tokens.push(token);
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

// A prompt with no long word run (a template fragment such as
// `\n</ax-summary>` or `  ${…}.path} → ${…}`) still has exact literal
// characters to narrow on. Without an anchor every lookup fell back to the
// RegExp over the whole bundle, which on a MutableText also meant joining the
// whole bundle into a fresh string first: ~1,500 of those per apply.
const buildLiteralAnchorPlan = (tokens: MatchToken[]): AnchorPlan | null => {
  let best: AnchorPlan | null = null;
  let runStart = 0;
  let run = '';
  for (let i = 0; i <= tokens.length; i++) {
    const token = tokens[i];
    if (token?.kind === 'literal') {
      if (run.length === 0) runStart = i;
      run += token.value;
      continue;
    }
    if (run.length > 0 && (!best || run.length > best.anchor.length)) {
      best = { anchor: run, tokenIndex: runStart };
    }
    run = '';
  }
  return best;
};

const compileMatcher = (spec: PromptMatchSpec): CompiledPromptMatcher => {
  const tokens = compileTokens(spec.pieces, spec.version, spec.buildTime);
  return {
    tokens,
    plan: buildAnchorPlan(tokens) ?? buildLiteralAnchorPlan(tokens),
  };
};

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
      if (sourceCharAt(content, position) !== token.value) {
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
        sourceCharAt(content, position + 1) === 'n'
      ) {
        position += 2;
        tokenIndex++;
        continue;
      }
      if (!fail()) return null;
      continue;
    }
    if (token.kind === 'non-ascii') {
      if (sourceCharAt(content, position) === token.value) {
        position++;
        tokenIndex++;
        continue;
      }
      const uForm = token.code.toString(16).padStart(4, '0');
      const sourceU = sourceSlice(content, position, position + 6);
      if (
        sourceU[0] === '\\' &&
        sourceU[1] === 'u' &&
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
          sourceX[1] === 'x' &&
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
    while (isWord(sourceCharAt(content, end))) end++;
    if (end === position) {
      if (!fail()) return null;
      continue;
    }
    for (let alternateEnd = position + 1; alternateEnd < end; alternateEnd++) {
      const nextCaptures = [...captures];
      if (token.kind === 'capture') {
        nextCaptures[token.index] = sourceSlice(
          content,
          position,
          alternateEnd
        );
      }
      alternatives.push({
        token: tokenIndex + 1,
        position: alternateEnd,
        captures: nextCaptures,
      });
    }
    if (token.kind === 'capture') {
      captures = [...captures];
      captures[token.index] = sourceSlice(content, position, end);
    }
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
    return sourceCharAt(content, end - 1) === token.value ? [end - 1] : [];
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
      sourceCharAt(content, end - 1) === 'n' &&
      sourceCharAt(content, end - 2) === '\\'
    ) {
      positions.push(end - 2);
    }
    return positions;
  }
  if (token.kind === 'non-ascii') {
    const positions: number[] = [];
    if (sourceCharAt(content, end - 1) === token.value) {
      positions.push(end - 1);
    }
    const uForm = token.code.toString(16).padStart(4, '0');
    const sourceU = sourceSlice(content, end - 6, end);
    if (
      sourceU[0] === '\\' &&
      sourceU[1] === 'u' &&
      sourceU.slice(2).toLowerCase() === uForm
    ) {
      positions.push(end - 6);
    }
    if (token.code <= 0xff) {
      const xForm = token.code.toString(16).padStart(2, '0');
      const sourceX = sourceSlice(content, end - 4, end);
      if (
        sourceX[0] === '\\' &&
        sourceX[1] === 'x' &&
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
  precomputedOccurrences?: number[] | null,
  limit = MAX_OCCURRENCES
): RegExpExecArray[] | null => {
  if (!compiled.plan) return null;
  const occurrences =
    precomputedOccurrences === undefined
      ? typeof content === 'string'
        ? allOccurrences(content, compiled.plan.anchor, limit)
        : null
      : precomputedOccurrences;
  if (!occurrences || occurrences.length > limit) return null;
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

// Anchor occurrences are found with a rolling hash over a fixed window: the
// first MIN_ANCHOR chars for a long anchor, the first SHORT_WINDOW for a short
// one (from buildLiteralAnchorPlan), so one pass over the bundle serves every
// anchor of a kind. An anchor shorter than SHORT_WINDOW is searched on its own.
const SHORT_WINDOW = 4;
const HASH_BASE = 16777619;

const hashWindowFor = (anchor: string): number =>
  anchor.length >= MIN_ANCHOR
    ? MIN_ANCHOR
    : anchor.length >= SHORT_WINDOW
      ? SHORT_WINDOW
      : 0;

const windowHash = (text: string, window: number): number => {
  let hash = 0;
  for (let i = 0; i < window; i++) {
    hash = (Math.imul(hash, HASH_BASE) + text.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const windowPower = (window: number): number => {
  let power = 1;
  for (let i = 1; i < window; i++) power = Math.imul(power, HASH_BASE) >>> 0;
  return power;
};

const addHashedAnchor = (
  byHash: Map<number, string[]>,
  anchor: string,
  window: number
): void => {
  const hash = windowHash(anchor, window);
  const current = byHash.get(hash);
  if (current) current.push(anchor);
  else byHash.set(hash, [anchor]);
};

const removeHashedAnchor = (
  byHash: Map<number, string[]>,
  anchor: string,
  window: number
): void => {
  const hash = windowHash(anchor, window);
  const remaining = byHash.get(hash)?.filter(item => item !== anchor);
  if (remaining && remaining.length > 0) byHash.set(hash, remaining);
  else byHash.delete(hash);
};

const recordOccurrence = (
  found: Map<string, number[] | null>,
  anchor: string,
  index: number
): void => {
  const positions = found.get(anchor);
  if (positions === null) return;
  if (positions === undefined) found.set(anchor, [index]);
  else if (positions.length === MAX_OCCURRENCES) found.set(anchor, null);
  else positions.push(index);
};

// Every position of every hashed anchor in `content`, overlapping ones
// included, added to `found`; an anchor past MAX_OCCURRENCES becomes null.
const scanHashedAnchors = (
  content: string,
  window: number,
  byHash: Map<number, string[]>,
  found: Map<string, number[] | null>
): void => {
  if (byHash.size === 0 || content.length < window) return;
  const power = windowPower(window);
  let hash = windowHash(content, window);
  const last = content.length - window;
  for (let index = 0; index <= last; index++) {
    const candidates = byHash.get(hash);
    if (candidates) {
      for (const anchor of candidates) {
        if (content.startsWith(anchor, index)) {
          recordOccurrence(found, anchor, index);
        }
      }
    }
    if (index === last) break;
    hash =
      (Math.imul(
        (hash - Math.imul(content.charCodeAt(index), power)) >>> 0,
        HASH_BASE
      ) +
        content.charCodeAt(index + window)) >>>
      0;
  }
};

const foldAsciiCode = (code: number): number =>
  code >= 65 && code <= 90 ? code + 32 : code;

const foldAsciiCase = (text: string): string =>
  text.replace(/[A-Z]/g, letter => letter.toLowerCase());

const startsWithFolded = (
  content: string,
  folded: string,
  index: number
): boolean => {
  if (index + folded.length > content.length) return false;
  for (let i = 0; i < folded.length; i++) {
    if (foldAsciiCode(content.charCodeAt(index + i)) !== folded.charCodeAt(i)) {
      return false;
    }
  }
  return true;
};

const scanFoldedHashedAnchors = (
  content: string,
  window: number,
  byHash: Map<number, string[]>,
  found: Map<string, number[] | null>
): void => {
  if (byHash.size === 0 || content.length < window) return;
  const power = windowPower(window);
  let hash = 0;
  for (let i = 0; i < window; i++) {
    hash =
      (Math.imul(hash, HASH_BASE) + foldAsciiCode(content.charCodeAt(i))) >>> 0;
  }
  const last = content.length - window;
  for (let index = 0; index <= last; index++) {
    const candidates = byHash.get(hash);
    if (candidates) {
      for (const anchor of candidates) {
        if (startsWithFolded(content, anchor, index)) {
          recordOccurrence(found, anchor, index);
        }
      }
    }
    if (index === last) break;
    hash =
      (Math.imul(
        (hash - Math.imul(foldAsciiCode(content.charCodeAt(index)), power)) >>>
          0,
        HASH_BASE
      ) +
        foldAsciiCode(content.charCodeAt(index + window))) >>>
      0;
  }
};

const scanTinyAnchor = (
  content: string,
  anchor: string,
  found: Map<string, number[] | null>
): void => {
  for (
    let at = content.indexOf(anchor);
    at !== -1 && found.get(anchor) !== null;
    at = content.indexOf(anchor, at + 1)
  ) {
    recordOccurrence(found, anchor, at);
  }
};

const BITMAP_SHIFT = 12;

const isLatin1 = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) return false;
  }
  return true;
};

const hashBitmap = (byHash: Map<number, string[]>): Int32Array => {
  const bitmap = new Int32Array(1 << (32 - BITMAP_SHIFT - 5));
  for (const hash of byHash.keys()) {
    const slot = hash >>> BITMAP_SHIFT;
    bitmap[slot >>> 5] |= 1 << (slot & 31);
  }
  return bitmap;
};

const scanHashedAnchorBytes = (
  content: string,
  bytes: Uint8Array,
  window: number,
  byHash: Map<number, string[]>,
  bitmap: Int32Array,
  found: Map<string, number[] | null>
): void => {
  if (byHash.size === 0 || bytes.length < window) return;
  const power = windowPower(window);
  let hash = 0;
  for (let i = 0; i < window; i++) {
    hash = (Math.imul(hash, HASH_BASE) + bytes[i]) >>> 0;
  }
  const last = bytes.length - window;
  for (let index = 0; index <= last; index++) {
    const slot = hash >>> BITMAP_SHIFT;
    if ((bitmap[slot >>> 5] & (1 << (slot & 31))) !== 0) {
      const candidates = byHash.get(hash);
      if (candidates) {
        for (const anchor of candidates) {
          if (content.startsWith(anchor, index)) {
            recordOccurrence(found, anchor, index);
          }
        }
      }
    }
    if (index === last) break;
    hash =
      (Math.imul((hash - Math.imul(bytes[index], power)) >>> 0, HASH_BASE) +
        bytes[index + window]) >>>
      0;
  }
};

const sameOccurrences = (
  a: Map<string, number[] | null>,
  b: Map<string, number[] | null>
): string | null => {
  if (a.size !== b.size) return `size ${a.size} vs ${b.size}`;
  for (const [anchor, positions] of a) {
    if (!b.has(anchor)) return anchor;
    const other = b.get(anchor);
    if (positions === null || other === null || other === undefined) {
      if (positions !== other) return anchor;
      continue;
    }
    if (
      positions.length !== other.length ||
      positions.some((position, i) => position !== other[i])
    ) {
      return anchor;
    }
  }
  return null;
};

export class AnchorIndex {
  private long = new Map<number, string[]>();
  private short = new Map<number, string[]>();
  private wideLong = new Map<number, string[]>();
  private wideShort = new Map<number, string[]>();
  private tiny = new Set<string>();
  private bitmaps: { long: Int32Array; short: Int32Array } | null = null;

  private mapFor(anchor: string, window: number): Map<number, string[]> {
    const latin1 = isLatin1(anchor);
    if (window === MIN_ANCHOR) return latin1 ? this.long : this.wideLong;
    return latin1 ? this.short : this.wideShort;
  }

  add(anchor: string): void {
    const window = hashWindowFor(anchor);
    if (window === 0) this.tiny.add(anchor);
    else {
      addHashedAnchor(this.mapFor(anchor, window), anchor, window);
      this.bitmaps = null;
    }
  }

  remove(anchor: string): void {
    const window = hashWindowFor(anchor);
    if (window === 0) this.tiny.delete(anchor);
    else {
      removeHashedAnchor(this.mapFor(anchor, window), anchor, window);
      this.bitmaps = null;
    }
  }

  // Occurrences of the indexed anchors in `content`. `skip` names anchors
  // already known to be too common; only the per-anchor tiny search can use
  // it, since a hashed pass serves all of its anchors at once.
  scan(
    content: string,
    found = new Map<string, number[] | null>(),
    skip?: (anchor: string) => boolean
  ): Map<string, number[] | null> {
    if (
      (this.long.size > 0 || this.short.size > 0) &&
      content.length >= SHORT_WINDOW
    ) {
      this.bitmaps ??= {
        long: hashBitmap(this.long),
        short: hashBitmap(this.short),
      };
      const bytes = Buffer.from(content, 'latin1');
      scanHashedAnchorBytes(
        content,
        bytes,
        MIN_ANCHOR,
        this.long,
        this.bitmaps.long,
        found
      );
      scanHashedAnchorBytes(
        content,
        bytes,
        SHORT_WINDOW,
        this.short,
        this.bitmaps.short,
        found
      );
    }
    scanHashedAnchors(content, MIN_ANCHOR, this.wideLong, found);
    scanHashedAnchors(content, SHORT_WINDOW, this.wideShort, found);
    for (const anchor of this.tiny) {
      if (!skip?.(anchor)) scanTinyAnchor(content, anchor, found);
    }
    return found;
  }

  scanByCharCodes(
    content: string,
    found = new Map<string, number[] | null>(),
    skip?: (anchor: string) => boolean
  ): Map<string, number[] | null> {
    scanHashedAnchors(content, MIN_ANCHOR, this.long, found);
    scanHashedAnchors(content, MIN_ANCHOR, this.wideLong, found);
    scanHashedAnchors(content, SHORT_WINDOW, this.short, found);
    scanHashedAnchors(content, SHORT_WINDOW, this.wideShort, found);
    for (const anchor of this.tiny) {
      if (!skip?.(anchor)) scanTinyAnchor(content, anchor, found);
    }
    return found;
  }
}

const shadowAnchorScan = (
  stage: string,
  scanned: Map<string, number[] | null>,
  reference: Map<string, number[] | null>,
  length: number
): void => {
  const differs = sameOccurrences(scanned, reference);
  if (differs !== null) {
    shadowFail('u5-anchor-scan', { stage, anchor: differs, length });
  }
  if (TRACE) TRACE.emit('shadow', { check: 'u5-anchor-scan', stage });
};

/**
 * Identity. Kept so the callers that used to hand the matcher a case-folded
 * copy keep compiling, and as the single place documenting why matching is
 * CASE-SENSITIVE.
 *
 * The `i` flag was carried for "casing inconsistencies in unicode escape
 * sequences" (`\u201C` vs `\u201c`). `escapeNonAsciiForRegex` already handles
 * exactly that, expanding every hex letter into a `[cC]` class via `hexAlt`, so
 * the flag bought nothing there and instead widened every prompt regex over its
 * own PROSE. That manufactured wrong-site ambiguity: `(no output)` occurs 6
 * times in cli.js — exactly its 6 catalogue entries — but 8 times
 * case-insensitively, so the group read as ambiguous and the override was
 * skipped entirely.
 */
export const foldPromptMatchContent = (content: string): string => content;

/**
 * The apply's token matcher on its own, without the regex fallback: the
 * matches, or null when the prompt has no usable anchor (or the anchor is too
 * common) and only the regex can decide. Synchronous, and it never compiles
 * the prompt regex, which V8 cannot do for the largest text assets.
 */
export const findPromptPieceMatchesByTokens = (
  spec: PromptMatchSpec,
  content: string
): RegExpExecArray[] | null => tokenMatches(compileMatcher(spec), content);

export interface PromptAnchorInfo {
  anchor: string | null;
  tokenKinds: string[];
}

export const promptAnchorInfo = (spec: PromptMatchSpec): PromptAnchorInfo => {
  const compiled = compileMatcher(spec);
  return {
    anchor: compiled.plan?.anchor ?? null,
    tokenKinds: [...new Set(compiled.tokens.map(token => token.kind))].sort(),
  };
};

/**
 * The token matcher over a caller-supplied list of exact, case-sensitive
 * anchor occurrences, with no occurrence cap: what the indexed apply path
 * computes below the cap, extended past it so a differential can still compare
 * the token matcher with the regex there. Null only when the prompt has no
 * anchor.
 */
export const findPromptPieceMatchesAtOccurrences = (
  spec: PromptMatchSpec,
  content: string,
  occurrences: number[]
): RegExpExecArray[] | null =>
  tokenMatches(compileMatcher(spec), content, occurrences, Infinity);

export const findAllPromptPieceMatches = async (
  spec: PromptMatchSpec,
  content: string
): Promise<RegExpExecArray[]> => {
  const matches = tokenMatches(compileMatcher(spec), content);
  if (matches) return matches;
  return findAllMatchesWithStackFallback(spec.regex, 'sg', content);
};

export class PromptPieceMatcherCatalog {
  private specs = new Map<string, PromptMatchSpec>();
  private compiled = new Map<string, CompiledPromptMatcher>();
  private anchorRegexes = new Map<string, string[]>();
  private anchors = new AnchorIndex();
  private anchorOccurrences = new Map<string, number[] | null>();
  private anchorLengthCounts = new Map<number, number>();
  private maxAnchorLength = MIN_ANCHOR;
  private pristine: {
    content: string;
    occurrences: Map<string, number[] | null>;
  } | null = null;
  private pristineRescans = 0;

  constructor(specs: PromptMatchSpec[]) {
    for (const spec of specs) {
      this.specs.set(spec.regex, spec);
      const matcher = compileMatcher(spec);
      this.compiled.set(spec.regex, matcher);
      if (!matcher.plan) continue;
      const anchor = matcher.plan.anchor;
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
    for (const anchor of this.anchorRegexes.keys()) this.anchors.add(anchor);
  }

  specFor(regex: string): PromptMatchSpec | undefined {
    return this.specs.get(regex);
  }

  delete(regex: string): void {
    const anchor = this.compiled.get(regex)?.plan?.anchor;
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
    this.anchors.remove(anchor);
  }

  index(
    content: string,
    foldedContent = foldPromptMatchContent(content)
  ): void {
    if (foldedContent.length !== content.length) {
      this.anchorOccurrences.clear();
      return;
    }
    const initial = (): Map<string, number[] | null> =>
      new Map<string, number[] | null>(
        [...this.anchorRegexes.keys()].map(anchor => [anchor, []])
      );
    this.anchorOccurrences = this.anchors.scan(foldedContent, initial());
    if (SHADOW) {
      shadowAnchorScan(
        'index',
        this.anchorOccurrences,
        this.anchors.scanByCharCodes(foldedContent, initial()),
        foldedContent.length
      );
    }
    if (TRACE) {
      TRACE.emit('index', {
        anchors: this.anchorRegexes.size,
        length: content.length,
      });
    }
  }

  indexedOccurrences(regex: string): number[] | null | undefined {
    const anchor = this.compiled.get(regex)?.plan?.anchor;
    return anchor === undefined
      ? undefined
      : this.anchorOccurrences.get(anchor);
  }

  async matchCurrent(
    regex: string,
    content: PromptMatchSource
  ): Promise<RegExpExecArray[]> {
    const spec = this.specs.get(regex);
    const matcher = this.compiled.get(regex);
    if (!spec || !matcher) return [];
    const anchor = matcher.plan?.anchor;
    const indexed = anchor
      ? tokenMatches(matcher, content, this.anchorOccurrences.get(anchor))
      : null;
    if (TRACE) {
      TRACE.emit('current', {
        by: indexed ? 'token' : 'regex',
        anchored: Boolean(anchor),
      });
    }
    const matches =
      indexed ??
      (await findAllMatchesWithStackFallback(
        spec.regex,
        'sg',
        sourceString(content)
      ));
    return matches;
  }

  private pristineOccurrences(content: string): Map<string, number[] | null> {
    if (this.pristine && this.pristine.content === content) {
      return this.pristine.occurrences;
    }
    const long = new Map<number, string[]>();
    const short = new Map<number, string[]>();
    const occurrences = new Map<string, number[] | null>();
    for (const anchor of this.anchorRegexes.keys()) {
      const window = hashWindowFor(anchor);
      const folded = foldAsciiCase(anchor);
      if (window === 0 || occurrences.has(folded)) continue;
      occurrences.set(folded, []);
      addHashedAnchor(window === MIN_ANCHOR ? long : short, folded, window);
    }
    scanFoldedHashedAnchors(content, MIN_ANCHOR, long, occurrences);
    scanFoldedHashedAnchors(content, SHORT_WINDOW, short, occurrences);
    this.pristine = { content, occurrences };
    return occurrences;
  }

  async matchPristine(
    spec: PromptMatchSpec,
    content: string
  ): Promise<RegExpExecArray[]> {
    const matcher =
      this.specs.get(spec.regex) === spec
        ? this.compiled.get(spec.regex)
        : undefined;
    const anchor = matcher?.plan?.anchor;
    if (!matcher || !anchor || hashWindowFor(anchor) === 0) {
      if (TRACE) TRACE.emit('pristine-path', { path: 'unindexable' });
      return findAllPromptPieceMatches(spec, content);
    }
    if (
      this.pristine?.content !== content &&
      this.pristineRescans < PRISTINE_RESCANS_BEFORE_INDEX
    ) {
      this.pristineRescans++;
      if (TRACE) TRACE.emit('pristine-path', { path: 'rescan' });
      return findAllPromptPieceMatches(spec, content);
    }
    const occurrences = this.pristineOccurrences(content).get(
      foldAsciiCase(anchor)
    );
    if (occurrences === undefined) {
      if (TRACE) TRACE.emit('pristine-path', { path: 'unindexed-anchor' });
      return findAllPromptPieceMatches(spec, content);
    }
    const indexed = tokenMatches(matcher, content, occurrences);
    if (TRACE) {
      TRACE.emit('pristine-path', {
        path: indexed ? 'index' : 'regex-fallback',
      });
    }
    return (
      indexed ?? findAllMatchesWithStackFallback(spec.regex, 'sg', content)
    );
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
    const local = foldPromptMatchContent(content.slice(localStart, localEnd));
    const skip = (anchor: string): boolean =>
      this.anchorOccurrences.get(anchor) === null;
    const rescanned = this.anchors.scan(local, undefined, skip);
    if (SHADOW) {
      shadowAnchorScan(
        'splice',
        rescanned,
        this.anchors.scanByCharCodes(local, undefined, skip),
        local.length
      );
    }
    for (const [anchor, positions] of rescanned) {
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
            ? this.anchorOccurrences.get(matcher.plan.anchor)
            : undefined
        );
        if (matches) results.set(regex, matches);
      }
    }
    for (const [regex, spec] of this.specs) {
      if (results.has(regex)) continue;
      results.set(
        regex,
        await findAllMatchesWithStackFallback(spec.regex, 'sg', content)
      );
    }
    return results;
  }
}

export interface PristinePromptAnswers {
  pristine: string;
  patchFilter: string[] | null;
  answers: Map<
    string,
    {
      spec: PromptMatchSpec;
      matches: RegExpExecArray[];
      accepted: Set<string[]>;
    }
  >;
}

export type PristineAnswerDecline =
  | 'noSession'
  | 'filtered'
  | 'specMismatch'
  | 'buildTimeMismatch';

const sameFilter = (
  a: string[] | null | undefined,
  b: string[] | null | undefined
): boolean => {
  if (!a || !b) return !a && !b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
};

export const pristineAnswerFor = (
  session: PristinePromptAnswers | null | undefined,
  pristine: string,
  patchFilter: string[] | null | undefined,
  spec: PromptMatchSpec
): { matches: RegExpExecArray[] } | { declined: PristineAnswerDecline } => {
  if (!session || session.pristine !== pristine) {
    return { declined: 'noSession' };
  }
  if (!sameFilter(session.patchFilter, patchFilter)) {
    return { declined: 'filtered' };
  }
  const stored = session.answers.get(spec.regex);
  if (
    !stored ||
    stored.spec.regex !== spec.regex ||
    !stored.accepted.has(spec.pieces) ||
    stored.spec.version !== spec.version
  ) {
    return { declined: 'specMismatch' };
  }
  if (stored.spec.buildTime !== spec.buildTime) {
    return { declined: 'buildTimeMismatch' };
  }
  return { matches: stored.matches };
};

export const findAllPromptPieceMatchesBatch = async (
  specs: PromptMatchSpec[],
  content: string,
  foldedContent = foldPromptMatchContent(content)
): Promise<Map<string, RegExpExecArray[]>> =>
  new PromptPieceMatcherCatalog(specs).matchBatch(content, foldedContent);
