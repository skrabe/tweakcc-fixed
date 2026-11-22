#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildEditShapeSet } from './editShapes.mjs';
import { normalizeLog } from './normalize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CC_VERSION = '2.1.330';
const MEASURE = path.join(HERE, 'measure.py');
const REPACK = path.join(HERE, 'repack.mjs');

const USAGE = `usage: node tools/applyEquality/run.mjs [options]

Builds production dists of two git refs and compares their applies, serially,
under the shared apply lock, at one fixed config-dir path.

  --baseline REF         baseline ref (default origin/main)
  --candidate REF        candidate ref (default HEAD)
  --stages LIST          correctness,coverage,repack,perf (default all four)
  --profile NAME         full | quick (default full)
  --cases LIST           explicit target:set pairs, overrides --profile
  --trace MODE           both | candidate | none (default both)
  --shadow-cases LIST    target:set pairs run with TWEAKCC_PERF_SHADOW=1 on the
                         candidate; "all" or "none" (default: the lcc cases of
                         linux-x64, darwin-macho, darwin-npm, and linux-x64:edits)
  --perf-cases LIST      target:set pairs for perf runs (default
                         linux-x64:lcc,darwin-npm:lcc)
  --perf-runs N          runs per side per perf case (default 3)
  --corpus-cache         let the matcher corpus reuse its verdict cache
  --keep                 keep outputs, traces and binaries of identical cases
  --repo DIR             repository (default: the one holding this script)
  --scratch DIR          scratch root (default ~/perf-scratch/applyEquality)
  --lock FILE            apply lock (default ~/perf-scratch/apply.lock)
  --inputs DIR           input binaries (default ~/wk-inputs)
  --tweakcc DIR          maintained override sets: lcc is where its
                         system-prompts and system-reminders resolve to,
                         staging is skrabe-staging/system-prompts-lcc
                         (default ~/.tweakcc)
  --config FILE          tweakcc config.json copied into every sandbox
                         (default <inputs>/config.json when present, else
                         <tweakcc>/config.json)

Targets: linux-x64 linux-arm64 darwin-macho darwin-npm
Sets: lcc staging empty seed1 seed2 seed3 edits filtered`;

const parseArgs = argv => {
  const opts = {
    baseline: 'origin/main',
    candidate: 'HEAD',
    stages: ['correctness', 'coverage', 'repack', 'perf'],
    profile: 'full',
    cases: null,
    trace: 'both',
    shadowCases: null,
    perfCases: ['linux-x64:lcc', 'darwin-npm:lcc'],
    perfRuns: 3,
    corpusCache: false,
    keep: false,
    repo: path.resolve(HERE, '..', '..'),
    scratch: path.join(HOME, 'perf-scratch', 'applyEquality'),
    lock: path.join(HOME, 'perf-scratch', 'apply.lock'),
    inputs: path.join(HOME, 'wk-inputs'),
    tweakcc: path.join(HOME, '.tweakcc'),
    config: null,
  };
  const list = value => value.split(',').filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--baseline') opts.baseline = value();
    else if (arg === '--candidate') opts.candidate = value();
    else if (arg === '--stages') opts.stages = list(value());
    else if (arg === '--profile') opts.profile = value();
    else if (arg === '--cases') opts.cases = list(value());
    else if (arg === '--trace') opts.trace = value();
    else if (arg === '--shadow-cases') opts.shadowCases = value();
    else if (arg === '--perf-cases') opts.perfCases = list(value());
    else if (arg === '--perf-runs') opts.perfRuns = Number(value());
    else if (arg === '--corpus-cache') opts.corpusCache = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--repo') opts.repo = path.resolve(value());
    else if (arg === '--scratch') opts.scratch = path.resolve(value());
    else if (arg === '--lock') opts.lock = path.resolve(value());
    else if (arg === '--inputs') opts.inputs = path.resolve(value());
    else if (arg === '--tweakcc') opts.tweakcc = path.resolve(value());
    else if (arg === '--config') opts.config = path.resolve(value());
    else throw new Error(`unknown option ${arg}\n\n${USAGE}`);
  }
  if (!opts.config) {
    const staged = path.join(opts.inputs, 'config.json');
    opts.config = fs.existsSync(staged)
      ? staged
      : path.join(opts.tweakcc, 'config.json');
  }
  if (!['both', 'candidate', 'none'].includes(opts.trace))
    throw new Error(`--trace must be both, candidate or none`);
  if (!Number.isInteger(opts.perfRuns) || opts.perfRuns < 1)
    throw new Error('--perf-runs must be a positive integer');
  return opts;
};

const opts = parseArgs(process.argv.slice(2));
const CFG = path.join(opts.scratch, 'cfg');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(opts.scratch, 'runs', RUN_ID);

const TARGETS = {
  'linux-x64': {
    kind: 'native',
    platform: 'linux',
    input: path.join(opts.inputs, 'linux-x64', 'package', 'claude'),
  },
  'linux-arm64': {
    kind: 'native',
    platform: 'linux',
    input: path.join(opts.inputs, 'linux-arm64', 'package', 'claude'),
  },
  'darwin-macho': {
    kind: 'native',
    platform: 'darwin',
    input: path.join(opts.inputs, `claude-${CC_VERSION}-darwin-arm64`),
  },
  'darwin-npm': {
    kind: 'npm',
    platform: 'darwin',
    input: path.join(opts.inputs, `cli-${CC_VERSION}-darwin.js`),
  },
};

const resolvedSet = name => {
  const link = path.join(opts.tweakcc, name);
  return fs.existsSync(link) ? fs.realpathSync(link) : null;
};
const LCC_PROMPTS = resolvedSet('system-prompts');
const LCC_REMINDERS = resolvedSet('system-reminders');
const STAGING_PROMPTS = path.join(
  opts.tweakcc,
  'skrabe-staging',
  'system-prompts-lcc'
);
const SET_NAMES = [
  'lcc',
  'staging',
  'empty',
  'seed1',
  'seed2',
  'seed3',
  'edits',
  'filtered',
];

