// probeCacheKey must report the keys the extractor itself hashes and looks up,
// never a re-derived approximation of them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { probe, formatLine, parseArgs, DEFAULT_CACHE } from './probeCacheKey.mjs';

const require = createRequire(import.meta.url);
const ex = require('./promptExtractor.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'probeCacheKey.mjs');
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

// A real verdict from data/prompt-classification.json, embedded verbatim.
const KNOWN_KEY = '0014880085a57eb361aea48897bcceb0209c4401';
const KNOWN_BODY = "`type_url` is not an Artifact URL Claude can create from. Use the Artifact type's claude.ai URL.";

const FIXTURE = [
  `var known=${JSON.stringify(KNOWN_BODY)};`,
  'function f(x){return `Saved ${x.items.stringify()} entries to ${x.path} for the reviewer to read later.`}',
  'var meta={VERSION:"9.9.9",BUILD_TIME:"2026-01-02T03:04:05Z"};',
  'var stamp=`Claude Code 9.9.9 (BUILD_TIME:"2026-01-02T03:04:05Z") is ready for ${z}`;',
  'var joined=["First fragment of a joined instruction list.","Second fragment of a joined instruction list."].join("\\n");',
  'var idx=`Item ${y[Ye]} is ignored by the policy helper in this build`;',
].join('\n');

let dir;
let cli;
const quiet = fn => {
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, { log, warn });
  }
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cache-key-'));
  cli = path.join(dir, 'cli-9.9.9.js');
  fs.writeFileSync(cli, FIXTURE);
});
afterAll(() => {
  ex._setClassificationCacheForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('probeCacheKey', () => {
  it('reports the body and raw key the extractor hashes for every literal', () => {
    const truth = quiet(() => ex.collectLiteralSites(cli));
    expect(truth.length).toBeGreaterThan(5);
    for (const rec of truth) {
      const { matches } = probe(cli, { offset: String(rec.start) });
      const m = matches.find(d => d.start === rec.start && d.end === rec.end && d.cacheBody === rec.cacheBody);
      expect(m, `${rec.start}-${rec.end}`).toBeTruthy();
      expect(m.keys[0]).toMatchObject({ variant: 'raw', key: sha1(rec.cacheBody) });
    }
  }, 60000);

  it('keeps the member access of a template slot and drops only the identifier', () => {
    const { matches } = probe(cli, { text: 'for the reviewer to read later' });
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe('template');
    expect(matches[0].cacheBody).toBe('Saved ${.items.stringify()} entries to ${.path} for the reviewer to read later.');
  });

  it('every variant it reports is one classifyByCache binds under', () => {
    const { version, matches } = probe(cli, { text: 'is ready for' });
    expect(version).toBe('9.9.9');
    const [d] = matches;
    const variants = d.keys.map(k => k.variant);
    expect(variants).toEqual(expect.arrayContaining(['raw', 'ccversion', 'build-time', 'ccversion+build-time']));
    // The bracket index is a promoted slot, so the current body is already the
    // index-free form; the pre-promotion body still binds as `legacy`.
    const idx = probe(cli, { text: 'policy helper' }).matches[0];
    expect(idx.keys.map(k => k.variant)).toEqual(['raw', 'legacy']);
    expect(idx.keys[0].key).toBe(sha1('Item ${[]} is ignored by the policy helper in this build'));
    const legacyIdx = 'Item ${[Ye]} is ignored by the policy helper in this build';
    expect(idx.keys[1].key).toBe(sha1(legacyIdx));
    for (const [m, legacy] of [[d], [idx, legacyIdx]]) {
      for (const k of m.keys) {
        ex._setClassificationCacheForTests({ [k.key]: { facing: k.variant } });
        expect(ex.classifyByCache(m.cacheBody, legacy), k.variant).toEqual({ facing: k.variant });
      }
    }
    ex._setClassificationCacheForTests(null);
  });

  it('reports a composite and labels its elements as fragments', () => {
    const { matches } = probe(cli, { text: 'joined instruction list' });
    const comp = matches.find(d => d.kind === 'composite');
    expect(comp.cacheBody).toBe('First fragment of a joined instruction list.\nSecond fragment of a joined instruction list.');
    expect(comp.keys[0].key).toBe(sha1(comp.cacheBody));
    const frags = matches.filter(d => d.kind === 'fragment');
    expect(frags).toHaveLength(2);
    expect(frags.every(f => f.of[0] === comp.start && f.of[1] === comp.end)).toBe(true);
  });

  it('finds a real cache key and its recorded verdict', () => {
    const cache = JSON.parse(fs.readFileSync(DEFAULT_CACHE, 'utf8'));
    expect(cache[KNOWN_KEY]?.id).toBe('tool-result-artifact-type-url-unparseable');
    const { matches } = probe(cli, { hash: KNOWN_KEY });
    expect(matches).toHaveLength(1);
    expect(matches[0].verdict).toEqual({ facing: 'model', id: 'tool-result-artifact-type-url-unparseable' });
    expect(formatLine(matches[0])).toMatch(
      new RegExp(`^\\d+-\\d+ string model/tool-result-artifact-type-url-unparseable raw=${KNOWN_KEY}\\* "\`type_url\``)
    );
  });

  it('rejects bad usage', () => {
    expect(() => parseArgs([cli])).toThrow(/exactly one of/);
    expect(() => parseArgs([cli, '--offset', '1', '--hash', KNOWN_KEY])).toThrow(/exactly one of/);
    expect(() => parseArgs([cli, '--hash', 'abc'])).toThrow(/40 lowercase hex/);
  });

  it('exits 0 on a match, 1 on none, 2 on usage error', () => {
    const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
    const hit = run(cli, '--hash', KNOWN_KEY, '--json');
    expect(hit.status).toBe(0);
    expect(JSON.parse(hit.stdout)[0].verdict.id).toBe('tool-result-artifact-type-url-unparseable');
    expect(run(cli, '--text', 'no literal carries this').status).toBe(1);
    expect(run(cli).status).toBe(2);
  });
});
