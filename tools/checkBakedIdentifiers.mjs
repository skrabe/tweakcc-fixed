#!/usr/bin/env node
// Catalogue entries whose pieces pin a minified name.
//
// The extractor turns identifiers inside a slot expression into slots; any it
// leaves behind stays in a piece as one build's text. The apply's matchers
// accept any name there (src/systemPromptExpressionIdentifiers.ts), but the
// cache key, the id carryover and an override's write-back all use the literal:
// CC 2.1.296 renamed `String(O)` to `String(M)` inside a slot of
// tool-result-start-task-input-wrong-type and the id was lost.
//
// Ground truth is the bundles themselves. For each entry, every identifier the
// matchers generalize becomes a capture; every entry is matched in every bundle
// given, and a capture that reads differently from the piece is a baked name.
// An entry missing from a build its `platforms` tag says carries it fails too:
// a catalogue that matches nothing must not pass as one that differs nowhere.
//
//   node tools/checkBakedIdentifiers.mjs <prompts.json> [<platform>=]<cli.js> [<platform>=]<cli.js> … [--json]
//
// A bundle's platform is given as `linux=<path>` or read from its path
// (`…/linux-arm64/cli.js`); otherwise it is this host's.
//
// Exit 0 = every entry found where expected and no name differs across the
// builds; 1 = some entry is baked or missing (listed); 2 = usage error, fewer
// than two distinct builds, or an unreadable or empty bundle.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Worker,
  isMainThread,
  parentPort,
  threadId,
  workerData,
} from 'node:worker_threads';
import * as esbuild from 'esbuild';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One self-contained module exporting the apply's own generalization and regex
// builder, so the scanner cannot drift from what the apply matches. Returns the
// file; workers import it rather than building their own copy.
export const buildMatcherCore = async () => {
  const built = await esbuild.build({
    absWorkingDir: REPO,
    stdin: {
      contents: [
        "export { generalizeExpressionIdentifiers, IDENTIFIER_SENTINEL } from './src/systemPromptExpressionIdentifiers';",
        "export { buildSearchRegexFromPieces } from './src/systemPromptSync';",
        "export { findPromptPieceMatchesByTokens } from './src/systemPromptPieceMatcher';",
      ].join('\n'),
      resolveDir: REPO,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'esnext',
    packages: 'external',
    write: false,
    logLevel: 'silent',
  });
  const code = built.outputFiles[0].text;
  const dir = path.join(REPO, '.matcher-core');
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha1').update(code).digest('hex');
  const file = path.join(dir, `baked-${hash}.mjs`);
  publishOnce(file, code);
  return file;
};

// Writes `file` unless it exists. Only the rename publishes it, so no importer
// sees it half written; the temp name is unique per thread, since worker
// threads share the pid.
export const publishOnce = (file, code) => {
  if (fs.existsSync(file)) return;
  const tmp = `${file}.${process.pid}.${threadId}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, code);
  fs.renameSync(tmp, file);
};

const importCore = file => import(pathToFileURL(file).href);

export const loadMatcherCore = async () => importCore(await buildMatcherCore());

// Each generalized name becomes `\x01{k}\x01`, k its index in the entry. The
// braces keep a name that sits in a complete `${…}` inside one piece from being
// folded into the builder's any-interpolation wildcard (`\$\{[^{}]*\}`), which
// would drop its capture and shift every later group onto the wrong role; the
// span is matched literally instead, which on any build differs only in the
// names it captures.
const MARK_CHAR = String.fromCharCode(1);
const mark = k => `${MARK_CHAR}{${k}}${MARK_CHAR}`;
// The mark as the regex builder escapes it: `\x01\{k\}\x01`.
const MARK_IN_PATTERN = `${MARK_CHAR}\\\\\\{(\\d+)\\\\\\}${MARK_CHAR}`;
const SLOT_GROUP = '([\\w$]+)';

// The generalized identifiers of one entry: per piece, the names the matchers
// replace, and the pieces with each such name swapped for its mark.
export const bakedPositions = (core, pieces) => {
  const generalized = core.generalizeExpressionIdentifiers(pieces);
  const sentinel = core.IDENTIFIER_SENTINEL;
  const names = [];
  const marked = [];
  let next = 0;
  generalized.forEach((gen, p) => {
    const orig = pieces[p];
    const parts = gen.split(sentinel);
    const pieceNames = [];
    let cursor = 0;
    let out = '';
    parts.forEach((part, k) => {
      out += part;
      cursor += part.length;
      if (k === parts.length - 1) return;
      const name = orig.slice(cursor).match(/^[\w$]+/)[0];
      pieceNames.push(name);
      out += mark(next++);
      cursor += name.length;
    });
    names.push(pieceNames);
    marked.push(out);
  });
  return { names, marked };
};

// The search pattern and the role of each of its capture groups, read off the
// built pattern itself: a baked name ({ piece, k, name }) or a slot (null).
// Throws when a mark did not survive the build, since every later group would
// then be read as the wrong role.
export const scannerPattern = (core, marked, names, version, buildTime) => {
  const built = core.buildSearchRegexFromPieces(marked, version, buildTime);
  const flat = names.flatMap((pieceNames, piece) =>
    pieceNames.map((name, k) => ({ piece, k, name }))
  );
  const roles = [];
  const seen = new Set();
  let pattern = '';
  let last = 0;
  const token = new RegExp(
    `${MARK_IN_PATTERN}|${SLOT_GROUP.replace(/[()[\]\\$+]/g, '\\$&')}`,
    'g'
  );
  let m;
  while ((m = token.exec(built)) !== null) {
    pattern += built.slice(last, m.index) + SLOT_GROUP;
    last = m.index + m[0].length;
    if (m[1] === undefined) {
      roles.push(null);
      continue;
    }
    const i = Number(m[1]);
    if (seen.has(i) || !flat[i])
      throw new Error(`mark ${i} repeated or unknown in the built pattern`);
    seen.add(i);
    roles.push(flat[i]);
  }
  pattern += built.slice(last);
  if (seen.size !== flat.length)
    throw new Error(
      `${flat.length - seen.size} of ${flat.length} baked name(s) lost from the built pattern`
    );
  return { pattern, roles };
};

// The regex of a whole text asset (a 600K-char .d.ts, the public-suffix list)
// overflows V8's regexp compiler. Those fall back to the apply's own token
// matcher, which never compiles it; everything else keeps the regex, which is
// the fast path for a one-off scan of a 50 MB bundle.
export const presenceInBundle = (core, entry, bundle) => {
  const pattern = core.buildSearchRegexFromPieces(
    entry.pieces,
    bundle.version,
    bundle.buildTime
  );
  let found;
  try {
    found = new RegExp(pattern, 's').test(bundle.content);
  } catch (err) {
    // Anchored on V8's suffix: the message embeds the whole pattern, so an
    // unanchored test also matches any prompt that says "too large".
    if (
      !/(?:: (?:Stack overflow|Regular expression too large)|^Maximum call stack size exceeded)$/.test(
        err.message
      )
    ) {
      throw err;
    }
    const byTokens = core.findPromptPieceMatchesByTokens(
      {
        regex: pattern,
        pieces: entry.pieces,
        version: bundle.version,
        buildTime: bundle.buildTime,
      },
      bundle.content
    );
    if (!byTokens) throw err;
    found = byTokens.length > 0;
  }
  return { names: [], count: found ? 1 : 0, seen: [] };
};

const inspectBakedInBundle = (core, entry, bundle, presence) => {
  const { names, marked } = bakedPositions(core, entry.pieces);
  if (!names.flat().length) return presence;
  const { pattern, roles } = scannerPattern(
    core,
    marked,
    names,
    bundle.version,
    bundle.buildTime
  );
  const hasNames = roles.some(Boolean);
  if (!hasNames) return presence;
  const re = new RegExp(pattern, hasNames ? 'sg' : 's');
  const seen = new Map();
  let count = 0;
  let m;
  while ((m = re.exec(bundle.content)) !== null) {
    count++;
    roles.forEach((role, i) => {
      if (!role) return;
      const got = m[i + 1];
      if (got === role.name) return;
      const key = `${role.piece}:${role.k}`;
      if (!seen.has(key)) seen.set(key, { ...role, got: new Set() });
      seen.get(key).got.add(got);
    });
    if (m[0].length === 0) re.lastIndex++;
  }
  return {
    names: names.flat(),
    count: presence.count ? count || 1 : 0,
    ...(presence.count && !count
      ? {
          error:
            'apply matcher found the entry, but baked-name inspection could not match its expression structure',
        }
      : {}),
    seen: [...seen.values()].map(({ got, ...role }) => ({
      ...role,
      got: [...got],
    })),
  };
};

// One bundle's matches for one entry: how many, and per baked name every
// spelling that differs from the catalogue's. An entry with no baked name only
// needs to be found once.
export const matchInBundle = (core, entry, bundle) => {
  const presence = presenceInBundle(core, entry, bundle);
  if (!presence.count) return presence;
  try {
    return inspectBakedInBundle(core, entry, bundle, presence);
  } catch (err) {
    return { ...presence, error: err.message };
  }
};

// Whether a bundle of this platform should carry the entry: untagged entries
// ship everywhere, tagged ones (tools/tagPlatforms.mjs) only where listed.
export const expectedIn = (entry, bundle) =>
  !Array.isArray(entry.platforms) || entry.platforms.includes(bundle.platform);

// Folds per-bundle matches (`perBundle[label]`) into one result per entry.
export const combineEntry = (entry, perBundle, bundles) => {
  const found = {};
  const differing = new Map();
  let names = [];
  for (const b of bundles) {
    const r = perBundle[b.label];
    found[b.label] = r.count;
    if (r.names.length) names = r.names;
    for (const s of r.seen) {
      const key = `${s.piece}:${s.k}`;
      if (!differing.has(key))
        differing.set(key, { piece: s.piece, name: s.name, seen: {} });
      differing.get(key).seen[b.label] = s.got;
    }
  }
  return {
    id: entry.id || entry.name || '(anonymous)',
    names,
    found,
    missing: bundles
      .filter(b => found[b.label] === 0 && expectedIn(entry, b))
      .map(b => b.label),
    differing: [...differing.values()],
  };
};

export const scanEntry = (core, entry, bundles) => {
  const perBundle = {};
  for (const b of bundles) perBundle[b.label] = matchInBundle(core, entry, b);
  return combineEntry(entry, perBundle, bundles);
};

const PLATFORMS = ['darwin', 'linux', 'win32'];

const PLATFORM_TOKEN = new RegExp(
  `(?:^|[_.-])(${PLATFORMS.join('|')})(?=[_.-]|$)`,
  'g'
);

// `<platform>=<path>`, or a bare path whose directories or file name name the
// platform (`…/linux-arm64/cli.js`); anything else is this host's own build.
// The component nearest the file wins: `/srv/darwin-ci/linux-x64/cli.js` is a
// linux build kept on a darwin box.
export const parseBundleSpec = spec => {
  const eq = spec.indexOf('=');
  if (eq > 0 && PLATFORMS.includes(spec.slice(0, eq)))
    return { platform: spec.slice(0, eq), file: spec.slice(eq + 1) };
  for (const part of spec.split(/[/\\]/).reverse()) {
    const named = [...part.matchAll(PLATFORM_TOKEN)].at(-1);
    if (named) return { platform: named[1], file: spec };
  }
  return { platform: process.platform, file: spec };
};

// The CC version a bundle stamps on itself. Vendored packages carry their own
// `VERSION:"…"`, so the most frequent stamp is the bundle's.
export const bundleVersion = content => {
  const counts = new Map();
  for (const m of content.matchAll(/VERSION:"(\d+\.\d+\.\d+)"/g))
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

export const readBundle = (file, platform) => {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read bundle ${file}: ${err.message}`);
  }
  if (!content.trim()) throw new Error(`bundle ${file} is empty`);
  const version = bundleVersion(content);
  if (!version)
    throw new Error(`bundle ${file} carries no VERSION:"X.Y.Z" stamp`);
  const buildTime = (content.match(/BUILD_TIME:"([^"]+)"/) || [])[1];
  return { label: file, platform, content, version, buildTime };
};