const BASE_SHAPES = ['same', 'shrink-1', 'grow-1'];
const REPACK_INPUTS = [
  {
    name: 'elf-x64-2.1.330',
    file: TARGETS['linux-x64'].input,
    shapes: [...BASE_SHAPES, 'grow-4097'],
  },
  {
    name: 'elf-arm64-2.1.330',
    file: TARGETS['linux-arm64'].input,
    shapes: BASE_SHAPES,
  },
  {
    name: 'macho-arm64-2.1.330',
    file: TARGETS['darwin-macho'].input,
    shapes: [...BASE_SHAPES, 'grow-16385'],
  },
  {
    name: 'macho-x64-2.1.330',
    file: path.join(
      opts.inputs,
      'extra',
      'claude-code-darwin-x64-2.1.330',
      'package',
      'claude'
    ),
    shapes: [...BASE_SHAPES, 'grow-4097', 'grow-16385'],
  },
  {
    name: 'pe-x64-2.1.330',
    file: path.join(
      opts.inputs,
      'extra',
      'claude-code-win32-x64-2.1.330',
      'package',
      'claude.exe'
    ),
    shapes: BASE_SHAPES,
  },
  {
    name: 'elf-x64-2.1.110-single-module',
    file: path.join(
      opts.inputs,
      'extra',
      'claude-code-linux-x64-2.1.110',
      'package',
      'claude'
    ),
    shapes: BASE_SHAPES,
  },
];
const REPACK_TODO = [
  'TODO: page-crossing growth: on 2.1.330 every writer output keeps one size across same/shrink-1/grow-1/grow-4097/grow-16385 (clearing the bytecode frees slack the growth fits in), so the Mach-O 4 KB / 16 KB page-rounding branches are not yet exercised; add grow shapes sized past that slack per input',
  'TODO: u32 section header input (Mach-O / PE built by Bun < 1.3.4): fabricate with Bun 1.3.3 `bun build --compile` for bun-darwin-x64, bun-darwin-arm64 and bun-windows-x64 (DESIGN-v3 §3 U2b) and add it to REPACK_INPUTS',
  'TODO: legacy ELF overlay input (no .bun section, `---- Bun! ----` trailer at EOF): fabricate with a Bun release that predates the ELF .bun section and add it to REPACK_INPUTS',
];

const LOGICAL_KINDS = new Set([
  'prompt',
  'splice',
  'clobber',
  'row',
  'replay',
  'batch',
  'preflight',
  'preflight-error',
  'phase',
  'patch',
]);

const progressLines = [];
const log = line => {
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  console.log(stamped);
  progressLines.push(stamped);
  if (fs.existsSync(OUT))
    fs.appendFileSync(path.join(OUT, 'progress.log'), `${stamped}\n`);
};

const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    ...options,
  });

const must = (result, what) => {
  if (result.status !== 0) {
    throw new Error(
      `${what} failed (exit ${result.status}${result.signal ? `, ${result.signal}` : ''}):\n${String(result.stderr ?? '').slice(-3000)}\n${String(result.stdout ?? '').slice(-3000)}`
    );
  }
  return result.stdout;
};

const toolEnv = () => ({
  ...process.env,
  PATH: fs.existsSync('/tmp/pnpm-shim')
    ? `/tmp/pnpm-shim:${process.env.PATH}`
    : process.env.PATH,
});

const cleanEnv = extra => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('TWEAKCC_') || key.startsWith('EQ_')) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
};

const insideScratch = target => {
  const resolved = path.resolve(target);
  const root = path.resolve(opts.scratch) + path.sep;
  if (!resolved.startsWith(root))
    throw new Error(`refusing to touch ${resolved}: outside ${root}`);
  return resolved;
};

const removeTree = target =>
  fs.rmSync(insideScratch(target), { recursive: true, force: true });

const removeFile = target => {
  const resolved = insideScratch(target);
  if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
};

const acquireHarnessLock = () => {
  fs.mkdirSync(opts.scratch, { recursive: true });
  const file = path.join(opts.scratch, 'harness.pid');
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  } catch {
    const holder = Number(fs.readFileSync(file, 'utf8'));
    let alive = false;
    try {
      process.kill(holder, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive)
      throw new Error(
        `another harness (pid ${holder}) is using ${opts.scratch}`
      );
    fs.writeFileSync(file, String(process.pid));
  }
  const release = () => {
    try {
      if (fs.readFileSync(file, 'utf8') === String(process.pid))
        fs.unlinkSync(file);
    } catch {
      return;
    }
  };
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      release();
      process.exit(130);
    });
};

const revParse = ref =>
  must(
    run('git', ['-C', opts.repo, 'rev-parse', '--verify', `${ref}^{commit}`]),
    `git rev-parse ${ref}`
  ).trim();

const ensureBuild = sha => {
  const dir = path.join(opts.scratch, 'builds', sha);
  const stamp = path.join(dir, '.eq-built');
  if (fs.existsSync(stamp)) return dir;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    must(
      run('git', ['-C', opts.repo, 'worktree', 'add', '--detach', dir, sha]),
      `git worktree add ${sha}`
    );
  }
  log(`building ${sha.slice(0, 10)} (production)`);
  must(
    run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: dir,
      env: { ...toolEnv(), HUSKY: '0' },
    }),
    `pnpm install at ${sha}`
  );
  must(
    run('pnpm', ['build'], { cwd: dir, env: toolEnv() }),
    `pnpm build at ${sha}`
  );
  fs.writeFileSync(stamp, new Date().toISOString());
  return dir;
};

const hasTraceHook = buildDir =>
  fs.existsSync(path.join(buildDir, 'src', 'perfTrace.ts'));

const listFiles = dir =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry =>
          path.relative(
            dir,
            path.join(entry.parentPath ?? entry.path, entry.name)
          )
        )
        .sort()
    : [];

const treeDigest = dir => {
  const hash = crypto.createHash('sha256');
  const files = listFiles(dir);
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, file)));
    hash.update('\0');
  }
  return { files: files.length, sha256: hash.digest('hex') };
};

const mulberry32 = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const copyTree = (from, to) => {
  if (from && fs.existsSync(from))
    fs.cpSync(from, to, { recursive: true, dereference: true });
  else fs.mkdirSync(to, { recursive: true });
};

const placeTarget = targetName => {
  const target = TARGETS[targetName];
  if (target.kind === 'npm') {
    const dir = path.join(
      CFG,
      'cc',
      'node_modules',
      '@anthropic-ai',
      'claude-code'
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(target.input, path.join(dir, 'cli.js'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: '@anthropic-ai/claude-code', version: CC_VERSION })
    );
    fs.copyFileSync(target.input, path.join(CFG, 'pristine-cli.js'));
    return {
      installPath: path.join(dir, 'cli.js'),
      pristine: path.join(CFG, 'pristine-cli.js'),
    };
  }
  fs.copyFileSync(target.input, path.join(CFG, 'claude'));
  fs.chmodSync(path.join(CFG, 'claude'), 0o755);
  return {
    installPath: path.join(CFG, 'claude'),
    pristine: path.join(CFG, 'native-claudejs-orig.js'),
  };
};

const prepareCfg = (targetName, set) => {
  removeTree(CFG);
  fs.mkdirSync(CFG, { recursive: true });
  fs.copyFileSync(opts.config, path.join(CFG, 'config.json'));
  copyTree(set.prompts, path.join(CFG, 'system-prompts'));
  copyTree(set.reminders, path.join(CFG, 'system-reminders'));
  return placeTarget(targetName);
};

const measured = ({ out, name, args, env, sample, logFile, errFile }) => {
  const stdout = fs.openSync(logFile, 'w');
  const stderr = errFile ? fs.openSync(errFile, 'w') : stdout;
  const timeFile = path.join(out, `${name}.time.json`);
  const result = run(
    'flock',
    [opts.lock, 'python3', MEASURE, timeFile, process.execPath, ...args],
    {
      cwd: CFG,
      env: cleanEnv({ ...env, ...(sample ? { EQ_SAMPLE_S: '0.2' } : {}) }),
      stdio: ['ignore', stdout, stderr],
    }
  );
  fs.closeSync(stdout);
  if (errFile) fs.closeSync(stderr);
  let time = null;
  try {
    time = JSON.parse(fs.readFileSync(timeFile, 'utf8'));
  } catch {
    time = { exit: result.status, missing: true };
  }
  return time;
};

