import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  scanKey,
  scannerVersion,
  scanSiblingArms,
  scanSiblingArmsShared,
} from './checkSiblingArms.mjs';
import { keyVariants } from './probeCacheKey.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIBLING = path.join(HERE, 'checkSiblingArms.mjs');
const MIXED = path.join(HERE, 'checkMixedCallVerdicts.mjs');
const key = body => keyVariants(body)[0].key;

const MODEL = 'Model facing call text';
const LOGGED = 'Logged only call text';
const CODE = [
  'function p(m){return {error:m}}',
  `function a(x){if(x)return p("${MODEL}");return p("${LOGGED}")}`,
  'function t(e){return e?`Fixture ternary yes branch for ${e}`:"Fixture ternary no branch here"}',
].join('\n');
const CATALOGUE = [
  {
    id: 'tool-result-fixture-ternary-yes',
    name: 'Fixture',
    description: '',
    pieces: ['Fixture ternary yes branch for ${', '}'],
    identifiers: [],
    identifierMap: {},
  },
];
const CACHE = {
  [key(MODEL)]: { facing: 'model', id: 'tool-result-fixture-model-call' },
  [key(LOGGED)]: { facing: 'internal' },
};
const BROKEN = [
  '\n/*@@TWEAKCC_MODULE:0:good.js@@*/\n',
  CODE,
  '\n/*@@TWEAKCC_MODULE:1:broken.js@@*/\n',
  'function ((( {',
].join('');

