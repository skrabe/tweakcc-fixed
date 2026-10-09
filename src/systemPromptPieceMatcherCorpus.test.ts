import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultWorkerCount,
  runMatcherDifferential,
  type DifferentialTargetSummary,
} from '../tools/lib/matcherDifferential.mjs';

// Reference-regex differential over the whole catalogue. It compiles one giant
// search regex per prompt (some >100KB) and, for the real bundle, runs it over
// a 45MB cli.js — ~25 minutes single-threaded on 2.1.295's 11,937 prompts — so
// it does not belong in the every-save `pnpm test` run. It is a version-bump
// guard, gated on TWEAKCC_MATCHER_CORPUS=1, which the showtime driver sets. The
// fast hand-picked equivalence cases in systemPromptPieceMatcher.test.ts still
// run every time.
//
// Both cases go through tools/lib/matcherDifferential.mjs, the runner behind
// tools/runMatcherDifferential.mjs: the per-prompt check is
// src/matcherDifferential.ts, sharded across worker threads and cached by
// content, so the gate and the CLI are one implementation.
// TWEAKCC_MATCHER_WORKERS overrides the worker count, TWEAKCC_MATCHER_NO_CACHE=1
// bypasses the cache, TWEAKCC_MATCHER_CACHE moves it.
const CORPUS = Boolean(process.env.TWEAKCC_MATCHER_CORPUS);
const MINUTES = 5 * 60 * 1000;
// A per-test timeout passed to `it` overrides --testTimeout, so it has to be
// generous here: a run that times out reports as a FAILED equivalence, i.e. a
// gate that says "the apply would splice a wrong site" when the truth is that
// it never finished. A run that legitimately needs 20 minutes is a signal worth
// seeing, not a failure.
const REAL_BUNDLE_TIMEOUT = 20 * MINUTES;

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

const runnerOptions = () => ({
  workers: Number(process.env.TWEAKCC_MATCHER_WORKERS) || defaultWorkerCount(),
  cache: !process.env.TWEAKCC_MATCHER_NO_CACHE,
});

const expectAgreement = (s: DifferentialTargetSummary) => {
  // If this drops, prompts stopped reaching the comparison (the regex builder
  // or the RegExp engine rejects them) and the gate is silently vacuous.
  expect(s.checked).toBeGreaterThan(2000);
  expect(
    s.errors.map(e => e.id),
    s.errors.map(e => `${e.id}: ${e.message}`).join('\n\n')
  ).toEqual([]);
  expect(
    s.mismatches.map(m => m.id),
    s.mismatches
      .slice(0, 10)
      .map(m => m.detail)
      .join('\n\n')
  ).toEqual([]);
};

describe.runIf(CORPUS)(
  'systemPromptPieceMatcher — full real-corpus equivalence',
  () => {
    it(
      'matches the RegExp engine on every bundled prompt shape',
      async () => {
        const { file } = newestPromptsJson();
        const {
          targets: [s],
        } = await runMatcherDifferential({
          promptsFile: file,
          synthetic: true,
          ...runnerOptions(),
        });
        expectAgreement(s);
        // If this drops, the synthetic haystack stopped exercising real matches
        // (e.g. the regex format changed) and the test is silently vacuous.
        expect(s.exercised / s.checked).toBeGreaterThan(0.9);
      },
      MINUTES
    );

    // The strongest check: the matcher and the regex must agree on the REAL
    // bundle, not just synthetic haystacks. Gated on the pristine cli.js the
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
        const { file } = newestPromptsJson();
        // The runner streams progress, so a long run is observably alive and a
        // genuine hang shows where it stopped (vitest itself prints nothing
        // until a test settles; on CC 2.1.273 that silence cost four relaunches).
        const {
          targets: [s],
        } = await runMatcherDifferential({
          promptsFile: file,
          bundles: [orig],
          ...runnerOptions(),
        });
        expectAgreement(s);
      },
      REAL_BUNDLE_TIMEOUT
    );
  }
);
