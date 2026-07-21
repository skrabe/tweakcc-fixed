/**
 * Pure, dependency-free primitives shared by the system-prompt apply path and
 * the apply preflight (`--validate-system-prompts`). Kept in a leaf module so
 * both `patches/systemPrompts.ts` and `systemPromptPreflight.ts` can use the
 * SAME resolution and lint logic without an import cycle through
 * `patches/index.ts`.
 */

const JS_GLOBAL_NAMES = new Set([
  'JSON',
  'Math',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Symbol',
  'BigInt',
  'Error',
  'TypeError',
  'RangeError',
  'Infinity',
  'NaN',
  'undefined',
  'globalThis',
  'console',
  'process',
  'Buffer',
  'URL',
  'URLSearchParams',
  'Intl',
  'Reflect',
  'Proxy',
  'Function',
]);

export const isTweakccHumanName = (name: string): boolean =>
  name.length > 3 && !JS_GLOBAL_NAMES.has(name);

export const leakedPromptPlaceholders = (
  interpolatedContent: string,
  markdownContent: string,
  identifierMapUnion: Set<string>
): string[] => {
  const placeholderRe = /(?<!\\)\$\{([A-Za-z_][A-Za-z0-9_]*)/g;
  const inOutput = new Set(
    [...interpolatedContent.matchAll(placeholderRe)].map(match => match[1])
  );
  return [...inOutput].filter(
    name =>
      isTweakccHumanName(name) &&
      identifierMapUnion.has(name) &&
      new RegExp('(?<!\\\\)\\$\\{' + name + '(?![A-Za-z0-9_])').test(
        markdownContent
      )
  );
};

export type MatchLike = RegExpMatchArray | RegExpExecArray;

/**
 * Whether cli.js stores non-ASCII as `\uXXXX` escapes (the Bun native build
 * does). Every injection surface must match that convention or raw bytes
 * mojibake under Bun's Latin-1 module storage.
 */
export const detectUnicodeEscaping = (content: string): boolean =>
  /\\u[0-9a-fA-F]{4}/.test(content);

/**
 * The BUILD_TIME ISO timestamp baked into cli.js, used to resolve the
 * `<<BUILD_TIME>>` marker in prompt regexes.
 */
export const extractBuildTime = (content: string): string | undefined =>
  content.match(/\bBUILD_TIME:"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"/)?.[1];

const DELIMITERS = new Set(['"', "'", '`']);

/**
 * The JS string delimiter a match sits inside, inferred from the character
 * immediately before it. Never re-derive this by walking back to the "nearest
 * unescaped delimiter": markdown code-span backticks inside the string make
 * that heuristic land on the wrong quote.
 */
export const delimiterBefore = (content: string, index: number): string =>
  index > 0 ? content[index - 1] : '';

/**
 * Matches that look like a complete string-literal value: same delimiter
 * character immediately before and after the match.
 */
export const standaloneMatches = <T extends MatchLike>(
  content: string,
  matches: T[]
): T[] => standaloneMatchesAt(matches, index => content[index] ?? '');

export const standaloneMatchesAt = <T extends MatchLike>(
  matches: T[],
  charAt: (index: number) => string
): T[] =>
  matches.filter(m => {
    const index = m.index ?? -1;
    if (index < 0) return false;
    const before = charAt(index - 1);
    const after = charAt(index + m[0].length);
    return DELIMITERS.has(before) && before === after;
  });

/**
 * Choose which match a single catalogue entry splices.
 *
 * NOT an arbitrary pick when several remain. 124 prompt ids occupy MULTIPLE
 * binary sites (327 catalogue entries); each entry splices one site, and after
 * a splice the regex no longer matches it, so index 0 is the next UNPATCHED
 * site. Replacing this with "fail loudly on ambiguity" broke 124 prompts across
 * 302 sites. Cardinality is verified up-front by the preflight instead.
 */
export const pickMatchForSplice = <T extends MatchLike>(
  content: string,
  matches: T[]
): { match: T | null; disambiguated: boolean } =>
  pickMatchForSpliceAt(matches, index => content[index] ?? '');

export const pickMatchForSpliceAt = <T extends MatchLike>(
  matches: T[],
  charAt: (index: number) => string
): { match: T | null; disambiguated: boolean } => {
  if (matches.length === 0) return { match: null, disambiguated: false };
  if (matches.length === 1) return { match: matches[0], disambiguated: false };
  const standalone = standaloneMatchesAt(matches, charAt);
  if (standalone.length === 1) {
    return { match: standalone[0], disambiguated: true };
  }
  return { match: matches[0], disambiguated: false };
};

/**
 * The candidate sites one shape group resolves to, mirroring what the apply's
 * sequential consumption will actually consume. When the standalone filter
 * narrows the matches to exactly the number of catalogue entries, those are the
 * sites; otherwise every match is a candidate.
 */
export const resolveCandidateSites = <T extends MatchLike>(
  content: string,
  matches: T[],
  multiplicity: number
): T[] => {
  if (matches.length === multiplicity) return matches;
  const standalone = standaloneMatches(content, matches);
  if (standalone.length === multiplicity) return standalone;
  return matches;
};

export interface BacktickEscapeFinding {
  index: number;
  line: number;
  lineText: string;
  offending: string;
  required: string;
  /**
   * `lossy` — the escape changes what the model reads (`\\(` -> `(`, `\\s` -> `s`,
   * `\\n` -> a real newline, backslash-newline -> line continuation).
   * `redundant` — `\\"` and `\\'` still render as the quote the author wanted, so
   * the escape is merely superfluous.
   */
  kind: 'lossy' | 'redundant';
}

/**
 * Index just past the `}` closing a `${` interpolation that opens at `start`
 * (which must point at the `$`). String- and nesting-aware. Returns
 * `text.length` when the interpolation never closes.
 */
const skipInterpolation = (text: string, start: number): number => {
  let depth = 1;
  let i = start + 2;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return text.length;
};

/**
 * Delimiter-aware backtick lint for an override body destined for a BACKTICK
 * site. Only valid at backtick sites: quoted sites double every backslash on
 * the way in, so the same bytes are already correct there.
 *
 * At a backtick site the body is spliced into a template literal verbatim, so
 * an odd-parity backslash run is consumed by the JS parser: a lone `\s` cooks
 * to `s` and `[\s\S]` collapses to the literal class `[sS]`. The only odd-parity
 * runs that are correct are the two protecting source syntax — `` \` `` and
 * `\${`. Everything else must be written doubled (`\\n`, `\\s`, …) to reach the
 * model as a backslash.
 *
 * Interpolation expressions (`${...}`) are real JS, not prompt text, and are
 * skipped.
 */
export const lintBacktickEscapes = (body: string): BacktickEscapeFinding[] => {
  const findings: BacktickEscapeFinding[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\') {
      let run = 0;
      while (i + run < body.length && body[i + run] === '\\') run++;
      const next = body[i + run] ?? '';
      if (run % 2 === 1) {
        const escapesSyntax =
          next === '`' || (next === '$' && body[i + run + 1] === '{');
        if (!escapesSyntax) {
          const at = i + run - 1;
          const lineIndex = lineOf(at);
          const lineEnd = body.indexOf('\n', lineStarts[lineIndex]);
          const offending =
            '\\' + (next === '\n' ? '<newline>' : next === '' ? '' : next);
          findings.push({
            index: at,
            line: lineIndex + 1,
            lineText: body.slice(
              lineStarts[lineIndex],
              lineEnd === -1 ? body.length : lineEnd
            ),
            offending,
            required: '\\' + offending,
            kind: next === '"' || next === "'" ? 'redundant' : 'lossy',
          });
        }
      }
      // An odd run consumes the character after it — including the `$` of an
      // intentionally escaped `\${VAR}`, which is literal text and must not be
      // mistaken for an interpolation by the scan below.
      i += run % 2 === 1 ? run + 1 : run;
      continue;
    }
    if (c === '$' && body[i + 1] === '{') {
      i = skipInterpolation(body, i);
      continue;
    }
    i++;
  }
  return findings;
};

