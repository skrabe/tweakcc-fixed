// Turn-economy tooling for the classify phase: the batched bundle query, the
// markdown packet, the one-step write+check, and the identity rules the CC
// 2.1.288 replay adjudication added (continuity kept unless the role changed,
// ids on fragments never on joins).
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RouteProgram } from './lib/emissionRoute.mjs';
import { BundleIndex, renderAnswer } from './lib/bundleQuery.mjs';
import { renderCandidateMd, renderFamilyMd, snippetBook, catalogueNeighbourIndex, rewriteRoles } from './lib/classifyPacketMd.mjs';
import { attachContinuity } from './lib/continuity.mjs';
import { identityProblems, fieldProblems } from './lib/classifyVerdicts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const H = c => c.repeat(40);

const bundle = mods =>
  '#!/usr/bin/env node\n// Virtual bundle\nvar __ccVirtualBundleModules = ' + mods.length + ';\n' +
  mods.map(([name, src], i) => `\n/*@@TWEAKCC_MODULE:${i}:/$bunfs/root/${name}@@*/\n${src}\n`).join('');

// The plugin-installer shape of CC 2.1.288: a refusal that only renders when
// the caller passes replaceInstalledCopy, one caller that sets it and one
// (the model-bound one) that does not.
const CODE = bundle([
  ['chunk-inst.js', 'function msg(e){return`A switch needs a fresh read of ${e}, not the saved copy`}async function Crt(e,{replaceInstalledCopy:c,surface:r="cli"}={}){if(c){return{success:!1,message:msg(e)}}return{success:!0,message:`Installed ${e}`}}export{Crt};'],
  ['chunk-ui.js', 'import{Crt}from"/$bunfs/root/chunk-inst.js";async function sw(p){let o=await Crt(p,{replaceInstalledCopy:!0,surface:"installed_switch"});return o.message}async function nb(p){let o=await Crt(p,{});return o.message}export{sw,nb};'],
]);
const at = text => CODE.indexOf(text);

