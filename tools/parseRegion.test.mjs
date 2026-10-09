import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enclosingRegions,
  findBun,
  findNode,
  hasUseStrictDirective,
  parseRegion,
  segmentAt,
  sourceKind,
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
  it('passes a well-formed region once its context parses too', () => {
    const r = parseRegion(BUNDLE, BUNDLE.indexOf('await y'));
    expect(r.ok).toBe(true);
    expect(r.smallest.kind).toBe('arrow');
    expect(r.results[0].ok).toBe(true);
    // The constructor alone fails for want of `extends`; its class confirms.
    expect(r.results.map(x => x.ok)).toEqual([true, false, true, true]);
    expect(r.region.kind).toBe('module');
  });

  it('widens past a region that fails only for want of context', () => {
    // `this.#p` needs the class that declares #p.
    const r = parseRegion(BUNDLE, BUNDLE.indexOf('this.#p'));
    expect(r.ok).toBe(true);
    expect(r.smallest.kind).toBe('method');
    expect(r.results.map(x => x.ok)).toEqual([false, true, true]);
    expect(r.region.kind).toBe('module');
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

describe('parseRegion: module kind and strictness', () => {
  it('reads Bun pragmas and ESM syntax', () => {
    expect(sourceKind('// @bun @bytecode\nvar a=1')).toBe('module');
    expect(sourceKind('// @bun @bytecode @bun-cjs\nvar a=1')).toBe('script');
    expect(sourceKind('#!/usr/bin/env node\n// @bun\nvar a')).toBe('module');
    expect(sourceKind('var a=1;import a from"x"')).toBe('module');
    expect(sourceKind('var a;export{a}')).toBe('module');
    expect(sourceKind('f(import.meta.url)')).toBe('module');
    expect(sourceKind('import("x").then(f)')).toBe('script');
    expect(sourceKind('x.import(1);y.export=2;var o={export:1}')).toBe(
      'script'
    );
    expect(sourceKind('function f(){return 1}')).toBe('script');
  });

  it('finds a "use strict" directive only in the prologue', () => {
    expect(hasUseStrictDirective('"use strict";var a')).toBe(true);
    expect(hasUseStrictDirective("'a';'use strict';var a")).toBe(true);
    expect(hasUseStrictDirective('/* c */"use strict"\nvar a')).toBe(true);
    expect(hasUseStrictDirective('function f(){"use strict"}', 13)).toBe(true);
    expect(hasUseStrictDirective('"use strict".length;var a')).toBe(false);
    expect(hasUseStrictDirective('var a;"use strict"')).toBe(false);
    expect(hasUseStrictDirective('"use\\x20strict";var a')).toBe(false);
  });
});

const at = (code, needle) => {
  const i = code.indexOf(needle);
  if (i < 0) throw new Error(`no ${needle}`);
  return i;
};

describe.skipIf(!parsers.node)('parseRegion: strict code stays strict', () => {
  const esm = body => mod(0, `import a from "x";${body}`);
  it.each([
    ['with', 'export function f(x){with(x){return y}}', 'return y'],
    ['delete of a name', 'export function f(x){delete x;return 1}', 'return 1'],
    [
      'a legacy octal escape',
      'export function f(x){return "\\033[0m"+x}',
      '+x',
    ],
    [
      'await in a plain function',
      'export async function g(){const h=function(){return await(1)};return h}',
      'return await',
    ],
  ])('fails %s inside an ESM module', (_, body, needle) => {
    const code = esm(body);
    const r = parseRegion(code, at(code, needle));
    expect(r.sourceKind).toBe('module');
    expect(r.verdict).toBe('failed');
  });

  it('treats a pragma-marked module as ESM', () => {
    const code = mod(0, '// @bun @bytecode\nfunction f(x){with(x){return y}}');
    expect(parseRegion(code, at(code, 'return y')).verdict).toBe('failed');
    const cjs = mod(0, '// @bun @bun-cjs\nfunction f(x){with(x){return y}}');
    expect(parseRegion(cjs, at(cjs, 'return y')).verdict).toBe('ok');
  });

  it('keeps a sloppy script sloppy', () => {
    const code = mod(0, 'function f(x){with(x){return y}}');
    expect(parseRegion(code, at(code, 'return y')).verdict).toBe('ok');
  });

  it('keeps a script strict under its "use strict" prologue', () => {
    const code = mod(0, '"use strict";function f(){with({}){}}');
    const r = parseRegion(code, at(code, 'with'));
    expect(r.sourceKind).toBe('script');
    expect(r.verdict).toBe('failed');
  });

  it('keeps code strict inside a class or a strict function', () => {
    const inClass = mod(0, 'class K{m(){return{n(){with(x){}}}}}');
    expect(parseRegion(inClass, at(inClass, 'with')).verdict).toBe('failed');
    const inFn = mod(
      0,
      'function g(){"use strict";return function(){with(x){}}}'
    );
    expect(parseRegion(inFn, at(inFn, 'with')).verdict).toBe('failed');
  });
});

describe.skipIf(!parsers.bun)('parseRegion: without a capable Node', () => {
  it('reports a Bun-only pass as unverified, not OK', () => {
    const code = mod(0, 'import a from "x";export function f(x){return x}');
    const r = parseRegion(code, at(code, 'return x'), { node: null });
    expect(r.verdict).toBe('unverified');
    expect(r.ok).toBe(false);
  });
});

describe.skipIf(!parsers.node)('parseRegion: enclosing constraints', () => {
  it('fails a second constructor that parses on its own', () => {
    const code = mod(0, 'class C{constructor(){}constructor(){let x=1;}}');
    const r = parseRegion(code, at(code, 'let x'));
    expect(r.results[0].ok).toBe(true);
    expect(r.verdict).toBe('failed');
    expect(r.region.kind).toBe('class');
  });

  it('fails a function whose name clashes with a binding beside it', () => {
    const code = mod(0, 'function g(){let h=1;function h(){return 2}return h}');
    const r = parseRegion(code, at(code, 'return 2'));
    expect(r.results[0].ok).toBe(true);
    expect(r.verdict).toBe('failed');
    expect(r.region.kind).toBe('function');
    expect(r.region.start).toBe(at(code, 'function g'));

    const top = mod(0, 'let q=1;function q(){return 2}');
    expect(parseRegion(top, at(top, 'return 2')).verdict).toBe('failed');
  });
});

const TOOL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'parseRegion.mjs'
);

describe('parseRegion: spans', () => {
  it('rejects a span that crosses a module boundary or leaves the bundle', () => {
    const from = at(BUNDLE, 'var a=1');
    expect(() =>
      parseRegion(BUNDLE, from, { end: at(BUNDLE, 'class K') + 1 })
    ).toThrow(/crosses the end of module \/\$bunfs\/root\/m0\.js/);
    expect(() => parseRegion(BUNDLE, from, { end: BUNDLE.length + 1 })).toThrow(
      RangeError
    );
  });

  it('exits 2 on such a span from the CLI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseRegion-test-'));
    try {
      const file = path.join(dir, 'b.js');
      fs.writeFileSync(file, BUNDLE);
      const run = (...args) =>
        spawnSync(process.execPath, [TOOL, file, ...args], {
          encoding: 'utf8',
        });
      const from = String(at(BUNDLE, 'var a=1'));
      const cross = run(from, '--end', String(at(BUNDLE, 'class K') + 1));
      expect(cross.status).toBe(2);
      expect(cross.stderr).toMatch(/crosses the end of module/);
      const past = run(from, '--end', String(BUNDLE.length + 5));
      expect(past.status).toBe(2);
      expect(past.stderr).toMatch(/past the end of the bundle/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