export interface Span {
  start: number;
  end: number;
}

export interface SpanClaim extends Span {
  /** Surface that claims the span: `prompt`, `inline-blob`, or `reminder`. */
  surface: 'prompt' | 'inline-blob' | 'reminder';
  /** Prompt id, override filename, or reminder id. */
  id: string;
  /** 0-based ordinal among the sites this id claims. */
  site: number;
  /** Whether the override would actually change these bytes. */
  mutates: boolean;
  /** The authored markdown body this surface would write. */
  body: string;
  delimiter?: string;
  replacement: string;
}

export interface SpanConflict {
  /** The claim that loses: an earlier surface already owns these bytes. */
  claim: SpanClaim;
  /** The claim that got there first. */
  owner: SpanClaim;
}

export const bodyCarriedBy = (body: string, ownerBody: string): boolean => {
  const lines = body
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  return lines.length === 0 || lines.every(line => ownerBody.includes(line));
};

export const spanConflicts = (
  claims: SpanClaim[],
  shadowedBy: (owner: string, victim: string) => boolean
): SpanConflict[] => {
  const accepted: SpanClaim[] = [];
  const conflicts: SpanConflict[] = [];
  for (const claim of claims) {
    const owner = accepted.find(
      a =>
        a.start < claim.end &&
        claim.start < a.end &&
        a.id !== claim.id &&
        !shadowedBy(a.id, claim.id) &&
        !shadowedBy(claim.id, a.id)
    );
    if (!owner) {
      accepted.push(claim);
      continue;
    }
    if (claim.mutates && !bodyCarriedBy(claim.body, owner.body)) {
      conflicts.push({ claim, owner });
    }
  }
  return conflicts;
};

