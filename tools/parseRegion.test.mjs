import { describe, it, expect } from 'vitest';
import {
  enclosingRegions,
  findBun,
  findNode,
  parseRegion,
  segmentAt,
} from './parseRegion.mjs';

const mod = (n, body) =>
  `\n/*@@TWEAKCC_MODULE:${n}:/$bunfs/root/m${n}.js@@*/\n${body}`;

const BUNDLE =
  '#!/usr/bin/env node\n// header' +
  mod(0, 'var a=1;function f(x){if(x){return /re}/.test(x)}return 2}') +
  mod(
    1,
    'class K extends Base{#p=1;static m(){return 1}get g(){return this.#p}' +
      'constructor(){super();this.h=async(y)=>{await y;return{k:y}}}}export{K};'
  ) +
  mod(
    2,
    'var o={x:1,async*gen(a){yield a},delete(k){return k},*[Symbol.iterator](){yield 1}};' +
      'x.class=1;if(o){o.y=2}'
  );

const regionText = (code, needle) => {
  const seg = segmentAt(code, code.indexOf(needle));
  const local = code.indexOf(needle) - seg.start;
  return enclosingRegions(seg.source, local).map(r => ({
    kind: r.kind,
    wrap: r.wrap,
    text: seg.source.slice(r.start, r.end),
  }));
};

describe('parseRegion: region discovery', () => {
  it('picks the module that holds the offset', () => {
    expect(segmentAt(BUNDLE, BUNDLE.indexOf('yield')).name).toBe(
      '/$bunfs/root/m2.js'
    );
  });

  it('finds a function declaration, past a regex holding a brace', () => {
    expect(regionText(BUNDLE, '/re}/')[0]).toEqual({
      kind: 'function',
      wrap: 'paren',
      text: 'function f(x){if(x){return /re}/.test(x)}return 2}',
    });
  });

  it('nests arrow, method and class, innermost first', () => {
    expect(regionText(BUNDLE, 'await y').map(r => r.kind)).toEqual([
      'arrow',
      'method',
      'class',
    ]);
    expect(regionText(BUNDLE, 'await y')[0].text).toBe(
      'async(y)=>{await y;return{k:y}}'
    );
  });

  it('wraps class members in a class and object members in an object', () => {
    expect(regionText(BUNDLE, 'this.#p')[0]).toMatchObject({
      kind: 'method',
      wrap: 'class',
      text: 'get g(){return this.#p}',
    });
    expect(regionText(BUNDLE, 'yield a')[0]).toMatchObject({
      kind: 'method',
      wrap: 'object',
      text: 'async*gen(a){yield a}',
    });
    expect(regionText(BUNDLE, 'return k')[0].text).toBe('delete(k){return k}');
    expect(regionText(BUNDLE, 'yield 1')[0].text).toBe(
      '*[Symbol.iterator](){yield 1}'
    );
  });

  it('does not take a block or a `.class` property for a region', () => {
    expect(regionText(BUNDLE, 'o.y=2')).toEqual([]);
  });

  it('covers a splice that starts in a parameter list', () => {
    expect(regionText(BUNDLE, 'x){if')[0].text).toMatch(/^function f\(x\)/);
  });

  it('refuses a module whose brackets do not balance', () => {
    expect(() => enclosingRegions('function f(){return(1}', 15)).toThrow(
      /unbalanced/
    );
  });
});

const parsers = { bun: findBun(), node: findNode() };
const canParse = Boolean(parsers.bun || parsers.node);

describe.skipIf(!canParse)('parseRegion: parse check', () => {
  it('passes a well-formed region without widening', () => {
    const r = parseRegion(BUNDLE, BUNDLE.indexOf('await y'));
    expect(r.ok).toBe(true);
    expect(r.region.kind).toBe('arrow');
    expect(r.tried).toBe(1);
  });

  it('widens past a region that fails only for want of context', () => {
    // `this.#p` needs the class that declares #p.
    const r = parseRegion(BUNDLE, BUNDLE.indexOf('this.#p'));
    expect(r.ok).toBe(true);
    expect(r.region.kind).toBe('class');
    expect(r.tried).toBe(2);
  });

  it('fails a broken splice inside a balanced function', () => {
    const bad = BUNDLE.replace('await y;', 'await y;let let=1;');
    const r = parseRegion(bad, bad.indexOf('await y'));
    expect(r.ok).toBe(false);
    expect(r.region.kind).toBe('arrow');
    const errors = r.results.flatMap(x => [x.bun, x.node]);
    expect(errors.every(e => e.skipped || !e.ok)).toBe(true);
  });

  it('fails an unbalanced splice through the whole module', () => {
    const bad = BUNDLE.replace('return 1}', 'return 1)}');
    const r = parseRegion(bad, bad.indexOf('return 1'));
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/does not tokenize cleanly/);
    expect(r.region.kind).toBe('module');
    const at = bad.indexOf('return 1)') + 'return 1'.length;
    const bunErr = r.results[0].bun;
    if (!bunErr.skipped) expect(bunErr.index).toBe(at);
  });

  it('checks a top-level splice against its whole module', () => {
    const r = parseRegion(BUNDLE, BUNDLE.indexOf('o.y=2'));
    expect(r.ok).toBe(true);
    expect(r.region.kind).toBe('module');
    expect(r.segment.name).toBe('/$bunfs/root/m2.js');
  });
});