// Each worker matches a slice of the catalogue against one bundle.
const runWorker = async () => {
  const { coreFile, file, platform, entries, mode } = workerData.bakedScan;
  const core = await importCore(coreFile);
  const bundle = readBundle(file, platform);
  const out = entries.map(e => {
    try {
      return (mode === 'presence' ? presenceInBundle : matchInBundle)(
        core,
        e,
        bundle
      );
    } catch (err) {
      return { error: err.message };
    }
  });
  parentPort.postMessage(out);
};

// Per-entry scan results, keyed on everything a result depends on: the matcher
// core (its file name is its content hash), the bundle bytes, the mode and the
// entry's pieces. A bump re-extracts several times against the same bundles and
// only a handful of entries change between passes, so each pass re-matches only
// those (a full scan of three 53 MB bundles took 5.5 min on CC 2.1.312).
// Per-user directory, like the extractor's site cache.
const scanCacheDir = () => {
  if (process.env.TWEAKCC_SCAN_CACHE_DIR)
    return process.env.TWEAKCC_SCAN_CACHE_DIR;
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'tweakcc', 'scan');
};
const scanCacheDisabled = () => {
  const v = process.env.TWEAKCC_SCAN_NO_CACHE;
  return Boolean(v) && v !== '0';
};
const sha1 = data => crypto.createHash('sha1').update(data).digest('hex');
const scanCacheFile = (coreFile, bundleFile, mode) =>
  path.join(
    scanCacheDir(),
    `${path.basename(coreFile, '.mjs')}-${sha1(fs.readFileSync(bundleFile)).slice(0, 20)}-${mode}.json`
  );