describe('scanSiblingArmsShared', () => {
  let dir;
  let store;
  let cli;
  const entries = () =>
    fs
      .readdirSync(store)
      .filter(f => /^sibling-scan-[0-9a-f]{64}\.json$/.test(f));
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-shared-'));
    store = path.join(dir, 'store');
    fs.mkdirSync(store);
    cli = path.join(dir, 'cli-9.9.5.js');
    fs.writeFileSync(cli, CODE);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const inputs = (over = {}) => ({
    catalogue: CATALOGUE,
    cache: CACHE,
    ...over,
  });

  describe('key', () => {
    const base = () => scanKey(CODE, { ...inputs(), version: '9.9.5' });

    it('is stable for equal inputs and sensitive to every input', () => {
      expect(base()).toMatch(/^[0-9a-f]{64}$/);
      expect(base()).toBe(base());
      const changed = [
        scanKey(`${CODE} `, { ...inputs(), version: '9.9.5' }),
        scanKey(CODE, { ...inputs(), version: '9.9.6' }),
        scanKey(CODE, { ...inputs(), version: null }),
        scanKey(CODE, {
          ...inputs({ cache: { ...CACHE, [key('Other text here')]: {} } }),
          version: '9.9.5',
        }),
        scanKey(CODE, {
          ...inputs({
            cache: {
              ...CACHE,
              [key(LOGGED)]: { facing: 'ui' },
            },
          }),
          version: '9.9.5',
        }),
        scanKey(CODE, {
          ...inputs({ catalogue: [] }),
          version: '9.9.5',
        }),
        scanKey(CODE, {
          ...inputs({ catalogue: undefined }),
          version: '9.9.5',
        }),
      ];
      expect(new Set([base(), ...changed]).size).toBe(changed.length + 1);
    });

    it('is derived from the scanner source', () => {
      expect(scannerVersion()).toMatch(/^[0-9a-f]{64}$/);
      expect(scannerVersion()).toBe(scannerVersion());
    });
  });

  describe('lookup', () => {
    it('returns the scan result and stores it under the key', () => {
      const direct = scanSiblingArms(cli, { ...inputs(), version: '9.9.5' });
      const shared = scanSiblingArmsShared(cli, inputs(), { dir: store });
      expect(shared).toEqual(direct);
      expect(entries()).toEqual([
        `sibling-scan-${scanKey(CODE, { ...inputs(), version: '9.9.5' })}.json`,
      ]);
    });

    it('serves a second call from the stored entry', () => {
      scanSiblingArmsShared(cli, inputs(), { dir: store });
      const [file] = entries().map(f => path.join(store, f));
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      entry.result.groups = -1;
      fs.writeFileSync(file, JSON.stringify(entry));
      expect(scanSiblingArmsShared(cli, inputs(), { dir: store }).groups).toBe(
        -1
      );
    });

    it('serves the same entry to a call that passes the version explicitly', () => {
      const first = scanSiblingArmsShared(cli, inputs(), { dir: store });
      const second = scanSiblingArmsShared(cli, inputs({ version: '9.9.5' }), {
        dir: store,
      });
      expect(second).toEqual(first);
      expect(entries()).toHaveLength(1);
    });

    it.each([
      [
        'a classification entry',
        () => inputs({ cache: { ...CACHE, [key(LOGGED)]: { facing: 'ui' } } }),
        () => {},
      ],
      ['the catalogue', () => inputs({ catalogue: [] }), () => {}],
      ['the bundle', () => inputs(), () => fs.writeFileSync(cli, `${CODE}\n`)],
    ])('misses when %s changes and computes fresh', (_, make, touch) => {
      scanSiblingArmsShared(cli, inputs(), { dir: store });
      const [file] = entries().map(f => path.join(store, f));
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      entry.result.groups = -1;
      fs.writeFileSync(file, JSON.stringify(entry));
      touch();
      const after = scanSiblingArmsShared(cli, make(), { dir: store });
      expect(after.groups).not.toBe(-1);
      expect(after).toEqual(
        scanSiblingArms(cli, { ...make(), version: '9.9.5' })
      );
      expect(entries()).toHaveLength(2);
    });

    it('recomputes over a corrupt entry or one filed under another key', () => {
      scanSiblingArmsShared(cli, inputs(), { dir: store });
      const [file] = entries().map(f => path.join(store, f));
      const good = JSON.parse(fs.readFileSync(file, 'utf8'));
      const direct = scanSiblingArms(cli, { ...inputs(), version: '9.9.5' });
      for (const bad of [
        '{"key":',
        '',
        'null',
        JSON.stringify({
          ...good,
          key: 'f'.repeat(64),
          result: { groups: -1 },
        }),
        JSON.stringify({ key: good.key }),
      ]) {
        fs.writeFileSync(file, bad);
        expect(scanSiblingArmsShared(cli, inputs(), { dir: store })).toEqual(
          direct
        );
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).key).toBe(good.key);
      }
    });

    it('stores nothing without a directory and survives an unusable one', () => {
      const direct = scanSiblingArms(cli, { ...inputs(), version: '9.9.5' });
      expect(scanSiblingArmsShared(cli, inputs(), { dir: '' })).toEqual(direct);
      expect(entries()).toEqual([]);
      expect(
        scanSiblingArmsShared(cli, inputs(), {
          dir: path.join(dir, 'missing'),
        })
      ).toEqual(direct);
      expect(fs.existsSync(path.join(dir, 'missing'))).toBe(false);
    });

    it('leaves no temporary file beside an entry', () => {
      scanSiblingArmsShared(cli, inputs(), { dir: store });
      expect(fs.readdirSync(store)).toEqual(entries());
    });

    it('keeps unparsed segments in the stored result', () => {
      fs.writeFileSync(cli, BROKEN);
      const first = scanSiblingArmsShared(cli, inputs(), { dir: store });
      expect(first.unparsed.map(u => u.name)).toEqual(['broken.js']);
      expect(scanSiblingArmsShared(cli, inputs(), { dir: store })).toEqual(
        first
      );
    });
  });

  describe('gates', () => {
    let json;
    let cachePath;
    let allowlist;
    beforeEach(() => {
      json = path.join(dir, 'prompts.json');
      cachePath = path.join(dir, 'classification.json');
      allowlist = path.join(dir, 'allowlist.json');
      fs.writeFileSync(json, JSON.stringify({ prompts: CATALOGUE }));
      fs.writeFileSync(cachePath, JSON.stringify(CACHE));
      fs.writeFileSync(allowlist, '{}');
    });
    const run = (tool, extra, withStore) => {
      const env = { ...process.env };
      delete env.SHOWTIME_TMP;
      if (withStore) env.SHOWTIME_TMP = store;
      const args = [tool, cli, json, '--cache', cachePath, ...extra];
      if (tool === MIXED) args.push('--allowlist', allowlist);
      const r = spawnSync('node', args, { encoding: 'utf8', env });
      return { stdout: r.stdout, stderr: r.stderr, status: r.status };
    };

    it.each([
      ['a failing fixture', CODE, [], 1, 1],
      ['a failing fixture as json', CODE, ['--json'], 1, 1],
      ['an unparseable segment', BROKEN, [], 2, 2],
    ])(
      'print the same output and status with a shared store on %s, in either order',
      (_, code, extra, siblingStatus, mixedStatus) => {
        fs.writeFileSync(cli, code);
        const plain = {
          sibling: run(SIBLING, extra, false),
          mixed: run(MIXED, extra, false),
        };
        expect(plain.sibling.status).toBe(siblingStatus);
        expect(plain.mixed.status).toBe(mixedStatus);
        for (const order of [
          [SIBLING, MIXED],
          [MIXED, SIBLING],
        ]) {
          for (const f of fs.readdirSync(store)) fs.rmSync(path.join(store, f));
          const got = {};
          for (const tool of order)
            got[tool === SIBLING ? 'sibling' : 'mixed'] = run(
              tool,
              extra,
              true
            );
          expect(got).toEqual(plain);
          expect(entries()).toHaveLength(1);
        }
      }
    );

    it('recomputes in the second gate when a classification entry changed between runs', () => {
      const plain = () => ({
        sibling: run(SIBLING, [], false),
        mixed: run(MIXED, [], false),
      });
      run(SIBLING, [], true);
      expect(entries()).toHaveLength(1);
      fs.writeFileSync(
        cachePath,
        JSON.stringify({
          ...CACHE,
          [key(LOGGED)]: { facing: 'model', id: 'x-y' },
        })
      );
      const second = run(MIXED, [], true);
      expect(entries()).toHaveLength(2);
      expect(second).toEqual(plain().mixed);
    });
  });
});
