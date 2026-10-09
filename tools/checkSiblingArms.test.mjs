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
    const { groups, unparsed } = armGroups(FIXTURE);
    expect(unparsed).toEqual([]);
    const flat = arms => arms.flatMap(a => (a.parts ? flat(a.parts) : [a]));
    const text = g => flat(g.arms).map(a => FIXTURE.slice(a.start, a.end));
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

  it('treats an arm as prose only with two words in its literal text', () => {
    expect(readsAsWords('none')).toBe(false);
    expect(readsAsWords('  ')).toBe(false);
    expect(readsAsWords(' is ')).toBe(false);
    expect(readsAsWords('Allow Claude to change ?')).toBe(true);
  });

  it('counts one-letter words and skips identifier, path and host tokens', () => {
    expect(readsAsWords('I agree')).toBe(true);
    expect(readsAsWords("it's a well-known (draft).")).toBe(true);
    expect(readsAsWords('own_calls say_so')).toBe(false);
    expect(readsAsWords('/usr/bin/chromium api.github.com')).toBe(false);
    expect(readsAsWords('see api.github.com')).toBe(false);
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

// Arms the first version missed or misjudged on CC 2.1.295.
const FIXTURE2 = [
  // Array arms: each element is a composite fragment, and an array whose joined
  // text is ruled is covered as a whole (the start-kit reason ternary).
  'function k(e){return e==="a"?["Fixture tuple arm catalogued here","own_calls"]:e==="b"?["Fixture tuple arm left out","list"]:e==="c"?["Fixture tuple arm ruled whole","say_so"]:["Fixture tuple fallback arm","list"]}',
  // A `+` chain is one arm: its head template is reported, a chain whose
  // joined text is ruled is not opened, and a ternary under `+` is returned.
  'function m(s){switch(s.kind){case"a":return"Fixture concat sibling catalogued";case"b":return`Fixture concat head ${s.i} has no string`+(s.k===null?"":` (the fixture key is ${f(s.k)})`);case"c":return"Fixture whole chain part one "+"fixture whole chain part two"}}',
  'function n(r,x){return(r?"Fixture plus ternary catalogued":"Fixture plus ternary other arm")+x}',
  // A verdict recorded against the pre-promotion body still binds.
  'function p(e,t){return e?"Fixture legacy sibling catalogued":`Fixture legacy arm ${{yes:"y",no:"n"}[t]} stays ruled`}',
  // A `{` inside a slot must not swallow the prose after it.
  'function d(e,c){switch(e){case 1:return"Fixture brace sibling catalogued";case 2:return`${c("{")} Please confirm`}}',
  // One-letter words count; identifier-shaped tokens do not.
  'function y(e){switch(e){case 1:return"Fixture agree sibling catalogued";case 2:return"I agree";case 3:return"own_calls say_so"}}',
].join('\n');
const CATALOGUE2 = [
  prompt('tool-result-fixture-tuple', ['Fixture tuple arm catalogued here']),
  prompt('tool-result-fixture-concat', ['Fixture concat sibling catalogued']),
  prompt('tool-result-fixture-plus', ['Fixture plus ternary catalogued']),
  prompt('tool-result-fixture-legacy', ['Fixture legacy sibling catalogued']),
  prompt('tool-result-fixture-brace', ['Fixture brace sibling catalogued']),
  prompt('tool-result-fixture-agree', ['Fixture agree sibling catalogued']),
];
const LEGACY_BODY = 'Fixture legacy arm ${{yes:"y",no:"n"}[t]} stays ruled';
const CACHE2 = {
  [key('Fixture tuple arm ruled whole\nsay_so')]: { facing: 'internal' },
  [key('Fixture whole chain part one fixture whole chain part two')]: {
    facing: 'model',
    id: 'tool-result-fixture-whole-chain',
    name: 'Fixture',
    desc: 'Fixture',
  },
  [key(LEGACY_BODY)]: { facing: 'ui' },
};

describe('checkSiblingArms: composite, concat, legacy and word arms', () => {
  let cli2;
  beforeAll(() => {
    cli2 = path.join(dir, 'cli-9.9.8.js');
    fs.writeFileSync(cli2, FIXTURE2);
  });

  it('reports exactly the unruled arms', () => {
    const r = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: CACHE2 });
    expect(r.findings.map(f => f.body).sort()).toEqual(
      [
        ' (the fixture key is ${(.k)})',
        '${("{")} Please confirm',
        'Fixture concat head ${.i} has no string',
        'Fixture plus ternary other arm',
        'Fixture tuple arm left out',
        'Fixture tuple fallback arm',
        'I agree',
      ].sort()
    );
  });

  it('reads an array element as a composite fragment', () => {
    const r = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: CACHE2 });
    const left = r.findings.find(f => f.body === 'Fixture tuple arm left out');
    expect(left.kind).toBe('fragment');
    expect(left.anchors).toEqual(['tool-result-fixture-tuple']);
  });

  it('opens a `+` chain only when its joined text has no verdict', () => {
    const r = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: CACHE2 });
    const head = r.findings.find(f => f.body.startsWith('Fixture concat head'));
    expect(head.anchors).toEqual(
      expect.arrayContaining([
        'tool-result-fixture-concat',
        'tool-result-fixture-whole-chain',
      ])
    );
    expect(r.findings.some(f => f.body.includes('whole chain'))).toBe(false);
  });

  it('binds a verdict keyed to the pre-promotion body', () => {
    const r = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: CACHE2 });
    expect(r.findings.some(f => f.body.includes('legacy arm'))).toBe(false);
    const unruled = { ...CACHE2 };
    delete unruled[key(LEGACY_BODY)];
    const r2 = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: unruled });
    expect(r2.findings.some(f => f.body.includes('legacy arm'))).toBe(true);
  });

  it('counts words from the template text, not through a `{` in a slot', () => {
    const r = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: CACHE2 });
    const brace = r.findings.find(f => f.body.endsWith('Please confirm'));
    expect(brace?.anchors).toEqual(['tool-result-fixture-brace']);
  });

  it('counts a one-letter word and not identifier-shaped tokens', () => {
    const r = scanSiblingArms(cli2, { catalogue: CATALOGUE2, cache: CACHE2 });
    expect(r.findings.find(f => f.body === 'I agree')?.anchors).toEqual([
      'tool-result-fixture-agree',
    ]);
    expect(r.findings.some(f => f.body === 'own_calls say_so')).toBe(false);
  });

  it('prints valid JSON on stdout with --json and the summary on stderr', () => {
    const json2 = path.join(dir, 'prompts-9.9.8.json');
    const cache2 = path.join(dir, 'classification2.json');
    fs.writeFileSync(json2, JSON.stringify({ prompts: CATALOGUE2 }));
    fs.writeFileSync(cache2, JSON.stringify(CACHE2));
    const r = spawnSync(
      'node',
      [TOOL, cli2, json2, '--cache', cache2, '--json'],
      {
        encoding: 'utf8',
      }
    );
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).findings).toHaveLength(7);
    expect(r.stderr).toMatch(/sibling arms: 7 uncatalogued/);
  });
});

describe('checkSiblingArms: unparseable segments', () => {
  it('counts a segment acorn cannot parse and exits 2', () => {
    const bundle = [
      '\n/*@@TWEAKCC_MODULE:0:good.js@@*/\n',
      'function u(e){switch(e){case 1:return"Fixture parse arm one here";case 2:return"Fixture parse arm two here"}}',
      '\n/*@@TWEAKCC_MODULE:1:broken.js@@*/\n',
      'function ((( {',
    ].join('');
    const cli3 = path.join(dir, 'cli-9.9.7.js');
    const json3 = path.join(dir, 'prompts-9.9.7.json');
    const cache3 = path.join(dir, 'classification3.json');
    fs.writeFileSync(cli3, bundle);
    fs.writeFileSync(json3, JSON.stringify({ prompts: [] }));
    fs.writeFileSync(cache3, '{}');
    const { unparsed } = armGroups(bundle);
    expect(unparsed.map(u => u.name)).toEqual(['broken.js']);
    const r = spawnSync('node', [TOOL, cli3, json3, '--cache', cache3], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/UNPARSED segment broken\.js/);
    expect(r.stdout).toMatch(/1 unparseable segment/);
  });
});
