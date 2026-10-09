// Sharded, content-addressed runner for the matcher/regex differential.
//
// The per-prompt check lives in src/matcherDifferential.ts. This module bundles
// it with esbuild, fans the prompt list out across worker_threads (each worker
// reads a bundle once and answers chunks of prompts), merges the answers back
// in catalogue order, and prints the findings. Both the CLI
// (tools/runMatcherDifferential.mjs) and the corpus test
// (src/systemPromptPieceMatcherCorpus.test.ts) call runMatcherDifferential, so
// they cannot drift.
//
// Cache: one JSON file per (code, target) pair, mapping a prompt key to its
// verdict. The code key hashes the esbuild output of the core (so it covers
// every module the core imports, derived from the import graph), the versions
// of the external packages that output imports, this runner, the worker, and
// the Node/V8 build. The target key adds sha1 of the bundle bytes and the CC
// version the regexes are built for; the prompt key is sha1 of the prompt's
// pieces and identifiers. Only deterministic verdicts are cached ("match" and
// "the regex builder rejected the pieces"); a mismatch, an error, or a
// RegExp-engine rejection is recomputed on every run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import * as esbuild from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CORE_ENTRY = path.join(REPO, 'src', 'matcherDifferential.ts');
const WORKER_FILE = path.join(HERE, 'matcherDifferentialWorker.mjs');
const CACHE_FORMAT = 1;
const MIN_CHECKED = 2000;
const MIN_EXERCISED_RATIO = 0.9;
const DETAIL_LIMIT = 10;
const PROGRESS_EVERY = 500;

const sha1 = data => crypto.createHash('sha1').update(data).digest('hex');

export const defaultWorkerCount = () =>
  Math.max(1, os.availableParallelism() - 1);

export const defaultCacheDir = () =>
  process.env.TWEAKCC_MATCHER_CACHE ||
  path.join(os.homedir(), '.cache', 'tweakcc-matcher');

const BUILTINS = new Set(builtinModules);
const isBuiltin = spec =>
  spec.startsWith('node:') || BUILTINS.has(spec.split('/')[0]);

const packageName = spec =>
  spec.startsWith('@')
    ? spec.split('/').slice(0, 2).join('/')
    : spec.split('/')[0];

const externalVersion = spec => {
  if (isBuiltin(spec)) return spec;
  const name = packageName(spec);
  try {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(REPO, 'node_modules', name, 'package.json'),
        'utf8'
      )
    );
    return `${spec}@${pkg.version}`;
  } catch {
    // Unresolvable here: fall back to the whole lockfile, which pins it.
    return `${spec}@lock:${sha1(fs.readFileSync(path.join(REPO, 'pnpm-lock.yaml')))}`;
  }
};

// Bundle the core and derive the code key from what was actually bundled.
export const buildCore = async () => {
  const built = await esbuild.build({
    absWorkingDir: REPO,
    entryPoints: [CORE_ENTRY],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'esnext',
    packages: 'external',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const code = built.outputFiles[0].text;
  const externals = new Set();
  for (const out of Object.values(built.metafile.outputs))
    for (const imp of out.imports) if (imp.external) externals.add(imp.path);
  const deps = [...externals].sort().map(externalVersion);
  const codeHash = sha1(code);
  const key = sha1(
    JSON.stringify({
      format: CACHE_FORMAT,
      code: codeHash,
      deps,
      runner: sha1(fs.readFileSync(fileURLToPath(import.meta.url))),
      worker: sha1(fs.readFileSync(WORKER_FILE)),
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
    })
  );
  // One level below the repo root, like dist/: the core's own lookups
  // (packageMeta's ../package.json, the repo-root walk-ups) and its bare
  // imports then resolve exactly as they do from src/. Gitignored.
  const dir = path.join(REPO, '.matcher-core');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `core-${codeHash}.mjs`);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, code);
    fs.renameSync(tmp, file);
  }
  return {
    file,
    key,
    modules: Object.keys(built.metafile.inputs).sort(),
    deps,
  };
};

const promptsVersionOf = (promptsFile, data) => {
  const fromName = (path
    .basename(promptsFile)
    .match(/^prompts-(\d+\.\d+\.\d+)\.json$/) || [])[1];
  const version = fromName || data.version;
  if (!version)
    throw new Error(
      `cannot tell the CC version of ${promptsFile}: name it prompts-X.Y.Z.json or give it a "version" field`
    );
  return version;
};

const CACHEABLE = {
  match: r => (r.exercised ? 'x' : 'm'),
  'skip-build': () => 'b',
};
const fromCache = code =>
  code === 'x'
    ? { status: 'match', exercised: true }
    : code === 'm'
      ? { status: 'match', exercised: false }
      : code === 'b'
        ? { status: 'skip-build' }
        : null;

const readCacheFile = file => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.format === CACHE_FORMAT && parsed.entries) return parsed.entries;
  } catch {
    /* absent or torn: start empty */
  }
  return {};
};