const applyArgs = (buildDir, set) => [
  path.join(buildDir, 'dist', 'index.mjs'),
  '--apply',
  ...(set.patches ? ['--patches', set.patches.join(',')] : []),
];

const applyEnv = (targetName, installPath) => ({
  TWEAKCC_ALLOW_CROSS_PLATFORM: '1',
  TWEAKCC_TARGET_PLATFORM: TARGETS[targetName].platform,
  TWEAKCC_CONFIG_DIR: CFG,
  TWEAKCC_CC_INSTALLATION_PATH: installPath,
});

const sets = {};

const ensureStubs = baselineDir => {
  const dir = path.join(opts.scratch, 'stubs', path.basename(baselineDir));
  if (fs.existsSync(path.join(dir, '.done'))) return dir;
  log('generating vanilla stubs with a baseline apply of the empty set');
  const { installPath } = prepareCfg('linux-x64', {
    prompts: null,
    reminders: null,
  });
  const out = path.join(opts.scratch, 'stubs-run');
  removeTree(out);
  fs.mkdirSync(out, { recursive: true });
  const time = measured({
    out,
    name: 'apply',
    args: applyArgs(baselineDir, {}),
    env: applyEnv('linux-x64', installPath),
    logFile: path.join(out, 'apply.log'),
  });
  if (time.exit !== 0)
    throw new Error(`stub apply failed, see ${out}/apply.log`);
  removeTree(dir);
  copyTree(path.join(CFG, 'system-prompts'), path.join(dir, 'system-prompts'));
  copyTree(
    path.join(CFG, 'system-reminders'),
    path.join(dir, 'system-reminders')
  );
  fs.writeFileSync(path.join(dir, '.done'), '');
  return dir;
};

const stubBody = file => {
  const text = fs.readFileSync(file, 'utf8');
  const at = text.indexOf('-->\n');
  return (at === -1 ? text : text.slice(at + 4)).trim();
};

const materializeSets = (needed, baselineDir) => {
  const lccPrompts = LCC_PROMPTS;
  const lccReminders = LCC_REMINDERS;
  if (!lccPrompts || !lccReminders)
    throw new Error(
      `no maintained lcc set: ${path.join(opts.tweakcc, 'system-prompts')} and system-reminders must exist`
    );
  if (needed.includes('staging') && !fs.existsSync(STAGING_PROMPTS))
    throw new Error(`no staging set at ${STAGING_PROMPTS}`);
  sets.lcc = { prompts: lccPrompts, reminders: lccReminders };
  sets.staging = {
    prompts: STAGING_PROMPTS,
    reminders: lccReminders,
  };
  sets.empty = { prompts: null, reminders: null };
  const generated = needed.filter(name =>
    ['seed1', 'seed2', 'seed3', 'edits', 'filtered'].includes(name)
  );
  if (generated.length === 0) return;
  const stubs = ensureStubs(baselineDir);
  const root = path.join(opts.scratch, 'sets', path.basename(baselineDir));
  for (const seed of [1, 2, 3]) {
    const name = `seed${seed}`;
    if (!needed.includes(name)) continue;
    const dir = path.join(root, name);
    removeTree(dir);
    const counts = {};
    for (const [sub, source] of [
      ['system-prompts', lccPrompts],
      ['system-reminders', lccReminders],
    ]) {
      copyTree(path.join(stubs, sub), path.join(dir, sub));
      const random = mulberry32(seed * 1000 + sub.length);
      const files = listFiles(source).filter(() => random() < 0.3);
      for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(dir, sub, file)), {
          recursive: true,
        });
        fs.copyFileSync(path.join(source, file), path.join(dir, sub, file));
      }
      counts[sub] = files.length;
    }
    sets[name] = {
      prompts: path.join(dir, 'system-prompts'),
      reminders: path.join(dir, 'system-reminders'),
      note: `stubs + ${counts['system-prompts']} lcc prompt files + ${counts['system-reminders']} lcc reminder files`,
    };
  }
  const promptsFile = path.join(
    baselineDir,
    'data',
    'prompts',
    `prompts-${CC_VERSION}.json`
  );
  if (needed.includes('edits')) {
    const dir = path.join(root, 'edits');
    removeTree(dir);
    const manifest = buildEditShapeSet({
      stubsDir: path.join(stubs, 'system-prompts'),
      promptsFile,
      outDir: path.join(dir, 'system-prompts'),
      pristineFile: extractPristine(
        baselineDir,
        TARGETS['linux-x64'].input,
        `linux-x64-${CC_VERSION}`
      ),
    });
    sets.edits = {
      prompts: path.join(dir, 'system-prompts'),
      reminders: null,
      manifest,
      note: Object.entries(manifest)
        .map(([key, value]) => `${key} ${value.length}`)
        .join(', '),
    };
  }
  if (needed.includes('filtered')) {
    const { prompts } = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
    const sites = new Map();
    for (const prompt of prompts)
      sites.set(prompt.id, (sites.get(prompt.id) ?? 0) + 1);
    const customized = id => {
      const lcc = path.join(lccPrompts, `${id}.md`);
      const stub = path.join(stubs, 'system-prompts', `${id}.md`);
      return (
        fs.existsSync(lcc) &&
        fs.existsSync(stub) &&
        stubBody(lcc) !== stubBody(stub)
      );
    };
    const ids = [...sites.keys()].sort();
    const multi = ids
      .filter(id => sites.get(id) >= 3 && customized(id))
      .slice(0, 1);
    const single = ids
      .filter(id => sites.get(id) === 1 && customized(id))
      .slice(0, 2);
    if (multi.length === 0)
      throw new Error('no customized multi-site prompt for the filtered case');
    sets.filtered = {
      prompts: lccPrompts,
      reminders: lccReminders,
      patches: [...multi, ...single],
      note: `--patches ${[...multi, ...single].join(',')} (${multi[0]}: ${sites.get(multi[0])} sites)`,
    };
  }
};

const watchedIds = manifest =>
  manifest
    ? new Set(
        Object.values(manifest).flatMap(entries =>
          entries.flatMap(entry =>
            typeof entry === 'string'
              ? [entry]
              : Object.values(entry).filter(value => typeof value === 'string')
          )
        )
      )
    : new Set();

