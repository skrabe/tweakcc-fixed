// Locks the on-disk site cache: what invalidates it, and that a warm run
// replays exactly what a cold run decides.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sites = require('./lib/bundleSites.cjs');
const ex = require('./promptExtractor.js');

const BUNDLE = [
  '',
  '/*@@TWEAKCC_MODULE:0:/$bunfs/root/a.js@@*/',
  'const a={name:"Grep",description:"Search file contents with a regular expression and return every matching line."};',
  '/*@@TWEAKCC_MODULE:1:/$bunfs/root/b.js@@*/',
  'const b=`Task ${d} is not running anymore, so its output cannot be read (status: ${c.status}).`;',
  'const c=["Do not call the agent tool unless the user asked for it.","Do not start workflows on your own initiative."].join("\\n");',
  '',
].join('\n');

let dir;
const env = {};
const setEnv = (k, v) => {
  if (!(k in env)) env[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-sites-'));
  setEnv('TWEAKCC_EXTRACT_CACHE_DIR', path.join(dir, 'cache'));
  setEnv('TWEAKCC_EXTRACT_NO_CACHE', undefined);
});

afterEach(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete env[k];
  }
  ex._setClassificationCacheForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('bundleCacheKey', () => {
  const base = {
    code: BUNDLE,
    source: 'src',
    options: sites.defaultOptions(),
  };

  it('is stable for the same inputs', () => {
    expect(sites.bundleCacheKey(base)).toBe(sites.bundleCacheKey({ ...base }));
  });

  it('changes when the bundle changes', () => {
    expect(sites.bundleCacheKey({ ...base, code: BUNDLE + ' ' })).not.toBe(
      sites.bundleCacheKey(base)
    );
  });

  it('changes when the collecting source changes', () => {
    expect(sites.bundleCacheKey({ ...base, source: 'src2' })).not.toBe(
      sites.bundleCacheKey(base)
    );
  });

  it('changes when a stage option changes', () => {
    const options = {
      ...base.options,
      parse: { ...base.options.parse, plugins: ['jsx'] },
    };
    expect(sites.bundleCacheKey({ ...base, options })).not.toBe(
      sites.bundleCacheKey(base)
    );
    expect(
      sites.bundleCacheKey({
        ...base,
        options: { ...base.options, parser: '0.0.0' },
      })
    ).not.toBe(sites.bundleCacheKey(base));
  });

  it('hashes the content of every collecting source file', () => {
    const a = path.join(dir, 'a.cjs');
    fs.writeFileSync(a, 'one');
    const before = sites.sourceHash([a]);
    fs.writeFileSync(a, 'two');
    expect(sites.sourceHash([a])).not.toBe(before);
  });

  it('covers the real collecting sources, not the curated tables', () => {
    // promptExtractor.js carries NEW_PROMPT_ASSIGNMENTS and the decision
    // logic, which are applied after this stage; hashing it would discard the
    // cache on every curated edit.
    expect(sites.SOURCE_FILES.map(f => path.basename(f)).sort()).toEqual([
      'bundleSites.cjs',
      'moduleBundle.cjs',
      'settingsSchema.cjs',
    ]);
  });
});

describe('loadBundleSites', () => {
  it('collects on a miss, then replays the identical product on a hit', () => {
    const cold = sites.loadBundleSites(BUNDLE);
    expect(cold.cache).toBe('miss');
    const warm = sites.loadBundleSites(BUNDLE);
    expect(warm.cache).toBe('hit');
    expect(warm.sites).toEqual(cold.sites);
    expect(warm.settings).toEqual(cold.settings);
    expect(warm.modules).toEqual(cold.modules);
  });

  it('misses when the bundle changes', () => {
    sites.loadBundleSites(BUNDLE);
    expect(sites.loadBundleSites(BUNDLE.replace('Grep', 'Glob')).cache).toBe(
      'miss'
    );
  });

  it('never reads or writes the cache when disabled', () => {
    setEnv('TWEAKCC_EXTRACT_NO_CACHE', '1');
    expect(sites.loadBundleSites(BUNDLE).cache).toBe('off');
    expect(fs.existsSync(process.env.TWEAKCC_EXTRACT_CACHE_DIR)).toBe(false);
    setEnv('TWEAKCC_EXTRACT_NO_CACHE', undefined);
    expect(sites.loadBundleSites(BUNDLE, { useCache: false }).cache).toBe(
      'off'
    );
  });

  it('treats a corrupt entry as a miss', () => {
    const { file } = sites.loadBundleSites(BUNDLE);
    fs.writeFileSync(file, 'not v8');
    expect(sites.loadBundleSites(BUNDLE).cache).toBe('miss');
  });
});

describe('extractStrings with the site cache', () => {
  const run = file => {
    const r = ex(file, 500, { cache: true });
    return JSON.stringify(r);
  };

  it('decides identically cold and warm', () => {
    const file = path.join(dir, 'cli.js');
    fs.writeFileSync(file, BUNDLE);
    setEnv('TWEAKCC_EXTRACT_NO_CACHE', '1');
    const cold = run(file);
    setEnv('TWEAKCC_EXTRACT_NO_CACHE', undefined);
    const miss = run(file);
    const hit = run(file);
    expect(miss).toBe(cold);
    expect(hit).toBe(cold);
  });

  it('applies a changed classification verdict on a cache hit', () => {
    const file = path.join(dir, 'cli.js');
    fs.writeFileSync(file, BUNDLE);
    const body =
      'Search file contents with a regular expression and return every matching line.';
    const key = ex.sha1Hex(body);
    ex._setClassificationCacheForTests({ [key]: { facing: 'model' } });
    const first = ex(file, 500, { cache: true });
    expect(first.prompts.some(p => p.pieces[0] === body)).toBe(true);

    ex._setClassificationCacheForTests({ [key]: { facing: 'ui' } });
    expect(sites.loadBundleSites(BUNDLE).cache).toBe('hit');
    const second = ex(file, 500, { cache: true });
    expect(second.prompts.some(p => p.pieces[0] === body)).toBe(false);
  });
});