const writeCacheFile = (file, fresh) => {
  if (Object.keys(fresh).length === 0) return;
  // Merge with whatever a concurrent run wrote meanwhile; rename is atomic.
  const entries = { ...readCacheFile(file), ...fresh };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ format: CACHE_FORMAT, entries }));
  fs.renameSync(tmp, file);
};

const runPool = ({ coreFile, tasks, workers, onResults }) =>
  new Promise((resolve, reject) => {
    if (tasks.length === 0) {
      resolve();
      return;
    }
    let next = 0;
    let live = 0;
    let failed = false;
    const pool = [];
    const fail = err => {
      if (failed) return;
      failed = true;
      for (const w of pool) void w.terminate();
      reject(err);
    };
    const count = Math.min(workers, tasks.length);
    for (let n = 0; n < count; n++) {
      const worker = new Worker(WORKER_FILE, {
        workerData: { coreFile },
        execArgv: [],
      });
      pool.push(worker);
      live++;
      let busy = false;
      const feed = () => {
        if (next < tasks.length) {
          busy = true;
          worker.postMessage(tasks[next++]);
        } else {
          busy = false;
          void worker.terminate();
        }
      };
      worker.on('message', msg => {
        if (failed) return;
        if (!msg.ready) {
          try {
            onResults(msg);
          } catch (err) {
            fail(err);
            return;
          }
        }
        feed();
      });
      worker.on('error', err =>
        fail(new Error(`matcher worker crashed: ${err?.stack || err}`))
      );
      worker.on('exit', code => {
        live--;
        if (failed) return;
        if (busy)
          fail(new Error(`matcher worker exited (code ${code}) mid-chunk`));
        else if (live === 0) {
          if (next < tasks.length)
            fail(new Error('matcher workers exited with work left'));
          else resolve();
        }
      });
    }
  });

/**
 * Run the differential over every prompt of `promptsFile` against each target.
 *
 * @param {object} opts
 * @param {string} opts.promptsFile  prompts-X.Y.Z.json
 * @param {string[]} [opts.bundles]  pristine cli.js files
 * @param {boolean} [opts.synthetic] also check each prompt's synthetic haystack
 * @param {number} [opts.workers]
 * @param {boolean} [opts.cache]
 * @param {string} [opts.cacheDir]
 * @param {(line: string) => void} [opts.log]
 */
