import { buildSearchRegexFromPieces } from './systemPromptSync';
import { findAllMatchesWithStackFallback } from './safeRegexMatch';
import { findAllPromptPieceMatches } from './systemPromptPieceMatcher';

// One prompt of the matcher/regex differential: the fast piece matcher the
// apply splices with must return exactly what the reference RegExp returns.
// Shared by src/systemPromptPieceMatcherCorpus.test.ts and
// tools/runMatcherDifferential.mjs (which runs it sharded across worker
// threads), so the gate and the CLI cannot drift apart.

export type MatchSignature = Array<string | number | null>;

export type PromptDifferential =
  // buildSearchRegexFromPieces rejected the pieces: nothing to compare.
  | { status: 'skip-build' }
  // The RegExp engine rejected the pattern: not a fair comparison.
  | { status: 'skip-regex' }
  | { status: 'match'; exercised: boolean }
  | { status: 'mismatch'; expected: string; actual: string };

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

// `content` null = the prompt's own synthetic haystack.
export const checkPromptDifferential = async (
  pieces: string[],
  version: string,
  content: string | null
): Promise<PromptDifferential> => {
  let regex: string;
  try {
    regex = buildSearchRegexFromPieces(pieces, version);
  } catch {
    return { status: 'skip-build' };
  }
  const haystack = content ?? synthHaystack(pieces);
  let expected: RegExpExecArray[];
  try {
    expected = await findAllMatchesWithStackFallback(regex, 'sg', haystack);
  } catch {
    return { status: 'skip-regex' };
  }
  const actual = await findAllPromptPieceMatches(
    { regex, pieces, version },
    haystack
  );
  const e = JSON.stringify(expected.map(matchSignature));
  const a = JSON.stringify(actual.map(matchSignature));
  if (e !== a) return { status: 'mismatch', expected: e, actual: a };
  return { status: 'match', exercised: expected.length > 0 };
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
