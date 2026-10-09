#!/usr/bin/env node
// Prints the exact classification-cache key(s) the extractor computes for a
// literal in a bundle, and the verdict data/prompt-classification.json holds
// for it.
//
//   node tools/probeCacheKey.mjs <cli.js> (--offset N | --text "…" | --hash <sha1>)
//     [--json] [--cache data/prompt-classification.json] [--version X.Y.Z]
//     [--limit 50]
//
// A verdict keyed from a hand-derived body binds to nothing, silently: the key
// is sha1-40 of the body the extractor hashes (a template keeps the member
// access of each `${…}` and drops only the identifier), looked up under every
// <<CCVERSION>> / <<BUILD_TIME>> form and its bracket-index-normalized twin.
// Everything here comes from the extractor itself — its AST pass
// (collectLiteralSites) for the bodies, cacheLookupForms for the variants in
// lookup order, sha1Hex for the key — so this tool cannot drift from it.
//
// One line per literal:
//   <start>-<end> <kind> <verdict> <variant>=<sha1>[*] … "<first 80 chars>"
// kind is string | template | composite (the joined text of a `[…].join()`,
// array or `+` chain) | fragment (one element of a composite, `of=<s>-<e>`).
// verdict is `facing/id`, `facing`, or `uncached`; `*` marks the key it binds
// under (the first hit in classifyByCache's order; a promoted template's
// pre-promotion body comes last, as `legacy…`).
// Exit 0 with a match, 1 with none, 2 on usage error.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ex = require('./promptExtractor.js');

export const DEFAULT_CACHE = path.join(HERE, '..', 'data', 'prompt-classification.json');

const USAGE =
  'usage: node tools/probeCacheKey.mjs <cli.js> (--offset N | --text "…" | --hash <sha1>) ' +
  '[--json] [--cache data/prompt-classification.json] [--version X.Y.Z] [--limit N]';

export function parseArgs(argv) {
  const opt = { positional: [] };
  const valued = new Set(['offset', 'text', 'hash', 'cache', 'version', 'limit']);
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z]+)(?:=([\s\S]*))?$/);
    if (!m) {
      opt.positional.push(argv[i]);
      continue;
    }
    if (m[1] === 'json') opt.json = true;
    else if (valued.has(m[1])) {
      const v = m[2] !== undefined ? m[2] : argv[++i];
      if (v === undefined) throw new Error(`--${m[1]} needs a value`);
      opt[m[1]] = v;
    } else throw new Error(`unknown option --${m[1]}`);
  }
  if (opt.positional.length !== 1) throw new Error('exactly one <cli.js> is required');
  const modes = ['offset', 'text', 'hash'].filter(k => opt[k] !== undefined);
  if (modes.length !== 1) throw new Error('pass exactly one of --offset, --text, --hash');
  if (opt.offset !== undefined && !/^\d+$/.test(opt.offset)) throw new Error('--offset must be a non-negative integer');
  if (opt.hash !== undefined && !/^[0-9a-f]{40}$/.test(opt.hash)) throw new Error('--hash must be 40 lowercase hex');
  if (opt.text === '') throw new Error('--text must not be empty');
  if (opt.limit !== undefined && !/^\d+$/.test(opt.limit)) throw new Error('--limit must be an integer');
  return opt;
}

// The CC version the extractor's <<CCVERSION>> forms need. Same sources as the
// extractor CLI (TWEAKCC_CC_VERSION, a sibling package.json), then the
// /tmp/cli-X.Y.Z.js naming, then the bundle's own VERSION:"…" stamp.
export function detectVersion(cliPath, code) {
  if (process.env.TWEAKCC_CC_VERSION) return process.env.TWEAKCC_CC_VERSION;
  const pkg = path.join(path.dirname(cliPath), 'package.json');
  try {
    const v = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
    if (/^\d+\.\d+\.\d+/.test(v || '')) return v;
  } catch {
    // no sibling package.json
  }
  const named = path.basename(cliPath).match(/(\d+\.\d+\.\d+)/);
  if (named) return named[1];
  const stamped = code && code.match(/VERSION:"(\d+\.\d+\.\d+)"/);
  return stamped ? stamped[1] : null;
}

// The extractor narrates its pass; only the records matter here.
function quietly(fn) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

// One entry per (range, body the extractor hashes there). A composite also
// yields one fragment entry per element, under the body classifyByCache looks
// the fragment up by; the plain string record at the same range and body is
// folded into it.
export function buildEntries(records) {
  const entries = new Map();
  const put = e => {
    const k = `${e.start}:${e.end}:${e.cacheBody}`;
    const prev = entries.get(k);
    if (!prev || (prev.kind === 'string' && e.kind === 'fragment')) entries.set(k, e);
  };
  for (const r of records) {
    if (!r || typeof r.cacheBody !== 'string') continue;
    if (r.kind === 'composite') {
      put({ start: r.start, end: r.end, kind: 'composite', cacheBody: r.cacheBody });
      for (const f of r.fragments || []) {
        if (typeof f.body !== 'string') continue;
        put({ start: f.start, end: f.end, kind: 'fragment', cacheBody: f.body, of: [r.start, r.end] });
      }
    } else
      put({
        start: r.start,
        end: r.end,
        kind: r.kind,
        cacheBody: r.cacheBody,
        ...(typeof r.legacyCacheBody === 'string' && { legacyCacheBody: r.legacyCacheBody }),
      });
  }
  return [...entries.values()];
}