export const literalProbeRuns = (
  replacement: string,
  minLength: number,
  hasRuntimeInterpolations = true
): string[] => {
  const runs: string[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number): void => {
    const run = replacement.slice(start, end).trim();
    if (run.length >= minLength) runs.push(run);
  };
  while (i < replacement.length) {
    if (replacement[i] === '\\') {
      i += 2;
      continue;
    }
    if (
      hasRuntimeInterpolations &&
      replacement[i] === '$' &&
      replacement[i + 1] === '{'
    ) {
      push(i);
      i = skipInterpolation(replacement, i);
      start = i;
      continue;
    }
    i++;
  }
  push(replacement.length);
  return runs.sort((a, b) => b.length - a.length);
};

export const literalProbeWindows = (
  replacement: string,
  minLength: number,
  maxLength: number,
  hasRuntimeInterpolations = true
): string[] => {
  const windows = new Set<string>();
  const width = Math.max(minLength, maxLength);
  const stride = width - minLength + 1;
  for (const run of literalProbeRuns(
    replacement,
    minLength,
    hasRuntimeInterpolations
  )) {
    windows.add(run);
    if (run.length <= width) {
      continue;
    }
    for (let start = 0; start + minLength <= run.length; start += stride) {
      const window = run.slice(start, start + width).trim();
      if (window.length >= minLength) windows.add(window);
    }
    const tail = run.slice(-width).trim();
    if (tail.length >= minLength) windows.add(tail);
  }
  return [...windows];
};

interface LiteralNode {
  next: Map<string, number>;
  fail: number;
  outputs: string[];
}

export const presentLiterals = (
  content: string,
  needles: Iterable<string>
): Set<string> => {
  const unique = [...new Set(needles)].filter(Boolean);
  if (unique.length === 0) return new Set();
  const nodes: LiteralNode[] = [{ next: new Map(), fail: 0, outputs: [] }];
  for (const needle of unique) {
    let state = 0;
    for (const char of needle) {
      const existing = nodes[state].next.get(char);
      if (existing !== undefined) {
        state = existing;
        continue;
      }
      const parent = state;
      state = nodes.length;
      nodes.push({ next: new Map(), fail: 0, outputs: [] });
      nodes[parent].next.set(char, state);
    }
    nodes[state].outputs.push(needle);
  }

  const queue: number[] = [];
  for (const child of nodes[0].next.values()) queue.push(child);
  for (let head = 0; head < queue.length; head++) {
    const state = queue[head];
    for (const [char, child] of nodes[state].next) {
      let failure = nodes[state].fail;
      while (failure !== 0 && !nodes[failure].next.has(char)) {
        failure = nodes[failure].fail;
      }
      nodes[child].fail = nodes[failure].next.get(char) ?? 0;
      nodes[child].outputs.push(...nodes[nodes[child].fail].outputs);
      queue.push(child);
    }
  }

  const found = new Set<string>();
  let state = 0;
  for (const char of content) {
    while (state !== 0 && !nodes[state].next.has(char)) {
      state = nodes[state].fail;
    }
    state = nodes[state].next.get(char) ?? 0;
    for (const needle of nodes[state].outputs) found.add(needle);
    if (found.size === unique.length) break;
  }
  return found;
};