const analyzeTrace = async (file, watch) => {
  const summary = {
    exists: fs.existsSync(file),
    lines: 0,
    logical: 0,
    digest: null,
    kinds: {},
    pids: 0,
    coverage: {
      clobberTrue: 0,
      clobberFalse: 0,
      pristinePath: {},
      current: { token: 0, regex: 0 },
      shadow: {},
      shadowFail: 0,
      replayPlans: 0,
      replayLanded: 0,
      preflightRan: 0,
      preflightNotRan: 0,
      preflightErrors: 0,
      ambiguous: 0,
      disambiguated: 0,
      splices: 0,
    },
    watched: {},
  };
  if (!summary.exists) return summary;
  const hash = crypto.createHash('sha256');
  const pids = new Set();
  const lines = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  const c = summary.coverage;
  const watchEntry = id =>
    (summary.watched[id] ??= {
      rows: [],
      clobber: [],
      maxMatches: 0,
      amb: false,
      dis: false,
    });
  for await (const line of lines) {
    if (!line) continue;
    summary.lines++;
    const record = JSON.parse(line);
    pids.add(record.pid);
    summary.kinds[record.k] = (summary.kinds[record.k] ?? 0) + 1;
    if (LOGICAL_KINDS.has(record.k)) {
      summary.logical++;
      const { pid: _pid, seq: _seq, ...logical } = record;
      hash.update(JSON.stringify(logical));
      hash.update('\n');
    }
    if (record.k === 'clobber') {
      if (record.verdict) c.clobberTrue++;
      else c.clobberFalse++;
      if (watch.has(record.id))
        watchEntry(record.id).clobber.push(record.verdict);
    } else if (record.k === 'pristine-path') {
      c.pristinePath[record.path] = (c.pristinePath[record.path] ?? 0) + 1;
    } else if (record.k === 'current') {
      c.current[record.by]++;
    } else if (record.k === 'shadow') {
      c.shadow[record.check] = (c.shadow[record.check] ?? 0) + 1;
    } else if (record.k === 'shadow-fail') {
      c.shadowFail++;
    } else if (record.k === 'replay') {
      c.replayPlans++;
      if (record.landed) c.replayLanded++;
    } else if (record.k === 'preflight') {
      if (record.ran) c.preflightRan++;
      else c.preflightNotRan++;
    } else if (record.k === 'preflight-error') {
      c.preflightErrors++;
    } else if (record.k === 'prompt') {
      if (record.amb) c.ambiguous++;
      if (record.dis) c.disambiguated++;
      if (watch.has(record.id)) {
        const entry = watchEntry(record.id);
        entry.maxMatches = Math.max(entry.maxMatches, record.matches.length);
        entry.amb ||= record.amb;
        entry.dis ||= record.dis;
      }
    } else if (record.k === 'splice') {
      c.splices++;
    } else if (record.k === 'row' && watch.has(record.row.id)) {
      watchEntry(record.row.id).rows.push(
        record.row.details ?? (record.row.applied ? 'applied' : '')
      );
    }
  }
  summary.pids = pids.size;
  summary.digest = hash.digest('hex');
  return summary;
};