describe('bundleQuery', () => {
  const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
  const lit = 'A switch needs a fresh read of ${e}, not the saved copy';
  const litStart = CODE.indexOf('`A switch') ;
  const sites = new Map([[sha1('A switch needs a fresh read of ${}, not the saved copy'), [[litStart, litStart + lit.length + 2, 't']]]]);
  const idx = () => new BundleIndex({ code: CODE, program: new RouteProgram(CODE), sites, classification: {}, catalogue: [{ id: 'tool-result-x', pieces: ['A switch needs a fresh read'] }] });

  it('names the option a minified guard tests and where the bundle sets it', () => {
    const q = idx();
    const g = q.guards(at('return{success:!1'));
    expect(g[0].arm).toBe('then');
    expect(g[0].test).toBe('c');
    expect(g[0].props).toContain('replaceInstalledCopy');
    const p = q.prop('replaceInstalledCopy');
    const set = p.find(r => r.kind.startsWith('SET'));
    const read = p.find(r => r.kind.startsWith('READ'));
    expect(set.total).toBe(1);
    expect(set.hits[0].detail).toBe('= !0');
    expect(read.total).toBe(1);
    expect(read.hits[0].detail).toBe('destructured');
  });

  it('answers callers across an import with the condition each call sits behind', () => {
    const r = idx().callers(at('async function Crt'), 1);
    const calls = r.levels[0][0].calls;
    expect(calls.map(c => c.in && c.in.name).sort()).toEqual(['nb', 'sw']);
    const text = renderAnswer({ kind: 'callers', ...r });
    expect(text).toContain('callers of Crt');
  });

  it('runs a batch: text with enclosing function, catalogue search, unknown kinds are errors', () => {
    const q = idx();
    expect(renderAnswer(q.run({ text: 'not the saved copy' }))).toMatch(/in msg @/);
    expect(renderAnswer(q.run({ catalogue: 'fresh read' }))).toContain('tool-result-x');
    expect(() => q.run({ nope: 1 })).toThrow(/unknown query/);
  });

  it('the CLI answers many queries in one call', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-'));
    const cli = path.join(dir, 'cli.js');
    fs.writeFileSync(cli, CODE);
    const r = spawnSync(process.execPath, [path.join(HERE, 'bundleQuery.mjs'), '--cli', cli, '--cache-dir', dir], {
      input: JSON.stringify([{ prop: 'replaceInstalledCopy' }, { fn: at('return{success:!1') }, { slice: 10, before: 0, after: 5 }]),
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('## q1');
    expect(r.stdout).toContain('## q2');
    expect(r.stdout).toContain('## q3');
    expect(r.stdout).toMatch(/fn Crt/);
  });
});

describe('setter aliases, JSX render sites and caller-side gates (CC 2.1.288 tie-break)', () => {
  const V = bundle([
    ['chunk-view.js', 'function vl({setError:k,setResult:v}){try{let r=doIt();v(wrap(`Removed ${r}`))}catch(e){k(`Could not remove: ${e}`)}}function wrap(s){return s}function doIt(){return"x"}var j=Symbol.for("react.transitional.element");function h(t,p){return{$$typeof:j,type:t,props:p}}function Hp(s){return s.kind==="npm-install"?h(nb,{spec:s.spec}):null}function nb(p){return p.spec}export{vl,Hp};'],
  ]);
  const q = () => new BundleIndex({ code: V, program: new RouteProgram(V) });

  it('names which destructured prop a minified callee is', () => {
    const at = V.indexOf('v(wrap(');
    expect(q().calleeAlias(at)).toMatchObject({ local: 'v', key: 'setResult' });
    expect(q().calleeAlias(V.indexOf('k(`Could'))).toMatchObject({ local: 'k', key: 'setError' });
    const a = q().aliases(at);
    expect(a[0].pairs).toEqual([['setError', 'k'], ['setResult', 'v']]);
    expect(renderAnswer(q().run({ aliases: at }))).toContain('v(…) is the destructured prop setResult');
  });

  it("reports each caller's wiring of a view's setter props, crosswise included", () => {
    const W = bundle([
      ['chunk-w.js', 'function fu({setResult:S,setError:C}){try{S("done")}catch(e){C(`Failed: ${e}`)}}function xt(a){return fu({setResult:a.setResult,setError:a.setResult})}export{xt};'],
    ]);
    const qq = new BundleIndex({ code: W, program: new RouteProgram(W) });
    const w = qq.wiring(W.indexOf('C(`Failed'));
    expect(w.sites[0].props).toEqual([['setResult', 'a.setResult'], ['setError', 'a.setResult']]);
    expect(renderAnswer(qq.run({ aliases: W.indexOf('C(`Failed') }))).toContain('setError=a.setResult');
    const md = renderFamilyMd({ label: 'F1', key: 'fn:1', fn: { start: 1, end: 9, name: 'fu', module: 'm', head: 'function fu(' }, candidateCount: 1, setters: [['setResult', 'S'], ['setError', 'C']], wiring: { total: 1, sites: [{ at: 50, how: 'call', in: { start: 40, name: 'xt' }, props: w.sites[0].props }] } }, { snip: snippetBook(''), propSets: new Map() });
    expect(md).toContain('CROSSWISE: setError is a.setResult');
  });

  it('flags a model sink next to an outbound control_response', () => {
    const md = renderCandidateMd({ key: 'k01', hash: H('f'), len: 3, source: 'x', body: 'b', sites: [], siteCount: 0, route: { verdict: 'model', resolved: true, sinks: [{ kind: 'permission-message', facing: 'model', at: 5 }] }, outboundControl: [5] }, { snip: snippetBook(''), propSets: new Map(), src: '' });
    expect(md).toContain('outbound control message nearby');
  });

  it('lists a JSX render of a component as an entry, with the condition it sits behind', () => {
    const r = q().callers(V.indexOf('function nb'), 1);
    const c = r.levels[0][0].calls.find(x => x.how === 'jsx');
    expect(c).toBeTruthy();
    expect(c.guards.some(g => g.test.includes('npm-install'))).toBe(true);
  });

  it('renders caller-side entries and callee aliases in the packet', () => {
    const md = renderCandidateMd({
      key: 'k01', hash: H('e'), len: 3, source: 'x', body: 'b', sites: [], siteCount: 0,
      route: { verdict: 'model', resolved: true, sinks: [{ kind: 'local-jsx-ondone', facing: 'model', at: 40 }], open: ['passed to a dynamic call (parameter/unknown callee) @77'] },
      calleeAliases: { 77: 'v=setResult' },
      sinkEntry: { fn: { start: 9, name: 'nb' }, total: 1, calls: [{ at: 30, how: 'jsx', in: { start: 20, name: 'Hp' }, guards: [{ arm: 'then', test: 's.kind==="npm-install"', props: [] }] }] },
    }, { snip: snippetBook(''), propSets: new Map(), src: '' });
    expect(md).toContain('[callee v=setResult]');
    expect(md).toContain("the model sink's function nb @9 is entered 1×: rendered as JSX @30 in Hp @20 behind then of");
  });
});

describe('markdown packet', () => {
  const base = {
    key: 'k01', hash: H('a'), len: 40, source: 'captured', body: 'line one\nline two', sites: [{ start: at('`A switch'), end: at('`A switch') + 20, kind: 't' }], siteCount: 1,
    route: { verdict: 'model', resolved: false, sinks: [{ kind: 'local-jsx-ondone', facing: 'model', at: 5, via: 'ret@1 > ret@2' }], open: ['passed to a dynamic call @7'], openTotal: 3 },
    guards: [{ at: 9, arm: 'then', test: 'c', props: ['replaceInstalledCopy'] }],
  };
  const propSets = new Map([['replaceInstalledCopy', 'set at 1 site(s): sw @1 = !0']]);

  it('carries the full body, the guard with its setters, the route with code, and the open count', () => {
    const md = renderCandidateMd(base, { snip: snippetBook(CODE), propSets, src: CODE });
    expect(md).toContain('> line one\n> line two');
    expect(md).toContain('then of `c` [replaceInstalledCopy: set at 1 site(s): sw @1 = !0]');
    expect(md).toContain('sink local-jsx-ondone [model] @5');
    expect(md).toMatch(/2 more open branch/);
  });

  it('marks joins, settings-oracle hits, continuity and removed-id leads', () => {
    const md = renderCandidateMd({ ...base, joinOf: { keys: ['chunk 03 k07'], allFragmentsAreCandidates: true }, settingsOracle: 'exact', reusedFrom: { id: 'old-id', similarity: 1 }, reusedFromOldBody: 'old text', removedIdLeads: [{ id: 'gone-id', windows: 4, oldBody: 'gone text' }] }, { snip: snippetBook(CODE), propSets, src: CODE });
    expect(md).toContain('JOIN of fragments');
    expect(md).toContain('a model-facing join takes its own id');
    expect(md).toContain('Settings oracle');
    expect(md).toContain('reusedFrom: **old-id**');
    expect(md).toContain('removed-id lead');
    expect(md).toContain('gone-id');
  });

  it('a family block lists callers with their conditions and the cached sibling facings', () => {
    const md = renderFamilyMd({
      label: 'F1', key: 'fn:1', fn: { start: 1, end: 50, name: 'msg', module: 'chunk-inst.js', head: 'function msg(e){' }, candidateCount: 1,
      callers: { levels: [[{ fn: { start: 1, name: 'msg' }, total: 1, calls: [{ at: 30, in: { start: 20, name: 'Crt' }, guards: [{ arm: 'then', test: 'c', props: ['replaceInstalledCopy'] }] }], roles: [], hofs: [], jsxType: [], unresolved: [] }]] },
      literals: { total: 3, thisRun: 1, counts: { model: 1, ui: 1, internal: 0, uncached: 0 }, shown: [{ at: 40, facing: 'model tool-result-x', text: 'hello' }], more: 0 },
    }, { snip: snippetBook(CODE), propSets });
    expect(md).toContain('Called 1×: Crt @20 @30 behind then of `c` [replaceInstalledCopy');
    expect(md).toContain('model tool-result-x');
  });

  it('finds the nearest catalogued prompt and rewrite roles', () => {
    const idx = catalogueNeighbourIndex([{ id: 'p1', pieces: ['Plugin installs need a fresh marketplace listing first'] }, { id: 'p2', pieces: ['Completely unrelated words about weather today'] }]);
    expect(idx.nearest('Plugin installs need a fresh marketplace listing now')[0].id).toBe('p1');
    const roles = rewriteRoles([{ needle: 'old phrase here', replacement: 'new phrase' }]);
    expect(roles.get('old phrase here')).toBe('needle');
    expect(roles.get('new phrase')).toBe('replacement');
  });
});

describe('continuity', () => {
  it('hints a removed id whose body matches after slot normalization, never a live one', () => {
    const prev = [
      { id: 'gone-id', pieces: ['Save ', { x: 1 }, ' in the memory store? You are in plan mode.'] },
      { id: 'live-id', pieces: ['Still here and unchanged in this release text'] },
    ];
    const current = [{ id: 'live-id', pieces: ['Still here and unchanged in this release text'] }];
    const cands = [
      { hash: H('1'), body: 'Save ${(e)} in the memory store? You are in plan mode.' },
      { hash: H('2'), body: 'Still here and unchanged in this release text' },
    ];
    attachContinuity(cands, current, prev);
    expect(cands[0].reusedFrom).toMatchObject({ id: 'gone-id' });
    expect(cands[1].reusedFrom).toBeUndefined();
  });
});

describe('identity rules', () => {
  const cands = new Map([
    [H('a'), { hash: H('a'), key: 'k01', reusedFrom: { id: 'old-id' } }],
    [H('b'), { hash: H('b'), key: 'k02', joinOf: { hashes: [H('c')], keys: ['k03'], allFragmentsAreCandidates: false, fragmentIds: ['frag-old-id'] } }],
    [H('c'), { hash: H('c'), key: 'k03' }],
    [H('d'), { hash: H('d'), key: 'k04', joinOf: { hashes: [H('c')], keys: ['k03'], allFragmentsAreCandidates: true, fragmentIds: [] } }],
  ]);
  const m = (h, id, extra = {}) => ({ hash: h, facing: 'model', id, name: 'N', desc: 'D', evidence: 'route sink @1 proven', ...extra });

  it('keeps continuity unless the verdict states a role change', () => {
    expect(identityProblems([m(H('a'), 'old-id')], { cands, label: 'classify' })).toEqual([]);
    expect(identityProblems([m(H('a'), 'new-id')], { cands, label: 'classify' })[0]).toMatch(/aaaaaaaaaa carries reusedFrom old-id/);
    expect(identityProblems([m(H('a'), 'new-id', { roleChange: 'split: this is the tail half of the old prompt' })], { cands, label: 'classify' })).toEqual([]);
    expect(identityProblems([{ hash: H('a'), facing: 'ui', id: null, evidence: 'console line at 4 only' }], { cands, label: 'classify' })[0]).toMatch(/is ui/);
  });

  it('accepts a non-kebab catalogue id only when it is reused verbatim', () => {
    const legacy = 'tool-parameter-bash-run_in_background-timeout-limit';
    const v = m(H('e'), legacy);
    expect(fieldProblems(v, { hash: H('e'), allowedIds: [legacy] }, 'classify')).toEqual([]);
    expect(fieldProblems(v, { hash: H('e'), allowedIds: [] }, 'classify')[0]).toMatch(/not kebab-case/);
    expect(fieldProblems(v, undefined, 'classify')[0]).toMatch(/not kebab-case/);
  });

  it('refuses a fragment id or a fragment continuity id on a join, but lets a join take its own id', () => {
    expect(identityProblems([m(H('b'), 'frag-old-id')], { cands, label: 'classify' })[0]).toMatch(/JOIN .*belongs to one of its fragments/);
    const fv = new Map([[H('c'), m(H('c'), 'tail-id')]]);
    expect(identityProblems([m(H('b'), 'tail-id')], { cands, label: 'classify', fragmentVerdicts: fv })[0]).toMatch(/belongs to one of its fragments/);
    expect(identityProblems([m(H('b'), 'join-own-id')], { cands, label: 'classify', fragmentVerdicts: fv })).toEqual([]);
    expect(identityProblems([m(H('d'), 'tail-id')], { cands, label: 'classify', fragmentVerdicts: fv })[0]).toMatch(/belongs to one of its fragments/);
    expect(identityProblems([m(H('d'), 'composite-own-id')], { cands, label: 'classify', fragmentVerdicts: fv })).toEqual([]);
  });
});

describe('writeClassifyVerdicts', () => {
  let dir;
  let man;
  const A = H('a'), B = H('b');
  const write = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o));
  const run = (input, ...a) => spawnSync(process.execPath, [path.join(HERE, 'writeClassifyVerdicts.mjs'), dir, '00', ...a], { input: JSON.stringify(input), encoding: 'utf8' });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-w-'));
    const bundlePath = path.join(dir, 'cli.js');
    const promptsJson = path.join(dir, 'prompts.json');
    fs.writeFileSync(bundlePath, 'bundle bytes');
    fs.writeFileSync(promptsJson, JSON.stringify({ version: '9.9.9', prompts: [] }));
    const bundle = { path: bundlePath, sha256: crypto.createHash('sha256').update('bundle bytes').digest('hex') };
    const corpus = { promptsJson, digest: crypto.createHash('sha256').update(fs.readFileSync(promptsJson)).digest('hex').slice(0, 16) };
    man = { format: 1, version: '9.9.9', bundle, corpus, catalogueIndex: 'catalogue-index.json', chunkCount: 1, chunks: [{ chunk: '00', hashes: [A, B] }] };
    write('manifest.json', man);
    write('catalogue-index.json', {});
    write('chunk-00.json', {
      version: '9.9.9', bundle, corpus, commands: { writeVerify: 'W --stage verify', query: 'Q' },
      families: [{ key: 'fn:1', md: '## F1 · fn x' }],
      candidates: [
        { hash: A, key: 'k01', family: 'fn:1', body: 'a', md: '### k01 body a', route: { verdict: 'ui', resolved: true }, allowedIds: [] },
        { hash: B, key: 'k02', family: 'fn:1', body: 'b', md: '### k02 body b', route: { verdict: 'model', resolved: true }, allowedIds: [] },
      ],
    });
  });

  it('maps keys to hashes, nulls non-model names, writes, checks, and renders the verifier packet', () => {
    const r = run([
      { k: 'k01', facing: 'ui', id: 'stray', name: 'x', desc: 'y', evidence: 'Ink children at 12 only' },
      { k: 'k02', facing: 'internal', evidence: 'debug log at 40, route proof does not hold' },
    ]);
    expect(r.stdout, r.stdout + r.stderr).toMatch(/^PASS chunk 00 \(classify\)/);
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'verdicts-00.json'), 'utf8'));
    expect(file.bundleSha).toBe(man.bundle.sha256);
    expect(file.verdicts.map(v => v.hash)).toEqual([A, B]);
    expect(file.verdicts[0].id).toBeNull();
    const md = fs.readFileSync(path.join(dir, 'verify-00.md'), 'utf8');
    expect(md).toContain('### k02 body b');
    expect(md).toContain('draft contradicts the traced model route');
    expect(md).not.toContain('### k01');
  });

  it('merges a fix into the file on disk and reports problems by key', () => {
    let r = run([{ k: 'k01', facing: 'ui', evidence: 'Ink children at 12 only' }]);
    expect(r.stdout).toMatch(/^FAIL/);
    expect(r.stdout).toMatch(/missing 1 of 2/);
    r = run([{ k: 'k02', facing: 'model', id: 'tool-result-b', name: 'B', desc: 'What the model reads.', evidence: 'route sink local-jsx-ondone @5' }]);
    expect(r.stdout).toMatch(/^PASS/);
  });

  it('writes nothing for an entry that names no candidate', () => {
    const r = run([{ k: 'k09', facing: 'ui', evidence: 'x' }]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/no candidate of this chunk/);
    expect(fs.existsSync(path.join(dir, 'verdicts-00.json'))).toBe(false);
  });
});