const COMPARE_CHUNK = 1 << 16;

const commonPrefixLength = (a: string, b: string): number => {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (
    i + COMPARE_CHUNK <= max &&
    a.substr(i, COMPARE_CHUNK) === b.substr(i, COMPARE_CHUNK)
  ) {
    i += COMPARE_CHUNK;
  }
  while (i < max && a[i] === b[i]) i++;
  return i;
};

const commonSuffixLength = (a: string, b: string, limit: number): number => {
  let i = 0;
  while (
    i + COMPARE_CHUNK <= limit &&
    a.substr(a.length - i - COMPARE_CHUNK, COMPARE_CHUNK) ===
      b.substr(b.length - i - COMPARE_CHUNK, COMPARE_CHUNK)
  ) {
    i += COMPARE_CHUNK;
  }
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
};

/**
 * The `[start, end)` span of `before` that `after` replaced, derived from the
 * common prefix/suffix. Returns null when the strings are identical. Chunked so
 * a 20 MB cli.js costs a few hundred native comparisons rather than 20 million
 * char reads.
 */
export const changedSpan = (before: string, after: string): Span | null => {
  if (before === after) return null;
  const prefix = commonPrefixLength(before, after);
  const limit = Math.min(before.length, after.length) - prefix;
  const suffix = commonSuffixLength(before, after, Math.max(0, limit));
  return { start: prefix, end: before.length - suffix };
};

/**
 * Translates offsets in a progressively-spliced working copy back to the
 * pristine coordinates every check reports in.
 *
 * Surfaces must be measured in apply order (an inline-blob anchor is searched
 * in the content the previous blob left behind — that sequential consumption is
 * how two blobs sharing an anchor land on different sites), but their spans only
 * comparable once expressed against one fixed baseline.
 */
export class OffsetMapper {
  private edits: Array<{ start: number; oldLen: number; newLen: number }> = [];

  record(span: Span, newLen: number): void {
    this.edits.push({
      start: span.start,
      oldLen: span.end - span.start,
      newLen,
    });
  }

  toPristine(offset: number): number {
    let out = offset;
    for (let i = this.edits.length - 1; i >= 0; i--) {
      const edit = this.edits[i];
      if (out >= edit.start + edit.newLen) {
        out -= edit.newLen - edit.oldLen;
      } else if (out > edit.start) {
        out = edit.start;
      }
    }
    return out;
  }

  spanToPristine(span: Span): Span {
    return {
      start: this.toPristine(span.start),
      end: this.toPristine(span.end),
    };
  }

  toCurrent(offset: number, side: 'start' | 'end'): number {
    let out = offset;
    for (const edit of this.edits) {
      const end = edit.start + edit.oldLen;
      if (out >= end) {
        out += edit.newLen - edit.oldLen;
      } else if (out > edit.start) {
        out = side === 'start' ? edit.start : edit.start + edit.newLen;
      }
    }
    return out;
  }

  spanToCurrent(span: Span): Span {
    return {
      start: this.toCurrent(span.start, 'start'),
      end: this.toCurrent(span.end, 'end'),
    };
  }
}

/**
 * Raw (unescaped) non-ASCII codepoints `replacement` carries that the pristine
 * text it replaces does not. Raw non-ASCII at an injection surface mojibakes
 * under Bun's Latin-1 module storage; every surface is expected to emit
 * `\uXXXX` instead.
 */
export const introducedRawNonAscii = (
  pristine: string,
  replacement: string
): string[] => {
  const allowed = new Set<number>();
  for (const ch of pristine) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0x7f) allowed.add(cp);
  }
  const out = new Set<string>();
  for (const ch of replacement) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0x7f && !allowed.has(cp)) {
      out.add(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  return [...out].sort();
};