const firstLogicalDivergence = async (a, b) => {
  const logical = async file => {
    const out = [];
    const lines = readline.createInterface({
      input: fs.createReadStream(file),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (!LOGICAL_KINDS.has(record.k)) continue;
      const { pid: _pid, seq: _seq, ...rest } = record;
      out.push(JSON.stringify(rest));
    }
    return out;
  };
  const [left, right] = await Promise.all([logical(a), logical(b)]);
  const limit = Math.max(left.length, right.length);
  for (let i = 0; i < limit; i++) {
    if (left[i] !== right[i])
      return {
        index: i,
        baseline: (left[i] ?? '<end>').slice(0, 600),
        candidate: (right[i] ?? '<end>').slice(0, 600),
      };
  }
  return null;
};

const collectOutputs = (targetName, installPath, out) => {
  const target = TARGETS[targetName];
  const moved = {};
  const move = (from, name) => {
    if (!fs.existsSync(from)) return;
    fs.renameSync(from, path.join(out, name));
    moved[name] = fs.statSync(path.join(out, name)).size;
  };
  if (target.kind === 'npm') move(installPath, 'cli.js');
  else {
    move(installPath, 'claude');
    move(
      path.join(CFG, 'native-claudejs-patched.js'),
      'native-claudejs-patched.js'
    );
  }
  move(
    path.join(CFG, 'systemPromptAppliedHashes.json'),
    'systemPromptAppliedHashes.json'
  );
  fs.writeFileSync(
    path.join(out, 'config-writes.json'),
    JSON.stringify({
      'system-prompts': treeDigest(path.join(CFG, 'system-prompts')),
      'system-reminders': treeDigest(path.join(CFG, 'system-reminders')),
    })
  );
  return moved;
};

const OUTPUT_FILES = [
  'claude',
  'cli.js',
  'native-claudejs-patched.js',
  'systemPromptAppliedHashes.json',
];

const runSide = ({
  side,
  buildDir,
  targetName,
  set,
  caseDir,
  trace,
  shadow,
}) => {
  const out = path.join(caseDir, side);
  fs.mkdirSync(out, { recursive: true });
  const { installPath, pristine } = prepareCfg(targetName, set);
  const traceFile = path.join(out, 'trace.jsonl');
  removeFile(traceFile);
  const time = measured({
    out,
    name: 'apply',
    args: applyArgs(buildDir, set),
    env: {
      ...applyEnv(targetName, installPath),
      ...(trace ? { TWEAKCC_PERF_TRACE: traceFile } : {}),
      ...(shadow ? { TWEAKCC_PERF_SHADOW: '1' } : {}),
    },
    logFile: path.join(out, 'apply.log'),
  });
  const validate = fs.existsSync(pristine)
    ? measured({
        out,
        name: 'validate',
        args: [
          path.join(buildDir, 'dist', 'index.mjs'),
          '--validate-system-prompts',
          pristine,
        ],
        env: { TWEAKCC_CONFIG_DIR: CFG },
        logFile: path.join(out, 'validate.out'),
        errFile: path.join(out, 'validate.err'),
      })
    : { exit: null, missing: `no pristine bundle at ${pristine}` };
  const outputs = collectOutputs(targetName, installPath, out);
  return { time, validate, outputs, traceFile: trace ? traceFile : null };
};

const cmpFiles = (a, b) => run('cmp', ['-s', a, b]).status === 0;

const compareCase = async ({
  caseName,
  targetName,
  caseDir,
  base,
  cand,
  watch,
}) => {
  const macho = targetName === 'darwin-macho';
  const report = { case: caseName, differences: [], files: {}, notes: [] };
  for (const name of OUTPUT_FILES) {
    const a = path.join(caseDir, 'baseline', name);
    const b = path.join(caseDir, 'candidate', name);
    const has = [fs.existsSync(a), fs.existsSync(b)];
    if (!has[0] && !has[1]) continue;
    if (has[0] !== has[1]) {
      report.differences.push(`${name}: present on one side only`);
      continue;
    }
    const same = cmpFiles(a, b);
    report.files[name] = same
      ? `identical (${fs.statSync(a).size} B)`
      : 'DIFFERENT';
    if (!same) report.differences.push(`${name} differs`);
  }
  const writes = side =>
    fs.readFileSync(path.join(caseDir, side, 'config-writes.json'), 'utf8');
  if (writes('baseline') !== writes('candidate'))
    report.differences.push(
      'config-dir writes (system-prompts / system-reminders) differ'
    );
  if (base.time.exit !== cand.time.exit)
    report.differences.push(
      `apply exit ${base.time.exit} vs ${cand.time.exit}`
    );
  report.applyExit = cand.time.exit;
  for (const side of ['baseline', 'candidate']) {
    const found = fs
      .readFileSync(path.join(caseDir, side, 'apply.log'), 'utf8')
      .split('\n')
      .filter(line => /^Found Claude Code/.test(line));
    const outside = found.filter(line => !line.includes(`${CFG}${path.sep}`));
    if (found.length === 0 || outside.length > 0)
      report.differences.push(
        `${side} apply did not stay in the sandbox installation: ${found.join(' | ') || 'no "Found Claude Code" line'}`
      );
  }
  const normalized = side => {
    const text = normalizeLog(
      fs.readFileSync(path.join(caseDir, side, 'apply.log'), 'utf8'),
      macho
    );
    fs.writeFileSync(path.join(caseDir, side, 'apply.norm.log'), text);
    return text;
  };
  if (normalized('baseline') !== normalized('candidate')) {
    const diff = run('diff', [
      path.join(caseDir, 'baseline', 'apply.norm.log'),
      path.join(caseDir, 'candidate', 'apply.norm.log'),
    ]).stdout;
    report.differences.push(
      `apply.log differs after normalization:\n${diff.split('\n').slice(0, 20).join('\n')}`
    );
  }
  report.applyLogLines = normalized('candidate').split('\n').length;
  const validateOf = side => ({
    out: normalizeLog(
      fs.readFileSync(path.join(caseDir, side, 'validate.out'), 'utf8'),
      macho
    ),
    err: normalizeLog(
      fs.readFileSync(path.join(caseDir, side, 'validate.err'), 'utf8'),
      macho
    ),
  });
  if (base.validate.missing || cand.validate.missing) {
    report.differences.push(
      `validate did not run: ${base.validate.missing ?? cand.validate.missing}`
    );
  } else {
    const [vb, vc] = [validateOf('baseline'), validateOf('candidate')];
    if (base.validate.exit !== cand.validate.exit)
      report.differences.push(
        `validate exit ${base.validate.exit} vs ${cand.validate.exit}`
      );
    if (vb.out !== vc.out) report.differences.push('validate stdout differs');
    if (vb.err !== vc.err) report.differences.push('validate stderr differs');
    const findings = /(\d+) finding\(s\)/.exec(vc.out);
    report.validate = `exit ${cand.validate.exit}, ${findings ? `${findings[1]} finding(s)` : /0 findings/.test(vc.out) ? '0 findings' : 'no findings line'}`;
  }
  const [tb, tc] = await Promise.all([
    base.traceFile ? analyzeTrace(base.traceFile, watch) : null,
    cand.traceFile ? analyzeTrace(cand.traceFile, watch) : null,
  ]);
  report.trace = { baseline: tb, candidate: tc };
  if (tb?.exists && tc?.exists && tb.lines > 0 && tc.lines > 0) {
    if (tb.digest === tc.digest && tb.logical === tc.logical) {
      report.traceComparison = `identical (${tc.logical} logical records)`;
    } else {
      const first = await firstLogicalDivergence(
        base.traceFile,
        cand.traceFile
      );
      report.traceComparison = 'DIFFERENT';
      report.differences.push(
        `logical trace differs at record ${first?.index}:\n  baseline:  ${first?.baseline}\n  candidate: ${first?.candidate}`
      );
    }
  } else if (tc?.exists && tc.lines > 0) {
    report.traceComparison = 'n/a (baseline has no trace hook)';
  } else if (cand.traceFile) {
    report.traceComparison = 'n/a (candidate wrote no trace)';
  } else {
    report.traceComparison = 'untraced';
  }
  report.wall = { baseline: base.time.wall_s, candidate: cand.time.wall_s };
  report.maxrss = {
    baseline: base.time.maxrss_mb,
    candidate: cand.time.maxrss_mb,
  };
  report.identical = report.differences.length === 0;
  return report;
};

const cleanCase = (caseDir, identical) => {
  if (opts.keep || !identical) return;
  for (const side of ['baseline', 'candidate'])
    for (const name of [...OUTPUT_FILES, 'trace.jsonl'])
      removeFile(path.join(caseDir, side, name));
};

const defaultCases = () => {
  if (opts.cases) return opts.cases;
  if (opts.profile === 'quick')
    return [
      'linux-x64:lcc',
      'linux-x64:empty',
      'linux-x64:seed1',
      'linux-x64:edits',
      'linux-x64:filtered',
      'darwin-npm:lcc',
    ];
  if (opts.profile !== 'full')
    throw new Error(`unknown profile ${opts.profile}`);
  return Object.keys(TARGETS).flatMap(target =>
    SET_NAMES.map(set => `${target}:${set}`)
  );
};

const shadowSet = cases => {
  if (opts.shadowCases === 'all') return new Set(cases);
  if (opts.shadowCases === 'none') return new Set();
  if (opts.shadowCases) return new Set(opts.shadowCases.split(','));
  return new Set([
    'linux-x64:lcc',
    'darwin-macho:lcc',
    'darwin-npm:lcc',
    'linux-x64:edits',
  ]);
};

const parseCase = name => {
  const [target, set] = name.split(':');
  if (!TARGETS[target]) throw new Error(`unknown target in ${name}`);
  if (!SET_NAMES.includes(set)) throw new Error(`unknown set in ${name}`);
  return { target, set };
};

const median = values => {
  const sorted = values
    .filter(v => typeof v === 'number')
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const addCoverage = (total, trace) => {
  if (!trace?.exists) return;
  const c = trace.coverage;
  for (const key of [
    'clobberTrue',
    'clobberFalse',
    'shadowFail',
    'replayPlans',
    'replayLanded',
    'preflightRan',
    'preflightNotRan',
    'preflightErrors',
    'ambiguous',
    'disambiguated',
    'splices',
  ])
    total[key] = (total[key] ?? 0) + c[key];
  for (const group of ['pristinePath', 'current', 'shadow']) {
    total[group] ??= {};
    for (const [key, value] of Object.entries(c[group]))
      total[group][key] = (total[group][key] ?? 0) + value;
  }
};

const editsCoverage = (manifest, watched) => {
  if (!manifest || !watched) return null;
  const rowsOf = id => watched[id]?.rows ?? [];
  const result = {
    malformed: manifest.malformed.filter(id =>
      rowsOf(id).some(d => /malformed/.test(d))
    ),
    unresolved: manifest.unresolved.filter(id =>
      rowsOf(id).some(d => /unresolved placeholder/.test(d))
    ),
    boundary: manifest.boundary
      .filter(
        ({ q }) =>
          (watched[q]?.maxMatches ?? 0) >= 2 ||
          watched[q]?.amb ||
          watched[q]?.dis
      )
      .map(({ p, q }) => `${p}->${q}`),
    overlap: manifest.overlap
      .filter(({ b, pristineCount, enclosed }) => {
        const entry = watched[b];
        if (!entry) return false;
        if (entry.clobber.includes(true)) return true;
        return (
          entry.maxMatches > 0 && entry.maxMatches <= pristineCount - enclosed
        );
      })
      .map(({ a, b }) => `${a}>${b}`),
    noop: manifest.noop.filter(id => rowsOf(id).some(d => d === 'unchanged')),
  };
  return result;
};

const stageCorrectness = async (summary, baseDir, candDir) => {
  const cases = defaultCases().map(parseCase);
  const shadow = shadowSet(cases.map(c => `${c.target}:${c.set}`));
  const traceBase = opts.trace === 'both' && hasTraceHook(baseDir);
  const traceCand = opts.trace !== 'none' && hasTraceHook(candDir);
  materializeSets([...new Set(cases.map(c => c.set))], baseDir);
  summary.sets = Object.fromEntries(
    Object.entries(sets).map(([name, set]) => [
      name,
      set.note ?? set.prompts ?? 'empty',
    ])
  );
  summary.cases = [];
  const coverage = {};
  let editsResult = null;
  for (const [n, { target, set }] of cases.entries()) {
    const caseName = `${target}:${set}`;
    const caseDir = path.join(OUT, 'cases', caseName.replace(':', '__'));
    fs.mkdirSync(caseDir, { recursive: true });
    const useShadow = shadow.has(caseName) && traceCand;
    log(
      `case ${n + 1}/${cases.length} ${caseName}${useShadow ? ' (shadow)' : ''}`
    );
    const base = runSide({
      side: 'baseline',
      buildDir: baseDir,
      targetName: target,
      set: sets[set],
      caseDir,
      trace: traceBase,
      shadow: false,
    });
    const cand = runSide({
      side: 'candidate',
      buildDir: candDir,
      targetName: target,
      set: sets[set],
      caseDir,
      trace: traceCand,
      shadow: useShadow,
    });
    const watch = set === 'edits' ? watchedIds(sets.edits.manifest) : new Set();
    const report = await compareCase({
      caseName,
      targetName: target,
      caseDir,
      base,
      cand,
      watch,
    });
    report.shadow = useShadow;
    addCoverage(coverage, report.trace.candidate);
    if (set === 'edits' && target === 'linux-x64')
      editsResult = editsCoverage(
        sets.edits.manifest,
        report.trace.candidate?.watched
      );
    log(
      `  ${report.identical ? 'IDENTICAL' : 'DIFFERENT'} apply ${base.time.wall_s}s/${cand.time.wall_s}s, validate ${report.validate}, trace ${report.traceComparison}`
    );
    for (const difference of report.differences) log(`  ${difference}`);
    if (report.trace.candidate) delete report.trace.candidate.watched;
    if (report.trace.baseline) delete report.trace.baseline.watched;
    summary.cases.push(report);
    cleanCase(caseDir, report.identical);
  }
  summary.traceHook = {
    baseline: hasTraceHook(baseDir),
    candidate: hasTraceHook(candDir),
  };
  summary.coverage = coverage;
  summary.editsCoverage = editsResult;
  const failures = [];
  if (traceCand) {
    const need = (ok, what) => {
      if (!ok) failures.push(what);
    };
    need(coverage.clobberTrue > 0, 'U1: no clobber check answered true');
    need(coverage.clobberFalse > 0, 'U1: no clobber check answered false');
    need(
      (coverage.pristinePath?.rescan ?? 0) > 0,
      'U1: no clobber check answered by a direct rescan'
    );
    need(
      (coverage.pristinePath?.index ?? 0) > 0,
      'U1: no clobber check answered by the pristine index'
    );
    need(
      (coverage.pristinePath?.['regex-fallback'] ?? 0) > 0,
      'U1: no clobber check answered by the regex fallback'
    );
    if (cases.some(c => shadow.has(`${c.target}:${c.set}`)))
      need(
        (coverage.shadow?.['u1-clobber'] ?? 0) > 0,
        'U1: the old-vs-new clobber shadow never ran'
      );
    need((coverage.shadowFail ?? 0) === 0, 'a shadow comparison failed');
    need(
      (coverage.preflightRan ?? 0) > 0,
      'preflight tail: no apply completed its preflight'
    );
    need(
      (coverage.replayLanded ?? 0) > 0,
      'preflight tail: no replay plan landed'
    );
    if (editsResult) {
      for (const [shape, hits] of Object.entries(editsResult))
        need(hits.length > 0, `edits: no ${shape} edit took its intended path`);
    }
  }
  summary.correctnessFailures = failures;
  return summary.cases.every(c => c.identical) && failures.length === 0;
};

const extractPristine = (buildDir, input, name) => {
  const file = path.join(opts.scratch, 'pristine', `${name}.js`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lib = path.join(buildDir, 'dist', 'lib', 'index.mjs');
  must(
    run('flock', [
      opts.lock,
      process.execPath,
      '--input-type=module',
      '-e',
      `
      import fs from 'node:fs';
      const lib = await import(${JSON.stringify(lib)});
      const { content } = await lib.readContent({ kind: 'native', path: ${JSON.stringify(input)}, version: '0.0.0' });
      fs.writeFileSync(${JSON.stringify(file)}, content);
    `,
    ]),
    `extract ${name}`
  );
  return file;
};

const stageCoverage = (summary, candDir) => {
  const result = { fixtures: null, corpus: null, failures: [] };
  const fixtureFiles = [
    'src/anchorIndexFixtures.test.ts',
    'src/matcherDifferential.test.ts',
  ].filter(file => fs.existsSync(path.join(candDir, file)));
  if (fixtureFiles.length === 0) {
    result.fixtures = 'n/a (candidate has no fixture tests)';
    result.failures.push('U5: candidate carries no anchor-index fixture test');
  } else {
    const started = Date.now();
    const fixture = run('npx', ['vitest', 'run', ...fixtureFiles], {
      cwd: candDir,
      env: toolEnv(),
    });
    fs.writeFileSync(
      path.join(OUT, 'fixtures.log'),
      `${fixture.stdout}\n${fixture.stderr}`
    );
    result.fixtures = {
      files: fixtureFiles,
      exit: fixture.status,
      secs: (Date.now() - started) / 1000,
    };
    if (fixture.status !== 0)
      result.failures.push(
        `U5 fixtures failed (exit ${fixture.status}), see fixtures.log`
      );
  }
  const runner = path.join(candDir, 'tools', 'lib', 'matcherDifferential.mjs');
  const promptsFile = path.join(
    candDir,
    'data',
    'prompts',
    `prompts-${CC_VERSION}.json`
  );
  const linux = extractPristine(
    candDir,
    TARGETS['linux-x64'].input,
    `linux-x64-${CC_VERSION}`
  );
  const bundles = [linux, TARGETS['darwin-npm'].input];
  const reportFile = path.join(OUT, 'corpus.json');
  const started = Date.now();
  const corpus = run(
    'flock',
    [
      opts.lock,
      process.execPath,
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs';
    const { runMatcherDifferential } = await import(${JSON.stringify(runner)});
    const lines = [];
    const result = await runMatcherDifferential({
      promptsFile: ${JSON.stringify(promptsFile)},
      bundles: ${JSON.stringify(bundles)},
      synthetic: true,
      cache: ${opts.corpusCache},
      log: line => lines.push(line),
    });
    fs.writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({
      ok: result.ok,
      lines: lines.filter(line => !/checked, \\d+ mismatch/.test(line) || /PASS|FAIL/.test(line)),
      targets: result.targets.map(({ mismatches, errors, ...rest }) => ({ ...rest, mismatches: mismatches.length, errors: errors.length })),
    }, null, 2));
    process.exit(result.ok ? 0 : 1);
  `,
    ],
    { cwd: candDir, env: toolEnv() }
  );
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch {
    report = null;
  }
  result.corpus = {
    exit: corpus.status,
    secs: (Date.now() - started) / 1000,
    report,
  };
  if (corpus.status !== 0)
    result.failures.push(
      `matcher corpus failed (exit ${corpus.status}): ${String(corpus.stderr).slice(-1500)}`
    );
  for (const target of report?.targets ?? []) {
    if (target.kind !== 'bundle') continue;
    if (!target.tokenKinds) {
      result.failures.push(
        `U7: ${target.label}: the candidate's corpus reports no per-kind token counts`
      );
      continue;
    }
    for (const [kind, present] of Object.entries(target.tokenKindsPresent))
      if (present > 0 && target.tokenKinds[kind] === 0)
        result.failures.push(
          `U7: ${target.label}: no matched prompt answered by tokens has a ${kind} token`
        );
  }
  summary.coverageStage = result;
  return result.failures.length === 0;
};

const stageRepack = (summary, baseDir, candDir) => {
  const results = [];
  const dir = path.join(opts.scratch, 'repack');
  fs.mkdirSync(dir, { recursive: true });
  for (const input of REPACK_INPUTS) {
    if (!fs.existsSync(input.file)) {
      results.push({ input: input.name, skipped: `missing ${input.file}` });
      log(`repack ${input.name}: skipped, missing input`);
      continue;
    }
    for (const shape of input.shapes) {
      const outputs = {};
      const meta = {};
      for (const [side, buildDir] of [
        ['baseline', baseDir],
        ['candidate', candDir],
      ]) {
        const out = path.join(dir, `${side}.bin`);
        removeFile(out);
        const logFile = path.join(
          OUT,
          'repack',
          `${input.name}__${shape}__${side}.log`
        );
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const time = measured({
          out: path.dirname(logFile),
          name: `${input.name}__${shape}__${side}`,
          args: [
            REPACK,
            path.join(buildDir, 'dist', 'lib', 'index.mjs'),
            input.file,
            out,
            shape,
          ],
          env: {
            TWEAKCC_ALLOW_CROSS_PLATFORM: '1',
            TWEAKCC_TARGET_PLATFORM: input.name.startsWith('macho-')
              ? 'darwin'
              : input.name.startsWith('pe-')
                ? 'win32'
                : 'linux',
          },
          logFile,
        });
        outputs[side] = out;
        meta[side] = {
          exit: time.exit,
          wall_s: time.wall_s,
          maxrss_mb: time.maxrss_mb,
          log: normalizeLog(fs.readFileSync(logFile, 'utf8'), false)
            .trim()
            .split('\n')
            .slice(-3)
            .join(' | '),
        };
      }
      const exists =
        fs.existsSync(outputs.baseline) && fs.existsSync(outputs.candidate);
      const identical =
        meta.baseline.exit === meta.candidate.exit &&
        meta.baseline.log === meta.candidate.log &&
        (!exists || cmpFiles(outputs.baseline, outputs.candidate));
      const size = exists ? fs.statSync(outputs.candidate).size : null;
      const rewritten = exists && !cmpFiles(input.file, outputs.candidate);
      const ok =
        identical &&
        meta.baseline.exit === 0 &&
        meta.candidate.exit === 0 &&
        (shape === 'same' || rewritten);
      results.push({
        input: input.name,
        shape,
        identical,
        ok,
        inputSize: fs.statSync(input.file).size,
        rewritten,
        size,
        baseline: meta.baseline,
        candidate: meta.candidate,
      });
      log(
        `repack ${input.name} ${shape}: ${identical ? 'IDENTICAL' : 'DIFFERENT'} exit ${meta.baseline.exit}/${meta.candidate.exit}${size ? `, ${size} B` : ''}${rewritten ? '' : ', output equals input'}${ok ? '' : ' — FAIL'}`
      );
      if (identical || !opts.keep) {
        removeFile(outputs.baseline);
        removeFile(outputs.candidate);
      }
    }
  }
  summary.repack = { results, todo: REPACK_TODO };
  return results.every(r => r.skipped || r.ok);
};

const stagePerf = (summary, baseDir, candDir) => {
  const cases = opts.perfCases.map(parseCase);
  materializeSets([...new Set(cases.map(c => c.set))], baseDir);
  const results = [];
  for (const { target, set } of cases) {
    const runs = { baseline: [], candidate: [] };
    for (let r = 0; r < opts.perfRuns; r++) {
      const order =
        r % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const side of order) {
        const buildDir = side === 'baseline' ? baseDir : candDir;
        const out = path.join(
          OUT,
          'perf',
          `${target}__${set}`,
          `${side}-${r + 1}`
        );
        fs.mkdirSync(out, { recursive: true });
        const { installPath } = prepareCfg(target, sets[set]);
        const time = measured({
          out,
          name: 'apply',
          args: applyArgs(buildDir, sets[set]),
          env: applyEnv(target, installPath),
          sample: true,
          logFile: path.join(out, 'apply.log'),
        });
        runs[side].push(time);
        log(
          `perf ${target}:${set} ${side} run ${r + 1}: wall ${time.wall_s}s user ${time.user_s}s maxrss ${time.maxrss_mb} MB peak ${time.sampled_peak_mb} MB exit ${time.exit}`
        );
      }
    }
    const stats = side => ({
      wall_s: median(runs[side].map(t => t.wall_s)),
      user_s: median(runs[side].map(t => t.user_s)),
      maxrss_mb: median(runs[side].map(t => t.maxrss_mb)),
      sampled_peak_mb: median(runs[side].map(t => t.sampled_peak_mb)),
      wall_range: [
        Math.min(...runs[side].map(t => t.wall_s)),
        Math.max(...runs[side].map(t => t.wall_s)),
      ],
      maxrss_range: [
        Math.min(...runs[side].map(t => t.maxrss_mb)),
        Math.max(...runs[side].map(t => t.maxrss_mb)),
      ],
      exits: runs[side].map(t => t.exit),
    });
    const base = stats('baseline');
    const cand = stats('candidate');
    const pct = (a, b) =>
      a && b ? Number((((b - a) / a) * 100).toFixed(2)) : null;
    results.push({
      case: `${target}:${set}`,
      runs: opts.perfRuns,
      baseline: base,
      candidate: cand,
      delta_pct: {
        wall: pct(base.wall_s, cand.wall_s),
        user: pct(base.user_s, cand.user_s),
        maxrss: pct(base.maxrss_mb, cand.maxrss_mb),
        sampled_peak: pct(base.sampled_peak_mb, cand.sampled_peak_mb),
      },
    });
  }
  summary.perf = results;
  return results.every(r =>
    [...r.baseline.exits, ...r.candidate.exits].every(code => code === 0)
  );
};