const PH = ['<<CCVERSION>>', '<<BUILD_TIME>>'];
const PH_NAME = { '<<CCVERSION>>': 'ccversion', '<<BUILD_TIME>>': 'build-time' };
function rawLabel(body, form) {
  const tags = [];
  for (const ph of PH) {
    if (form.includes(ph) && !body.includes(ph)) tags.push(PH_NAME[ph]);
    else if (!form.includes(ph) && body.includes(ph)) tags.push(`${PH_NAME[ph]}-expanded`);
  }
  return tags.length ? tags.join('+') : 'raw';
}

// Every key classifyByCache tries for `body`, in its lookup order, labelled.
export function keyVariants(body) {
  const raw = ex.rawCacheForms(body);
  const out = [];
  const seen = new Set();
  for (const form of ex.cacheLookupForms(body)) {
    const key = ex.sha1Hex(form);
    if (seen.has(key)) continue;
    seen.add(key);
    let variant;
    const ri = raw.indexOf(form);
    if (ri >= 0) variant = rawLabel(body, form);
    else {
      const src = raw.find(r => ex.normalizeBracketIndexes(r) === form);
      const base = src === undefined ? 'raw' : rawLabel(body, src);
      variant = base === 'raw' ? 'bracket-index' : `${base}+bracket-index`;
    }
    out.push({ variant, key, form });
  }
  return out;
}

// Every key a site binds under, in classifyByCache's order: the current body's
// variants, then those of its pre-promotion `legacyCacheBody` (labelled
// `legacy`), so a verdict recorded before a slot was promoted still binds.
export function entryKeys(entry) {
  const keys = keyVariants(entry.cacheBody);
  if (typeof entry.legacyCacheBody !== 'string') return keys;
  const seen = new Set(keys.map(k => k.key));
  for (const k of keyVariants(entry.legacyCacheBody)) {
    if (seen.has(k.key)) continue;
    seen.add(k.key);
    keys.push({ ...k, variant: k.variant === 'raw' ? 'legacy' : `legacy+${k.variant}` });
  }
  return keys;
}

// Template pieces keep raw escapes (`\n`, `\``); let --text match either form.
const cook = s =>
  s.replace(/\\([nrt`$\\'"])/g, (_m, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);

export function selectEntries(entries, { offset, text, hash }) {
  if (offset !== undefined) {
    const n = Number(offset);
    return entries
      .filter(e => e.start <= n && n < e.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start) || a.start - b.start);
  }
  if (text !== undefined) {
    return entries.filter(
      e =>
        e.cacheBody.includes(text) ||
        cook(e.cacheBody).includes(text) ||
        (text.includes('<<') && keyVariants(e.cacheBody).some(v => v.form.includes(text)))
    );
  }
  return entries.filter(e => entryKeys(e).some(v => v.key === hash));
}

export function describe(entry, cache) {
  const keys = entryKeys(entry);
  let verdict = null;
  const out = keys.map(({ variant, key }) => {
    const hit = cache[key] || null;
    const binds = Boolean(hit) && !verdict;
    if (binds) verdict = hit;
    return { variant, key, ...(hit && { verdict: hit }), ...(binds && { binds: true }) };
  });
  return {
    start: entry.start,
    end: entry.end,
    kind: entry.kind,
    ...(entry.of && { of: entry.of }),
    verdict: verdict ? { facing: verdict.facing, ...(verdict.id && { id: verdict.id }) } : null,
    keys: out,
    cacheBody: entry.cacheBody,
  };
}

export function formatLine(d) {
  const v = d.verdict ? (d.verdict.id ? `${d.verdict.facing}/${d.verdict.id}` : d.verdict.facing) : 'uncached';
  const kind = d.of ? `fragment(of=${d.of[0]}-${d.of[1]})` : d.kind;
  const keys = d.keys.map(k => `${k.variant}=${k.key}${k.binds ? '*' : ''}`).join(' ');
  const head = d.cacheBody.length > 80 ? d.cacheBody.slice(0, 80) + '…' : d.cacheBody;
  return `${d.start}-${d.end} ${kind} ${v} ${keys} ${JSON.stringify(head)}`;
}

export function probe(cliPath, query, { cachePath = DEFAULT_CACHE, version } = {}) {
  const code = fs.readFileSync(cliPath, 'utf8');
  const ver = version || detectVersion(cliPath, code);
  ex.setCcVersionForCacheLookups(ver);
  // Read-only lookup table for the verdicts. The extractor's own cache is
  // loaded by the traversal from the repo file; it only affects capture, not
  // the bodies or keys reported here.
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const records = quietly(() => ex.collectLiteralSites(cliPath, { composites: true }));
  const matches = selectEntries(buildEntries(records), query).map(e => describe(e, cache));
  return { version: ver, matches };
}

function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`probeCacheKey: ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  const cliPath = path.resolve(opt.positional[0]);
  if (!fs.existsSync(cliPath)) {
    console.error(`probeCacheKey: no such file ${cliPath}\n${USAGE}`);
    process.exit(2);
  }
  const { version, matches } = probe(
    cliPath,
    { offset: opt.offset, text: opt.text, hash: opt.hash },
    { cachePath: opt.cache ? path.resolve(opt.cache) : DEFAULT_CACHE, version: opt.version }
  );
  if (!version) console.error('probeCacheKey: CC version unknown; <<CCVERSION>> variants omitted (pass --version)');
  const limit = opt.limit !== undefined ? Number(opt.limit) : opt.json ? Infinity : 50;
  const shown = matches.slice(0, limit);
  if (opt.json) console.log(JSON.stringify(shown, null, 1));
  else for (const d of shown) console.log(formatLine(d));
  if (matches.length > shown.length) console.error(`probeCacheKey: ${matches.length - shown.length} more match(es); raise --limit`);
  if (!matches.length) console.error('probeCacheKey: no literal matched');
  process.exit(matches.length ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
