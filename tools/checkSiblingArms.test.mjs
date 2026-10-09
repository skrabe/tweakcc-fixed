// checkSiblingArms must report every unruled arm beside a catalogued one, and
// nothing that is ruled, catalogued, word-free, unanchored or not returned.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  armGroups,
  readsAsWords,
  scanSiblingArms,
} from './checkSiblingArms.mjs';
import { keyVariants } from './probeCacheKey.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'checkSiblingArms.mjs');
const key = body => keyVariants(body)[0].key;

const FIXTURE = [
  'function q(e,r){switch(e.kind){case"a":return`Fixture arm one asks about ${r.name} now?`;case"b":return`Fixture arm two asks about ${r} later?`;case"c":if(e.x)return"Fixture arm three sits in an if block";return`Fixture arm four ${r} is ruled`;case"d":return"none"}}',
  'function t(e){return e?`Fixture ternary yes branch for ${e}`:"Fixture ternary no branch here"}',
  'var notReturned=globalThis.x?"Fixture unreturned ternary one":"Fixture unreturned ternary two";',
  'function w(e){switch(e){case"x":return["Fixture array arm about cats"];case"y":return["Fixture array arm about dogs"]}}',
  'function u(e){switch(e){case 1:return"Fixture lonely switch arm one";case 2:return"Fixture lonely switch arm two"}}',
  'var arrow=e=>e?"Fixture arrow arm catalogued here":`Fixture arrow arm ${e} left out`;',
].join('\n');

const prompt = (id, pieces) => ({
  id,
  name: id,
  description: '',
  pieces,
  identifiers: [],
  identifierMap: {},
});
const CATALOGUE = [
  prompt('tool-result-fixture-arm-one', [
    'Fixture arm one asks about ${',
    '.name} now?',
  ]),
  prompt('tool-result-fixture-unreturned-one', [
    'Fixture unreturned ternary one',
  ]),
  prompt('tool-result-fixture-array-dogs', ['Fixture array arm about dogs']),
  prompt('tool-result-fixture-arrow-catalogued', [
    'Fixture arrow arm catalogued here',
  ]),
];
const CACHE = {
  [key('Fixture arm four ${} is ruled')]: { facing: 'ui' },
  [key('Fixture ternary yes branch for ${}')]: {
    facing: 'model',
    id: 'tool-result-fixture-ternary-yes',
    name: 'Fixture',
    desc: 'Fixture',
  },
};

let dir;
let cli;
let json;
let cachePath;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-arms-'));
  cli = path.join(dir, 'cli-9.9.9.js');
  json = path.join(dir, 'prompts-9.9.9.json');
  cachePath = path.join(dir, 'classification.json');
  fs.writeFileSync(cli, FIXTURE);
  fs.writeFileSync(
    json,
    JSON.stringify({ version: '9.9.9', prompts: CATALOGUE })
  );
  fs.writeFileSync(cachePath, JSON.stringify(CACHE));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('checkSiblingArms: groups', () => {
  it('collects switch returns through if blocks and arrays, and returned ternaries only', () => {
    const groups = armGroups(FIXTURE);
    const text = g => g.arms.map(([s, e]) => FIXTURE.slice(s, e));
    const kinds = groups.map(g => g.kind).sort();
    expect(kinds).toEqual(['switch', 'switch', 'switch', 'ternary', 'ternary']);
    const q = groups.find(g =>
      text(g).some(t => t.includes('Fixture arm one'))
    );
    expect(text(q)).toHaveLength(5);
    expect(text(q)).toContain('"Fixture arm three sits in an if block"');
    expect(groups.some(g => text(g).some(t => t.includes('unreturned')))).toBe(
      false
    );
  });

  it('treats an arm as prose only with two words outside its slots', () => {
    expect(readsAsWords('none')).toBe(false);
    expect(readsAsWords('${a} ${b.c}')).toBe(false);
    expect(readsAsWords('${a} is ${b}')).toBe(false);
    expect(readsAsWords('Allow Claude to change ${}?')).toBe(true);
  });
});

describe('checkSiblingArms: scan', () => {
  it('reports exactly the unruled, uncatalogued prose arms beside a catalogued arm', () => {
    const r = scanSiblingArms(cli, { catalogue: CATALOGUE, cache: CACHE });
    const bodies = r.findings.map(f => f.body).sort();
    expect(bodies).toEqual([
      'Fixture arm three sits in an if block',
      'Fixture arm two asks about ${} later?',
      'Fixture array arm about cats',
      'Fixture arrow arm ${} left out',
      'Fixture ternary no branch here',
    ]);
    const two = r.findings.find(f => f.body.startsWith('Fixture arm two'));
    expect(two.anchors).toEqual(['tool-result-fixture-arm-one']);
    expect(two.key).toBe(key('Fixture arm two asks about ${} later?'));
    expect(r.findings.find(f => f.body.includes('no branch')).anchors).toEqual([
      'tool-result-fixture-ternary-yes',
    ]);
    expect(r.trivial).toBe(1);
    expect(r.anchored).toBe(4);
  });

  it('exits 1 with findings and 0 once every arm is ruled', () => {
    const run = () =>
      spawnSync('node', [TOOL, cli, json, '--cache', cachePath], {
        encoding: 'utf8',
      });
    const first = run();
    expect(first.status).toBe(1);
    expect(first.stdout).toMatch(
      /sibling arms: 5 uncatalogued unclassified arm\(s\)/
    );
    const ruled = { ...CACHE };
    for (const b of [
      'Fixture arm three sits in an if block',
      'Fixture arm two asks about ${} later?',
      'Fixture array arm about cats',
      'Fixture arrow arm ${} left out',
      'Fixture ternary no branch here',
    ])
      ruled[key(b)] = { facing: 'internal' };
    fs.writeFileSync(cachePath, JSON.stringify(ruled));
    const second = run();
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/sibling arms: 0 uncatalogued/);
  });

  it('rejects a missing argument with exit 2', () => {
    const r = spawnSync('node', [TOOL, cli], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
