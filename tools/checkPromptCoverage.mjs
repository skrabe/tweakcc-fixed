#!/usr/bin/env node
// Prompt-coverage gate: does OUR catalogue carry every model-facing string a
// reference catalogue found?
//
// Why this exists. The showtime no-regression bar compares NAMED COUNTS — ours
// (3771) vs upstream's (644) — which passes unconditionally and so can never
// see a miss. It is also blind by construction to the real failure mode: Claude
// Code ships MORE THAN ONE description for the same tool on different code
// paths, and two extractors each find a different one. `refreshmcptools` is the
// worked example — we catalogue "Re-query the tool lists…" and upstream
// catalogues "Re-queries the tool list…", same tool, same version, both live in
// the binary, and the id-level diff shows nothing wrong.
//
// So compare by CONTENT, and let the BINARY arbitrate:
//   in reference, in our binary, not in our catalogue  -> MISSING   (exit 1)
//   in reference, not in our binary                    -> not ours  (info)
//
// Two traps this had to be built around, both of which produced confidently
// wrong numbers on the way here:
//
//   1. The bundle stores non-ASCII as `\uXXXX`. Reference bodies are decoded
//      text. Probing the bundle with a run containing an em-dash — which most
//      of these bodies have — fails for every one of them. Probes are therefore
//      split on non-ASCII and only pure-ASCII runs are used.
//   2. Interpolations. A body's literal text is only the pieces between
//      `${...}` slots, so probes are split there too.
//
// A reference id we deliberately do not catalogue (traced to an emission site
// the model never reads) is recorded in data/prompt-coverage-allowlist.json.
// A row goes stale, and fails the gate, once its id is no longer missing, no
// longer in the binary, no longer probeable, or gone from the reference, so
// rows cannot outlive the reason they were written for.
//
// Usage:
//   node tools/checkPromptCoverage.mjs <ours.json> <reference.json> <pristine cli.js>
//     [--allowlist <file>]
// Exit 0 = no gap.

import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './lib/isMain.mjs';

const DEFAULT_ALLOWLIST = path.join(
  import.meta.dirname,
  '..',
  'data',
  'prompt-coverage-allowlist.json'
);

const MIN_PROBE = 40;

/**
 * Collapse both escape conventions onto one key so catalogues written in either
 * can be compared.
 *
 * A reference catalogue may store pieces in RAW JavaScript source form — `\"`,
 * `\\`, the bytes as they sit in cli.js — while ours stores them COOKED at
 * quoted sites: `"`, `\`, the text the model actually reads. That difference is
 * by design and it is not a one-way decode, because a decode that is right for
 * the raw side destroys a genuine backslash on the cooked side (`use
 * Anthropic\Bedrock\MantleClient` is real prompt text, not an escape).
 *
 * Dropping every backslash is symmetric and settles it: raw `\\B` and cooked
 * `\B` both key to `B`, raw `\"` and cooked `"` both key to `"`. Slightly
 * lossy — two texts differing ONLY in backslashes would key alike — which is
 * the right trade for a presence check whose question is "do we carry this text
 * at all". CORPUS side only: probing the BINARY keeps the raw form, since raw
 * is what the binary contains.
 */
export const corpusKey = text => text.replace(/\\/g, '');

export const literalRuns = (pieces, minLength = MIN_PROBE) =>
  (pieces ?? [])
    .map(String)
    .flatMap(s => s.split(/\$\{[^}]*\}/))
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length >= minLength)
    .sort((a, b) => b.length - a.length);

/** Pure-ASCII sub-runs, the only form that can be found in a `\uXXXX` bundle. */
export const asciiRuns = (text, minLength = MIN_PROBE) => {
  const out = [];
  let cur = '';
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) cur += ch;
    else {
      out.push(cur);
      cur = '';
    }
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(s => s.length >= minLength);
};