const renderSummary = summary => {
  const lines = [];
  lines.push(
    `# Apply equality: ${summary.baseline.ref} (${summary.baseline.sha.slice(0, 10)}) vs ${summary.candidate.ref} (${summary.candidate.sha.slice(0, 10)})`
  );
  lines.push('');
  lines.push(
    `Result: **${summary.ok ? 'PASS' : 'FAIL'}** in ${summary.elapsed_s}s (${Object.entries(
      summary.stageSecs
    )
      .map(([s, v]) => `${s} ${v}s`)
      .join(', ')})`
  );
  lines.push(
    `Host ${summary.host}, node ${summary.node}, config ${summary.config}, lcc ${summary.lcc.prompts}`
  );
  lines.push(
    `Trace hook: baseline ${summary.traceHook?.baseline ?? '-'}, candidate ${summary.traceHook?.candidate ?? '-'}`
  );
  if (summary.sets) {
    lines.push('', '## Sets');
    for (const [name, note] of Object.entries(summary.sets))
      lines.push(`- ${name}: ${note}`);
  }
  if (summary.cases) {
    lines.push(
      '',
      '## Correctness',
      '',
      '| case | result | outputs | apply.log | validate | trace | wall b/c (s) | maxrss b/c (MB) |',
      '|---|---|---|---|---|---|---|---|'
    );
    for (const c of summary.cases) {
      lines.push(
        `| ${c.case}${c.shadow ? ' (shadow)' : ''} | ${c.identical ? 'identical' : 'DIFFERENT'} | ${Object.entries(
          c.files
        )
          .map(([f, v]) => `${f} ${v.startsWith('identical') ? '=' : '≠'}`)
          .join(
            ', '
          )} | ${c.applyLogLines} lines | ${c.validate ?? '-'} | ${c.traceComparison} | ${c.wall.baseline}/${c.wall.candidate} | ${c.maxrss.baseline}/${c.maxrss.candidate} |`
      );
    }
    for (const c of summary.cases.filter(x => !x.identical)) {
      lines.push('', `### ${c.case}`, '```', ...c.differences, '```');
    }
    lines.push(
      '',
      '## Coverage (candidate traces)',
      '```',
      JSON.stringify(summary.coverage, null, 1),
      '```'
    );
    if (summary.editsCoverage)
      lines.push(
        '',
        'Edit shapes that took their intended path (linux-x64:edits):',
        '```',
        JSON.stringify(summary.editsCoverage, null, 1),
        '```'
      );
    if (summary.correctnessFailures?.length)
      lines.push(
        '',
        'Coverage failures:',
        ...summary.correctnessFailures.map(f => `- ${f}`)
      );
  }
  if (summary.coverageStage) {
    const s = summary.coverageStage;
    lines.push('', '## Fixtures and matcher corpus');
    lines.push(
      `- fixtures: ${typeof s.fixtures === 'string' ? s.fixtures : `exit ${s.fixtures.exit} (${s.fixtures.files.join(', ')})`}`
    );
    lines.push(`- corpus: exit ${s.corpus.exit} in ${s.corpus.secs}s`);
    for (const line of s.corpus.report?.lines ?? [])
      if (/PASS|FAIL/.test(line)) lines.push(`  - ${line}`);
    if (s.failures.length)
      lines.push('', 'Failures:', ...s.failures.map(f => `- ${f}`));
  }
  if (summary.repack) {
    lines.push(
      '',
      '## Repack-only writer inputs',
      '',
      '| input | shape | result | exit b/c | input → output (B) | rewritten |',
      '|---|---|---|---|---|---|'
    );
    for (const r of summary.repack.results)
      lines.push(
        r.skipped
          ? `| ${r.input} | - | skipped: ${r.skipped} | | | |`
          : `| ${r.input} | ${r.shape} | ${r.ok ? 'identical' : r.identical ? 'FAILED on both sides' : 'DIFFERENT'} | ${r.baseline.exit}/${r.candidate.exit} | ${r.inputSize} → ${r.size ?? '-'} | ${r.rewritten ? 'yes' : 'no'} |`
      );
    lines.push('', ...summary.repack.todo.map(t => `- ${t}`));
  }
  if (summary.perf) {
    lines.push(
      '',
      '## Performance (untraced, medians)',
      '',
      '| case | runs | wall b→c (s) | user b→c (s) | maxrss b→c (MB) | sampled peak b→c (MB) | Δ wall / user / maxrss |',
      '|---|---|---|---|---|---|---|'
    );
    for (const p of summary.perf)
      lines.push(
        `| ${p.case} | ${p.runs} | ${p.baseline.wall_s} → ${p.candidate.wall_s} (ranges ${p.baseline.wall_range.join('–')} / ${p.candidate.wall_range.join('–')}) | ${p.baseline.user_s} → ${p.candidate.user_s} | ${p.baseline.maxrss_mb} → ${p.candidate.maxrss_mb} | ${p.baseline.sampled_peak_mb} → ${p.candidate.sampled_peak_mb} | ${p.delta_pct.wall}% / ${p.delta_pct.user}% / ${p.delta_pct.maxrss}% |`
      );
  }
  return lines.join('\n');
};

