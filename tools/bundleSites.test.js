// Locks the on-disk site cache: what invalidates it, how it is stored, and
// that a warm run replays exactly what a cold run decides.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sites = require('./lib/bundleSites.cjs');
const ex = require('./promptExtractor.js');
const parser = require('@babel/parser');

const M = (i, src) =>
  `/*@@TWEAKCC_MODULE:${i}:/$bunfs/root/m${i}.js@@*/\n${src}`;
const SEARCH =
  'Search file contents with a regular expression and return every matching line.';
const COMPOSITE = [
  'Do not call the agent tool unless the user asked for it.',
  'Do not start workflows on your own initiative, ever, under any circumstances.',
];

// Each module exercises one ordering-sensitive path of the decision replay:
//   m0  a captured tool description and a captured tool-result template;
//   m1  a twin of each at a site the gates reject, which only the identical-site
//       backfill can fill (the template twin has renamed variables);
//   m2  a captured template with a nested template and a nested copy of the
//       description, which the backfill must NOT clone;
//   m3  a composite whose fragments are captured on the joined text's verdict;
//   m4  an unparseable module.
const BUNDLE = [
  '',
  M(
    0,
    `const a={name:"Grep",description:"${SEARCH}"};` +
      'const t={type:"text",text:`Task ${d} is not running anymore, so its output cannot be read (status: ${c.status}).`};'
  ),
  M(
    1,
    `function f(d,c){return foo("${SEARCH}")+` +
      'bar(`Task ${i} is not running anymore, so its output cannot be read (status: ${s.status}).`)}'
  ),
  M(
    2,
    'const o=`You are a careful reviewer. Read every changed file before you comment on it. ' +
      '${y?`Always cite the exact line you are commenting on, and never guess at code you did not open.`:""}' +
      ` Report only real problems. \${z?"${SEARCH}":""}\`;`
  ),
  M(3, `const c=${JSON.stringify(COMPOSITE)}.join("\\n");`),
  M(4, 'export default {{{;'),
  '',
].join('\n');

const COMPOSITE_VERDICT = () => ({
  [ex.sha1Hex(COMPOSITE.join('\n'))]: { facing: 'model' },
});

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
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const quiet = () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { log, warn };
};

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

  it('hashes every repo module the collector requires, transitively', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const seen = new Set();
    const walk = file => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = fs.readFileSync(file, 'utf8');
      for (const [, spec] of src.matchAll(
        /require\(\s*['"]([^'"]+)['"]\s*\)/g
      )) {
        if (!spec.startsWith('.')) continue;
        const resolved = require.resolve(
          path.resolve(path.dirname(file), spec)
        );
        if (resolved.startsWith(repoRoot)) walk(resolved);
      }
    };
    walk(require.resolve('./lib/bundleSites.cjs'));
    expect([...seen].sort()).toEqual(
      sites.SOURCE_FILES.map(f => path.resolve(f)).sort()
    );
    // promptExtractor.js carries NEW_PROMPT_ASSIGNMENTS and the decision
    // logic, which run after this stage; hashing it would discard the cache on
    // every curated edit.
    expect(sites.SOURCE_FILES.map(f => path.basename(f))).not.toContain(
      'promptExtractor.js'
    );
  });
});