const entryKey = e => sha1(JSON.stringify(e.pieces));
const readScanCache = file => {
  if (scanCacheDisabled()) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))));
  } catch {
    return new Map();
  }
};
const writeScanCache = (file, map) => {
  if (scanCacheDisabled()) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)));
  fs.renameSync(tmp, file);
};

export const scanInWorkers = async (
  entries,
  specs,
  workerLimit = os.availableParallelism?.() || os.cpus().length,
  mode = 'baked'
) => {
  if (!Number.isInteger(workerLimit) || workerLimit < 1)
    throw new Error('worker limit must be a positive integer');
  if (!['baked', 'presence'].includes(mode))
    throw new Error('scan mode must be baked or presence');
  const results = new Map(specs.map(s => [s.file, new Array(entries.length)]));
  const coreFile = await buildMatcherCore();
  const keys = entries.map(entryKey);
  const caches = new Map();
  const todo = new Map();
  for (const spec of specs) {
    const file = scanCacheFile(coreFile, spec.file, mode);
    const cache = readScanCache(file);
    caches.set(spec.file, { file, cache, dirty: false });
    const out = results.get(spec.file);
    const miss = [];
    keys.forEach((k, i) => {
      if (cache.has(k)) out[i] = cache.get(k);
      else miss.push(i);
    });
    todo.set(spec.file, miss);
  }
  const shards = Math.max(1, Math.ceil(workerLimit / specs.length));
  const jobs = [];
  for (const spec of specs) {
    const miss = todo.get(spec.file);
    const size = Math.ceil(miss.length / shards) || 1;
    for (let from = 0; from < miss.length; from += size)
      jobs.push({ spec, idx: miss.slice(from, from + size) });
  }
  let nextJob = 0;
  await Promise.all(
    Array.from({ length: Math.min(workerLimit, jobs.length) }, async () => {
      while (nextJob < jobs.length) {
        const { spec, idx } = jobs[nextJob++];
        await new Promise((resolve, reject) => {
          const w = new Worker(fileURLToPath(import.meta.url), {
            workerData: {
              bakedScan: {
                coreFile,
                file: spec.file,
                platform: spec.platform,
                mode,
                entries: idx.map(i => ({ pieces: entries[i].pieces })),
              },
            },
          });
          let reported = false;
          w.once('message', out => {
            const c = caches.get(spec.file);
            out.forEach((r, j) => {
              results.get(spec.file)[idx[j]] = r;
              // An error is a property of this run (memory, a regex limit),
              // not of the inputs, so it is never cached.
              if (!r.error) {
                c.cache.set(keys[idx[j]], r);
                c.dirty = true;
              }
            });
            reported = true;
          });
          w.once('error', reject);
          w.once('exit', code => {
            if (code !== 0) reject(new Error(`worker exited ${code}`));
            else if (!reported)
              reject(new Error('worker exited without results'));
            else resolve();
          });
        });
      }
    })
  );
  for (const { file, cache, dirty } of caches.values())
    if (dirty) writeScanCache(file, cache);
  return results;
};