export const coverageReport = (ours, reference, bundle) => {
  const haystack = corpusKey(
    ours
      .flatMap(p => (p.pieces ?? []).map(String))
      .join(' ')
      .replace(/\s+/g, ' ')
  );
  const ourIds = new Set(ours.map(p => p.id).filter(Boolean));
  const missing = [];
  const spanDiff = [];
  const notOurs = [];
  const unprobeable = [];

  for (const p of reference) {
    const runs = literalRuns(p.pieces);
    if (runs.length === 0) {
      unprobeable.push(p.id);
      continue;
    }
    // Corpus side: both catalogues normalised to the cooked form.
    if (runs.some(r => haystack.includes(corpusKey(r)))) continue;

    // Binary side: raw form, because that is what cli.js stores.
    const probes = runs.flatMap(r => asciiRuns(r));
    const tokens = Math.ceil((p.pieces ?? []).join('').length / 4);
    if (probes.length === 0) {
      unprobeable.push(p.id);
      continue;
    }
    if (!probes.some(probe => bundle.includes(probe))) {
      notOurs.push({ id: p.id, tokens });
      continue;
    }
    // Carrying the id already means the prompt IS catalogued and the two
    // extractors merely delimited it differently — upstream swept in a
    // neighbouring section, or split one the other kept whole. Worth reporting,
    // but it is not a coverage hole and must not fail the gate, or the gate
    // cries wolf forever on a difference of opinion about span.
    (ourIds.has(p.id) ? spanDiff : missing).push({ id: p.id, tokens });
  }
  const byTokens = (a, b) => b.tokens - a.tokens;
  missing.sort(byTokens);
  spanDiff.sort(byTokens);
  return { missing, spanDiff, notOurs, unprobeable };
};

export const applyAllowlist = (report, allowlist, reference) => {
  const referenceIds = new Set(reference.map(p => p.id).filter(Boolean));
  const state = new Map();
  for (const m of report.missing) state.set(m.id, 'missing');
  for (const m of report.notOurs) state.set(m.id, 'not in the binary');
  for (const id of report.unprobeable) state.set(id, 'unprobeable');
  const missing = report.missing.filter(m => !allowlist[m.id]);
  const allowlisted = report.missing.filter(m => allowlist[m.id]);
  const stale = [];
  for (const id of Object.keys(allowlist)) {
    if (!referenceIds.has(id)) stale.push({ id, why: 'not in the reference' });
    else if (state.get(id) !== 'missing') {
      stale.push({ id, why: state.get(id) || 'catalogued by us' });
    }
  }
  return { ...report, missing, allowlisted, stale };
};

const main = () => {
  const argv = process.argv.slice(2);
  const alIdx = argv.indexOf('--allowlist');
  const allowlistPath = alIdx >= 0 ? argv[alIdx + 1] : DEFAULT_ALLOWLIST;
  const [oursPath, referencePath, bundlePath] = argv.filter(
    (_, i) => alIdx < 0 || (i !== alIdx && i !== alIdx + 1)
  );
  if (!oursPath || !referencePath || !bundlePath) {
    console.error(
      'usage: checkPromptCoverage.mjs <ours.json> <reference.json> <pristine cli.js>'
    );
    process.exit(2);
  }
  const load = f => JSON.parse(fs.readFileSync(f, 'utf8')).prompts;
  const reference = load(referencePath);
  const allowlist = fs.existsSync(allowlistPath)
    ? JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))
    : {};
  const { missing, spanDiff, notOurs, unprobeable, allowlisted, stale } =
    applyAllowlist(
      coverageReport(
        load(oursPath),
        reference,
        fs.readFileSync(bundlePath, 'utf8')
      ),
      allowlist,
      reference
    );
  for (const s of stale) {
    console.log(`  STALE allowlist row ${s.id}: ${s.why}`);
  }

  const total = missing.reduce((s, m) => s + m.tokens, 0);
  const trailer =
    `${spanDiff.length} span-difference, ${notOurs.length} reference-only, ` +
    `${unprobeable.length} unprobeable, ${allowlisted.length} allowlisted`;
  if (missing.length === 0 && stale.length === 0) {
    console.log(
      `✓ prompt coverage: every reference prompt present (${trailer})`
    );
    if (spanDiff.length > 0) {
      console.log('  span differences (same id, different extent):');
      for (const m of spanDiff) {
        console.log(`    ${String(m.tokens).padStart(6)} tk  ${m.id}`);
      }
    }
    process.exit(0);
  }

  if (stale.length > 0) {
    console.log(
      `${stale.length} stale allowlist row(s) in ${allowlistPath}; remove them`
    );
  }
  console.log(
    `MISSING FROM OUR CATALOGUE: ${missing.length} entries (~${total} tokens) ` +
      `present in the binary but absent from our prompts JSON`
  );
  for (const m of missing) {
    console.log(`  ${String(m.tokens).padStart(6)} tk  ${m.id}`);
  }
  console.log(`\n(${trailer}.)`);
  process.exit(1);
};

if (isMain(import.meta.url)) main();
