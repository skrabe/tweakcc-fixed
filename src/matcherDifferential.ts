import { buildSearchRegexFromPieces } from './systemPromptSync';
import { findAllMatchesWithStackFallback } from './safeRegexMatch';
import {
  findPromptPieceMatchesAtOccurrences,
  MAX_ANCHOR_OCCURRENCES,
  PromptPieceMatcherCatalog,
  promptAnchorInfo,
  type PromptMatchSpec,
} from './systemPromptPieceMatcher';

// One prompt of the matcher/regex differential: the fast piece matcher the
// apply splices with must return exactly what the reference RegExp returns.
// Shared by src/systemPromptPieceMatcherCorpus.test.ts and
// tools/runMatcherDifferential.mjs (which runs it sharded across worker
// threads), so the gate and the CLI cannot drift apart.

export type MatchSignature = Array<string | number | null>;

export const TOKEN_KINDS = [
  'backslash',
  'capture',
  'identifier',
  'interpolation',
  'literal',
  'newline',
  'non-ascii',
  'quote',
] as const;

export type DifferentialAnswer = 'token' | 'token-past-cap' | 'no-anchor';

export type PromptDifferential =
  // buildSearchRegexFromPieces rejected the pieces: nothing to compare.
  | { status: 'skip-build' }
  // The RegExp engine rejected the pattern: not a fair comparison.
  | { status: 'skip-regex' }
  | {
      status: 'match';
      exercised: boolean;
      answer: DifferentialAnswer;
      kinds: string[];
    }
  | {
      status: 'mismatch';
      expected: string;
      actual: string;
      answer: DifferentialAnswer;
    };

export const matchSignature = (m: RegExpExecArray): MatchSignature => [
  m.index,
  ...Array.from(m, v => v ?? null),
];

// The version the differential builds regexes for: the first quoted X.Y.Z in
// the bundle, which is the CC version string.
export const bundleCcVersion = (content: string, fallback: string): string =>
  (content.match(/"(\d+\.\d+\.\d+)"/) || [])[1] || fallback;

// A haystack a prompt's own regex should match once: its literal pieces joined
// by a token that satisfies the identifier-capture class ([$\w]+) and, for the
// "match anything" interpolation/backslash sentinels, is equally acceptable.
// Distinct per gap so capture-group equivalence is actually exercised.
export const synthHaystack = (pieces: string[]): string => {
  let out = '\n// leading filler so index 0 is never the match\n';
  pieces.forEach((piece, i) => {
    out += piece;
    if (i < pieces.length - 1) out += `Z${i}x9$q`;
  });
  return out + '\n// trailing filler\n';
};

const exactOccurrences = (content: string, anchor: string): number[] => {
  const found: number[] = [];
  for (
    let at = content.indexOf(anchor);
    at !== -1;
    at = content.indexOf(anchor, at + 1)
  ) {
    found.push(at);
  }
  return found;
};

const specFor = (pieces: string[], version: string): PromptMatchSpec | null => {
  try {
    return {
      regex: buildSearchRegexFromPieces(pieces, version),
      pieces,
      version,
    };
  } catch {
    return null;
  }
};

// The anchor occurrences the apply's own index finds in `content`, per prompt:
// exact-case positions, null past the occurrence cap, undefined for a prompt
// with no anchor or no regex. One catalogue over the whole list, indexed once,
// exactly as applySystemPrompts and the preflight batch index the bundle.
export const indexBundleOccurrences = (
  piecesList: string[][],
  version: string,
  content: string
): Array<number[] | null | undefined> => {
  const specs = piecesList.map(pieces => specFor(pieces, version));
  const catalog = new PromptPieceMatcherCatalog(
    specs.filter((spec): spec is PromptMatchSpec => spec !== null)
  );
  catalog.index(content);
  return specs.map(spec =>
    spec === null ? undefined : catalog.indexedOccurrences(spec.regex)
  );
};

// `content` null = the prompt's own synthetic haystack. `indexed` is the
// prompt's entry from indexBundleOccurrences; omitted, the occurrences are
// found here. The token matcher is compared with the regex on every prompt
// that has an anchor: below the cap on the occurrences the apply answers from,
// past it on every exact occurrence, where the apply itself asks the regex.
export const checkPromptDifferential = async (
  pieces: string[],
  version: string,
  content: string | null,
  indexed?: number[] | null
): Promise<PromptDifferential> => {
  const spec = specFor(pieces, version);
  if (!spec) return { status: 'skip-build' };
  const haystack = content ?? synthHaystack(pieces);
  let expected: RegExpExecArray[];
  try {
    expected = await findAllMatchesWithStackFallback(
      spec.regex,
      'sg',
      haystack
    );
  } catch {
    return { status: 'skip-regex' };
  }
  const { anchor, tokenKinds } = promptAnchorInfo(spec);
  if (anchor === null) {
    return {
      status: 'match',
      exercised: expected.length > 0,
      answer: 'no-anchor',
      kinds: [],
    };
  }
  const known =
    indexed === undefined ? exactOccurrences(haystack, anchor) : indexed;
  const answer: DifferentialAnswer =
    known !== null && known.length <= MAX_ANCHOR_OCCURRENCES
      ? 'token'
      : 'token-past-cap';
  const actual =
    findPromptPieceMatchesAtOccurrences(
      spec,
      haystack,
      known ?? exactOccurrences(haystack, anchor)
    ) ?? [];
  const e = JSON.stringify(expected.map(matchSignature));
  const a = JSON.stringify(actual.map(matchSignature));
  if (e !== a) return { status: 'mismatch', expected: e, actual: a, answer };
  return {
    status: 'match',
    exercised: expected.length > 0,
    answer,
    kinds: tokenKinds,
  };
};

// The text the corpus test has always printed for one mismatching prompt.
export const formatMismatch = (
  pieces: string[],
  expected: string,
  actual: string,
  synthetic: boolean
): string =>
  synthetic
    ? `shape ${JSON.stringify(pieces).slice(0, 90)}\n  regex: ${expected}\n  piece: ${actual}`
    : `${JSON.stringify(pieces).slice(0, 90)}\n  ${expected}\n  ${actual}`;