const usage = msg => {
  console.error(`baked-identifier scan: ${msg}`);
  console.error(
    'usage: checkBakedIdentifiers.mjs <prompts.json> [<platform>=]<cli.js> [<platform>=]<cli.js> … [--json]'
  );
  process.exit(2);
};

const main = async () => {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const [promptsFile, ...bundleArgs] = args.filter(a => a !== '--json');
  if (!promptsFile) usage('no prompts JSON given');
  // A name baked into pieces only shows as a difference between builds, and a
  // missing entry only as an absence from one: fewer than two builds compare
  // nothing, and an unreadable or empty one matches nothing.
  if (bundleArgs.length < 2)
    usage(
      `${bundleArgs.length} bundle(s) given; at least two builds are needed`
    );
  const data = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
  const specs = bundleArgs.map(parseBundleSpec);
  let bundles;
  try {
    bundles = specs.map(s => readBundle(s.file, s.platform));
  } catch (err) {
    usage(err.message);
  }
  if (new Set(bundles.map(b => b.content)).size < 2)
    usage('every bundle given has the same content; nothing to compare');
  for (const b of bundles) b.content = null;
  const entries = data.prompts;
  const perFile = await scanInWorkers(entries, specs);
  const scanned = [];
  const errors = [];
  entries.forEach((entry, i) => {
    const perBundle = {};
    for (const b of bundles) {
      const r = perFile.get(b.label)[i];
      if (r.error) errors.push(`${entry.id || '(anonymous)'}: ${r.error}`);
      perBundle[b.label] = { names: [], count: 0, seen: [], ...r };
    }
    scanned.push(combineEntry(entry, perBundle, bundles));
  });
  const named = scanned.filter(r => r.names.length);
  const baked = scanned.filter(r => r.differing.length);
  const missing = scanned.filter(r => r.missing.length);
  const short = b => `${path.basename(path.dirname(b))}/${path.basename(b)}`;
  if (json) {
    console.log(
      JSON.stringify({ bundles: specs, named, baked, missing, errors }, null, 1)
    );
  } else {
    for (const s of specs) console.log(`  bundle ${s.platform}: ${s.file}`);
    for (const r of baked) {
      console.log(`  ${r.id}`);
      for (const d of r.differing)
        console.log(
          `    piece ${d.piece} \`${d.name}\` -> ${Object.entries(d.seen)
            .map(([b, v]) => `${short(b)}: ${v.join(',')}`)
            .join('; ')}`
        );
    }
    for (const r of missing)
      console.log(
        `  MISSING ${r.id} from ${r.missing.map(short).join(', ')} ${JSON.stringify(r.found)}`
      );
    for (const e of errors) console.log(`  ERROR ${e}`);
    console.log(
      `baked-identifier scan: ${scanned.length} entr(ies) matched in ${bundles.length} bundle(s); ${named.length} keep a name inside a slot expression, ${baked.length} differ across builds; ${missing.length} missing from a build that should carry them; ${errors.length} error(s)`
    );
  }
  process.exitCode = baked.length || missing.length || errors.length ? 1 : 0;
};

if (isMainThread && process.argv[1] === fileURLToPath(import.meta.url))
  await main();
else if (!isMainThread && workerData?.bakedScan) await runWorker();