const main = async () => {
  acquireHarnessLock();
  fs.mkdirSync(OUT, { recursive: true });
  const started = Date.now();
  const summary = {
    run: RUN_ID,
    baseline: { ref: opts.baseline, sha: revParse(opts.baseline) },
    candidate: { ref: opts.candidate, sha: revParse(opts.candidate) },
    stages: opts.stages,
    stageSecs: {},
    host: os.hostname(),
    node: process.version,
    config: opts.config,
    lcc: { prompts: LCC_PROMPTS, reminders: LCC_REMINDERS },
  };
  log(
    `apply equality ${summary.baseline.sha.slice(0, 10)} vs ${summary.candidate.sha.slice(0, 10)} → ${OUT}`
  );
  const baseDir = ensureBuild(summary.baseline.sha);
  const candDir = ensureBuild(summary.candidate.sha);
  let ok = true;
  const stage = async (name, fn) => {
    if (!opts.stages.includes(name)) return;
    const t = Date.now();
    log(`stage ${name}`);
    const passed = await fn();
    summary.stageSecs[name] = Math.round((Date.now() - t) / 1000);
    log(
      `stage ${name}: ${passed ? 'pass' : 'FAIL'} in ${summary.stageSecs[name]}s`
    );
    ok &&= passed;
    fs.writeFileSync(
      path.join(OUT, 'summary.json'),
      JSON.stringify(summary, null, 2)
    );
  };
  await stage('correctness', () => stageCorrectness(summary, baseDir, candDir));
  await stage('coverage', () => stageCoverage(summary, candDir));
  await stage('repack', () => stageRepack(summary, baseDir, candDir));
  await stage('perf', () => stagePerf(summary, baseDir, candDir));
  removeTree(CFG);
  summary.ok = ok;
  summary.elapsed_s = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(
    path.join(OUT, 'summary.json'),
    JSON.stringify(summary, null, 2)
  );
  const rendered = renderSummary(summary);
  fs.writeFileSync(path.join(OUT, 'summary.md'), `${rendered}\n`);
  console.log(`\n${rendered}`);
  process.exit(ok ? 0 : 1);
};

main().catch(error => {
  console.error(error?.stack ?? String(error));
  process.exit(2);
});
