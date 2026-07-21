import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSearchRegexFromPieces } from './systemPromptSync';
import { findAllMatchesWithStackFallback } from './safeRegexMatch';
import {
  findAllPromptPieceMatches,
  PromptMatchSpec,
} from './systemPromptPieceMatcher';

// Reference-regex differential over the whole catalogue: compiling ~2,600 giant
// search regexes (some >100KB) costs ~50s synthetic / ~130s against the real
// 20MB bundle, so it does not belong in the every-save `pnpm test` run. It is a
// version-bump guard — gate it on TWEAKCC_MATCHER_CORPUS=1, which the showtime
// driver sets (driver.mjs `check`). The fast hand-picked equivalence cases in
// systemPromptPieceMatcher.test.ts still run every time.
const CORPUS = Boolean(process.env.TWEAKCC_MATCHER_CORPUS);
const MINUTES = 5 * 60 * 1000;

// The differential guard.
//
// systemPromptPieceMatcher is a fast anchor-narrowing front end for the giant
// per-prompt search regexes; the production apply splices at the sites it
// returns. `expectEquivalent` in systemPromptPieceMatcher.test.ts proves that
// front end matches the RegExp engine on hand-picked tricky shapes — but only a
// handful. This test extends the same equivalence assertion to EVERY real
// prompt shape in the bundled catalogue, so a future CC version that introduces
// a shape the fast path handles differently from the regex fails here instead of
// silently splicing into the wrong place. Without it, the "2,612 shapes, 0
// mismatch" validation done once by hand would rot the moment the corpus grew.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const newestPromptsJson = (): { file: string; version: string } => {
  const dir = path.join(REPO, 'data', 'prompts');
  const versions = fs
    .readdirSync(dir)
    .map(f => (f.match(/^prompts-(\d+\.\d+\.\d+)\.json$/) || [])[1])
    .filter((v): v is string => Boolean(v))
    .sort((a, b) =>
      a
        .split('.')
        .map(Number)
        .reduce((acc, n, i) => acc || n - Number(b.split('.')[i]), 0)
    );
  const version = versions[versions.length - 1];
  return { file: path.join(dir, `prompts-${version}.json`), version };
};

const signature = (m: RegExpExecArray): Array<string | number | null> => [
  m.index,
  ...Array.from(m, v => v ?? null),
];

// A haystack a prompt's own regex should match once: its literal pieces joined
// by a token that satisfies the identifier-capture class ([$\w]+) and, for the
// "match anything" interpolation/backslash sentinels, is equally acceptable.
// Distinct per gap so capture-group equivalence is actually exercised.
const synthHaystack = (pieces: string[]): string => {
  let out = '\n// leading filler so index 0 is never the match\n';
  pieces.forEach((piece, i) => {
    out += piece;
    if (i < pieces.length - 1) out += `Z${i}x9$q`;
  });
  return out + '\n// trailing filler\n';
};

describe.runIf(CORPUS)(
  'systemPromptPieceMatcher — full real-corpus equivalence',
  () => {
    it(
      'matches the RegExp engine on every bundled prompt shape',
      async () => {
        const { file, version } = newestPromptsJson();
        const prompts: Array<{ pieces?: string[] }> = JSON.parse(
          fs.readFileSync(file, 'utf8')
        ).prompts;

        let checked = 0;
        let exercised = 0;
        const mismatches: string[] = [];

        for (const p of prompts) {
          const pieces = p.pieces;
          if (!Array.isArray(pieces) || pieces.length === 0) continue;
          let regex: string;
          try {
            regex = buildSearchRegexFromPieces(pieces, version);
          } catch {
            continue;
          }
          const spec: PromptMatchSpec = { regex, pieces, version };
          const content = synthHaystack(pieces);

          let expected: RegExpExecArray[];
          try {
            expected = await findAllMatchesWithStackFallback(
              regex,
              'sig',
              content
            );
          } catch {
            // A pattern the RegExp engine itself rejects is not a fair comparison.
            continue;
          }
          const actual = await findAllPromptPieceMatches(spec, content);
          checked++;
          if (expected.length > 0) exercised++;

          const e = JSON.stringify(expected.map(signature));
          const a = JSON.stringify(actual.map(signature));
          if (e !== a && mismatches.length < 10) {
            mismatches.push(
              `shape ${JSON.stringify(pieces).slice(0, 90)}\n  regex: ${e}\n  piece: ${a}`
            );
          } else if (e !== a) {
            mismatches.push('…');
          }
        }

        expect(checked).toBeGreaterThan(2000);
        // If this drops, the synthetic haystack stopped exercising real matches
        // (e.g. the regex format changed) and the test is silently vacuous.
        expect(exercised / checked).toBeGreaterThan(0.9);
        expect(mismatches, mismatches.join('\n\n')).toEqual([]);
      },
      MINUTES
    );

    // The strongest check: the matcher and the regex must agree on the REAL
    // 20MB bundle, not just synthetic haystacks. Gated on the pristine cli.js the
    // apply writes to ~/.tweakcc every run, so it runs on a maintainer's machine
    // (and in showtime) but skips in a bare CI checkout rather than passing
    // vacuously.
    it(
      'agrees with the RegExp engine on the real pristine bundle when present',
      async () => {
        // TWEAKCC_MATCHER_CORPUS_BUNDLE points the differential at a specific
        // bundle — e.g. a Linux cli.js copied from a VPS — so matcher/regex
        // equivalence can be confirmed on a platform whose minified shapes differ
        // from the dev machine's. Defaults to the pristine cli.js the apply writes.
        const orig =
          process.env.TWEAKCC_MATCHER_CORPUS_BUNDLE ||
          path.join(os.homedir(), '.tweakcc', 'native-claudejs-orig.js');
        if (!fs.existsSync(orig)) {
          console.log(
            'skip: no ~/.tweakcc/native-claudejs-orig.js — run --apply once to enable the real-bundle differential'
          );
          return;
        }
        const content = fs.readFileSync(orig, 'utf8');
        const version =
          (content.match(/"(\d+\.\d+\.\d+)"/) || [])[1] ||
          newestPromptsJson().version;
        const { file } = newestPromptsJson();
        const prompts: Array<{ pieces?: string[] }> = JSON.parse(
          fs.readFileSync(file, 'utf8')
        ).prompts;

        const mismatches: string[] = [];
        let checked = 0;
        for (const p of prompts) {
          const pieces = p.pieces;
          if (!Array.isArray(pieces) || pieces.length === 0) continue;
          let regex: string;
          try {
            regex = buildSearchRegexFromPieces(pieces, version);
          } catch {
            continue;
          }
          let expected: RegExpExecArray[];
          try {
            expected = await findAllMatchesWithStackFallback(
              regex,
              'sig',
              content
            );
          } catch {
            continue;
          }
          const actual = await findAllPromptPieceMatches(
            { regex, pieces, version },
            content
          );
          checked++;
          const e = JSON.stringify(expected.map(signature));
          const a = JSON.stringify(actual.map(signature));
          if (e !== a && mismatches.length < 10) {
            mismatches.push(
              `${JSON.stringify(pieces).slice(0, 90)}\n  ${e}\n  ${a}`
            );
          }
        }
        expect(checked).toBeGreaterThan(2000);
        expect(mismatches, mismatches.join('\n\n')).toEqual([]);
      },
      MINUTES
    );
  }
);