describe('cache storage', () => {
  it('defaults to a per-user dir under XDG_CACHE_HOME or ~/.cache', () => {
    setEnv('TWEAKCC_EXTRACT_CACHE_DIR', undefined);
    setEnv('XDG_CACHE_HOME', path.join(dir, 'xdg'));
    expect(sites.cacheDir()).toBe(path.join(dir, 'xdg', 'tweakcc', 'extract'));
    setEnv('XDG_CACHE_HOME', undefined);
    expect(sites.cacheDir()).toBe(
      path.join(os.homedir(), '.cache', 'tweakcc', 'extract')
    );
  });

  it('creates the cache dir private to the user', () => {
    quiet();
    setEnv('TWEAKCC_EXTRACT_CACHE_DIR', undefined);
    setEnv('XDG_CACHE_HOME', path.join(dir, 'xdg'));
    sites.loadBundleSites(BUNDLE);
    const mode = fs.statSync(sites.cacheDir()).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('keeps the most recently used entries and sweeps stale temp files', () => {
    const cache = path.join(dir, 'prune');
    fs.mkdirSync(cache);
    const now = Date.now();
    const entry = i => path.join(cache, `sites-${String(i).repeat(64)}.v8`);
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(entry(i), '');
      const t = new Date(now - (6 - i) * 60_000);
      fs.utimesSync(entry(i), t, t);
    }
    const stale = path.join(cache, 'sites-x.v8.1.a.tmp');
    const fresh = path.join(cache, 'sites-x.v8.1.b.tmp');
    const other = path.join(cache, 'unrelated.txt');
    for (const f of [stale, fresh, other]) fs.writeFileSync(f, '');
    const old = new Date(now - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(other, old, old);

    sites.pruneCache(cache, sites.KEEP_ENTRIES, now);
    expect(fs.readdirSync(cache).sort()).toEqual(
      [2, 3, 4, 5]
        .map(i => path.basename(entry(i)))
        .concat(path.basename(fresh), 'unrelated.txt')
        .sort()
    );
  });

  it('marks an entry used on a hit, so pruning keeps it', () => {
    quiet();
    const { file } = sites.loadBundleSites(BUNDLE);
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(file, old, old);
    expect(sites.loadBundleSites(BUNDLE).cache).toBe('hit');
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(old.getTime() + 1000);
  });

  it('leaves no temp file behind', () => {
    quiet();
    sites.loadBundleSites(BUNDLE);
    const names = fs.readdirSync(sites.cacheDir());
    expect(names.filter(n => n.endsWith('.tmp'))).toEqual([]);
    expect(names).toHaveLength(1);
  });
});

describe('loadBundleSites', () => {
  it('collects on a miss, then replays the identical product on a hit', () => {
    quiet();
    const cold = sites.loadBundleSites(BUNDLE);
    expect(cold.cache).toBe('miss');
    const warm = sites.loadBundleSites(BUNDLE);
    expect(warm.cache).toBe('hit');
    expect(warm.sites).toEqual(cold.sites);
    expect(warm.settings).toEqual(cold.settings);
    expect(warm.modules).toEqual(cold.modules);
  });

  it('replays the unparseable-module warnings on a hit', () => {
    const { warn } = quiet();
    sites.loadBundleSites(BUNDLE);
    const missWarnings = warn.mock.calls.map(c => c[0]);
    expect(missWarnings.some(w => /unparseable module .*m4\.js/.test(w))).toBe(
      true
    );
    warn.mockClear();
    expect(sites.loadBundleSites(BUNDLE).cache).toBe('hit');
    expect(warn.mock.calls.map(c => c[0])).toEqual(missWarnings);
  });

  it('misses when the bundle changes', () => {
    quiet();
    sites.loadBundleSites(BUNDLE);
    expect(sites.loadBundleSites(BUNDLE.replace('Grep', 'Glob')).cache).toBe(
      'miss'
    );
  });

  it('never reads or writes the cache when disabled', () => {
    quiet();
    setEnv('TWEAKCC_EXTRACT_NO_CACHE', '1');
    expect(sites.loadBundleSites(BUNDLE).cache).toBe('off');
    expect(fs.existsSync(process.env.TWEAKCC_EXTRACT_CACHE_DIR)).toBe(false);
    setEnv('TWEAKCC_EXTRACT_NO_CACHE', undefined);
    expect(sites.loadBundleSites(BUNDLE, { useCache: false }).cache).toBe(
      'off'
    );
  });

  it('treats a corrupt entry as a miss', () => {
    quiet();
    const { file } = sites.loadBundleSites(BUNDLE);
    fs.writeFileSync(file, 'not v8');
    expect(sites.loadBundleSites(BUNDLE).cache).toBe('miss');
  });
});

describe('extractStrings with the site cache', () => {
  const run = file => {
    const { log } = quiet();
    const r = ex(file, 500, { cache: true });
    const lines = log.mock.calls.map(c => String(c[0]));
    vi.restoreAllMocks();
    return { json: JSON.stringify(r), result: r, lines };
  };

  it('decides identically cold, on a miss and on a hit', () => {
    const file = path.join(dir, 'cli.js');
    fs.writeFileSync(file, BUNDLE);
    ex._setClassificationCacheForTests(COMPOSITE_VERDICT());

    setEnv('TWEAKCC_EXTRACT_NO_CACHE', '1');
    const cold = run(file);
    setEnv('TWEAKCC_EXTRACT_NO_CACHE', undefined);
    const miss = run(file);
    const hit = run(file);

    expect(miss.lines.some(l => l.includes('site cache miss'))).toBe(true);
    expect(hit.lines.some(l => l.includes('site cache hit'))).toBe(true);
    expect(miss.json).toBe(cold.json);
    expect(hit.json).toBe(cold.json);

    // The fixture really exercises the paths it is meant to.
    const bodies = cold.result.prompts.map(p => p.pieces.join(''));
    const count = s => bodies.filter(b => b === s).length;
    expect(count(SEARCH)).toBe(2); // captured + backfilled, nested copy skipped
    expect(
      count(
        'Task ${} is not running anymore, so its output cannot be read (status: ${.status}).'
      )
    ).toBe(2);
    expect(bodies.filter(b => b.startsWith('You are a careful'))).toHaveLength(
      1
    );
    for (const frag of COMPOSITE) expect(count(frag)).toBe(1);
    expect(hit.lines.filter(l => l.startsWith('Backfilled'))).toHaveLength(2);
  });

  it('applies a changed classification verdict on a cache hit', () => {
    const file = path.join(dir, 'cli.js');
    fs.writeFileSync(file, BUNDLE);
    ex._setClassificationCacheForTests(COMPOSITE_VERDICT());
    const first = run(file).result;
    expect(first.prompts.some(p => p.pieces[0] === COMPOSITE[0])).toBe(true);

    ex._setClassificationCacheForTests({
      [ex.sha1Hex(COMPOSITE.join('\n'))]: { facing: 'ui' },
    });
    const second = run(file);
    expect(second.lines.some(l => l.includes('site cache hit'))).toBe(true);
    expect(second.result.prompts.some(p => p.pieces[0] === COMPOSITE[0])).toBe(
      false
    );
  });
});

describe('templateShape', () => {
  it('labels a slot named __proto__ like any other identifier', () => {
    // Deliberate: the old object-keyed labelling emitted [{}] / {} here.
    const src = 'x=`a ${__proto__} b ${__proto__} c ${q}`';
    const ast = parser.parse(src);
    const node = ast.program.body[0].expression.right;
    const shape = sites.templateShape(node, src);
    expect(shape.identifiers).toEqual([0, 0, 1]);
    expect(shape.labels).toBe(2);
  });
});

// A verbatim copy of the scan nestedRangeIndex replaced (origin/main
// tools/promptExtractor.js, backfillIdenticalSites).
const oldIsNested = capturedRanges => node =>
  capturedRanges.some(
    ([start, end]) =>
      node.start >= start &&
      node.end <= end &&
      !(node.start === start && node.end === end)
  );

describe('nestedRangeIndex', () => {
  it('matches the linear scan on random ranges', () => {
    let seed = 12345;
    const rand = n => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const R = 12;
    const mismatches = [];
    for (let t = 0; t < 5000; t++) {
      const ranges = [];
      const n = rand(9);
      for (let i = 0; i < n; i++) {
        const a = rand(R);
        // zero-length, inverted (b < a), equal and duplicate ranges all occur
        const b = a + rand(7) - 2;
        ranges.push([a, b]);
        if (rand(5) === 0) ranges.push([a, b]);
      }
      const fast = ex.nestedRangeIndex(ranges);
      const slow = oldIsNested(ranges);
      for (let s = -1; s < R + 2; s++) {
        for (let e = s - 2; e < R + 8; e++) {
          if (fast(s, e) !== slow({ start: s, end: e }))
            mismatches.push([ranges, s, e]);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('matches the linear scan on non-numeric and NaN bounds', () => {
    const cases = [
      [
        [0, undefined],
        [1, 10],
      ],
      [
        [0, null],
        [2, '7'],
      ],
      [
        [1, '5'],
        [1, 5],
      ],
      [
        [NaN, 10],
        [3, NaN],
      ],
      [[1, 10n]],
    ];
    for (const ranges of cases) {
      const fast = ex.nestedRangeIndex(ranges);
      const slow = oldIsNested(ranges);
      for (let s = -1; s < 12; s++) {
        for (let e = s - 2; e < 14; e++) {
          expect([ranges, s, e, fast(s, e)]).toEqual([
            ranges,
            s,
            e,
            slow({ start: s, end: e }),
          ]);
        }
      }
    }
  });
});