export const runMatcherDifferential = async ({
  promptsFile,
  bundles = [],
  synthetic = false,
  workers = defaultWorkerCount(),
  cache = true,
  cacheDir = defaultCacheDir(),
  log = line => console.log(line),
}) => {
  const started = Date.now();
  const secs = from => `${((Date.now() - from) / 1000).toFixed(0)}s`;
  const data = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
  const promptsVersion = promptsVersionOf(promptsFile, data);
  const prompts = (data.prompts || [])
    .map((p, index) => ({ ...p, index }))
    .filter(p => Array.isArray(p.pieces) && p.pieces.length > 0);
  const keys = prompts.map(p =>
    sha1(JSON.stringify([p.pieces, p.identifiers ?? null]))
  );

  const coreBuild = await buildCore();
  const core = await import(pathToFileURL(coreBuild.file).href);

  const targets = [];
  if (synthetic)
    targets.push({
      kind: 'synthetic',
      label: 'synthetic differential',
      file: null,
      version: promptsVersion,
      contentKey: 'synthetic',
      size: null,
    });
  for (const file of bundles) {
    const buf = fs.readFileSync(file);
    targets.push({
      kind: 'bundle',
      label: `real-bundle differential [${file}]`,
      file: path.resolve(file),
      version: core.bundleCcVersion(buf.toString('utf8'), promptsVersion),
      contentKey: sha1(buf),
      size: buf.length,
    });
  }

  const tasks = [];
  for (const [t, target] of targets.entries()) {
    target.results = new Array(prompts.length);
    target.cacheFile = path.join(
      cacheDir,
      `${sha1(JSON.stringify([coreBuild.key, target.contentKey, target.version]))}.json`
    );
    target.fresh = {};
    const cached = cache ? readCacheFile(target.cacheFile) : {};
    const pending = [];
    prompts.forEach((p, i) => {
      const hit = fromCache(cached[keys[i]]);
      if (hit) target.results[i] = hit;
      else pending.push(i);
    });
    target.cached = prompts.length - pending.length;
    target.pending = pending.length;
    target.done = 0;
    target.mismatchCount = 0;
    // Longest prompts first so the slow ones do not form the tail.
    const weight = i => prompts[i].pieces.reduce((n, s) => n + s.length, 0);
    pending.sort((a, b) => weight(b) - weight(a) || a - b);
    const chunk = Math.max(
      1,
      Math.min(64, Math.ceil(pending.length / (workers * 8)))
    );
    for (let s = 0; s < pending.length; s += chunk)
      tasks.push({
        target: t,
        file: target.file,
        version: target.version,
        items: pending
          .slice(s, s + chunk)
          .map(i => ({ i, pieces: prompts[i].pieces })),
      });
    log(
      `${target.label}: ${prompts.length} prompt(s)` +
        (target.size === null
          ? ''
          : ` vs ${(target.size / 1e6).toFixed(1)}MB`) +
        ` of ${target.version} — ${target.cached} cached, ${target.pending} to check`
    );
  }
  log(
    `matcher differential: ${tasks.length} chunk(s) on ${Math.min(workers, tasks.length)} worker(s), core ${path.basename(coreBuild.file)} (${coreBuild.modules.length} modules)`
  );

  await runPool({
    coreFile: coreBuild.file,
    tasks,
    workers,
    onResults: ({ target: t, results }) => {
      const target = targets[t];
      for (const { i, r } of results) {
        if (target.results[i]) throw new Error(`prompt ${i} answered twice`);
        target.results[i] = r;
        if (r.status === 'mismatch' || r.status === 'error')
          target.mismatchCount++;
        const code = CACHEABLE[r.status]?.(r);
        if (code) target.fresh[keys[i]] = code;
        target.done++;
        if (target.done % PROGRESS_EVERY === 0)
          log(
            `  ${target.label}: ${target.done}/${target.pending} checked, ${target.mismatchCount} mismatch(es), ${secs(started)}`
          );
      }
    },
  });

  let ok = true;
  const summaries = targets.map(target => {
    const missing = target.results.findIndex(r => !r);
    if (missing !== -1)
      throw new Error(`${target.label}: prompt ${missing} has no verdict`);
    const s = {
      kind: target.kind,
      label: target.label,
      file: target.file,
      version: target.version,
      total: prompts.length,
      checked: 0,
      exercised: 0,
      skippedBuild: 0,
      skippedRegex: 0,
      cached: target.cached,
      mismatches: [],
      errors: [],
      failures: [],
    };
    target.results.forEach((r, i) => {
      const p = prompts[i];
      if (r.status === 'skip-build') s.skippedBuild++;
      else if (r.status === 'skip-regex') s.skippedRegex++;
      else if (r.status === 'error')
        s.errors.push({ id: p.id, index: p.index, message: r.message });
      else {
        s.checked++;
        if (r.status === 'match' && r.exercised) s.exercised++;
        if (r.status === 'mismatch')
          s.mismatches.push({
            id: p.id,
            index: p.index,
            detail: core.formatMismatch(
              p.pieces,
              r.expected,
              r.actual,
              target.kind === 'synthetic'
            ),
          });
      }
    });
    if (s.checked <= MIN_CHECKED)
      s.failures.push(
        `only ${s.checked} prompt(s) checked (want > ${MIN_CHECKED})`
      );
    if (
      target.kind === 'synthetic' &&
      !(s.exercised / s.checked > MIN_EXERCISED_RATIO)
    )
      s.failures.push(
        `only ${s.exercised}/${s.checked} synthetic haystacks matched (want > ${MIN_EXERCISED_RATIO}); the test went vacuous`
      );
    if (s.mismatches.length)
      s.failures.push(`${s.mismatches.length} mismatch(es)`);
    if (s.errors.length) s.failures.push(`${s.errors.length} error(s)`);
    s.ok = s.failures.length === 0;
    ok &&= s.ok;
    return s;
  });

  if (cache) {
    fs.mkdirSync(cacheDir, { recursive: true });
    for (const target of targets)
      writeCacheFile(target.cacheFile, target.fresh);
  }

  for (const s of summaries) {
    s.mismatches.slice(0, DETAIL_LIMIT).forEach(m => {
      log(`mismatch ${m.id} (prompt #${m.index}) in ${s.label}:`);
      log(m.detail);
    });
    if (s.mismatches.length > DETAIL_LIMIT)
      log(
        `… ${s.mismatches.length - DETAIL_LIMIT} more mismatch(es): ${s.mismatches
          .slice(DETAIL_LIMIT)
          .map(m => m.id)
          .join(', ')}`
      );
    for (const e of s.errors)
      log(`error ${e.id} (prompt #${e.index}) in ${s.label}:\n${e.message}`);
    log(
      `${s.label}: ${s.checked}/${s.total} checked, ${s.mismatches.length} mismatch(es), ${s.errors.length} error(s)` +
        (s.kind === 'synthetic' ? `, ${s.exercised} exercised` : '') +
        `, skipped ${s.skippedBuild} (regex build) + ${s.skippedRegex} (RegExp rejected), ${s.cached} from cache — ${s.ok ? 'PASS' : `FAIL: ${s.failures.join('; ')}`}`
    );
  }
  log(
    `matcher differential: ${ok ? 'PASS' : 'FAIL'} — ${summaries.length} target(s), ${secs(started)}`
  );
  return { ok, targets: summaries, core: coreBuild };
};
