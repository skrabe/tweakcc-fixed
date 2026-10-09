#!/usr/bin/env node
// Parse-check the code around one offset of a patched bundle, in seconds.
//
// A patch-fix agent that splices code into the 45 MB bundle needs to know the
// splice still parses. Parsing the whole bundle takes 10+ minutes under load
// and gigabytes of memory; the splice only touches one function. This tool
// finds the module holding the offset, tokenizes just that module to locate the
// smallest enclosing function (or method, or class), and has both runtimes'
// parsers check that region: Bun.Transpiler, because Bun is what runs Claude
// Code, and `node --check`.
//
// A region cut out of its module can fail for want of context alone: a private
// name declared by the enclosing class, `super()` outside its subclass. So each
// failure widens the region to the next enclosing function or class, ending at
// the whole module, which carries all its own context. The reverse holds too:
// cut out, a region sheds constraints its context puts on it (a second
// `constructor` in one class, a binding clashing with one beside it), so a
// region both parsers accept counts only once the next enclosing region parses
// as well; when even the whole module fails, the error is real. A tokenizer
// failure or unbalanced brackets in the module skip straight to the whole
// module, so a bad splice can never be judged by a mis-cut region.
//
// A region keeps its module's strictness: it is checked as ESM when its module
// is one (Bun's `// @bun` pragma without `@bun-cjs`, or ESM syntax), and as a
// script under a restated "use strict" when a script's prologue, an enclosing
// class, or an enclosing function's directive made it strict code.
//
// Usage:
//   node tools/parseRegion.mjs <bundle.js> <offset> [--end <offset>]
//     [--wrap auto|none] [--bytes]
//
//   <offset>   string index of the splice (what a patch writer's match.index
//              and showDiff report); --bytes reads it as a UTF-8 byte offset
//              (what `grep -b` reports) and prints byte offsets back.
//   --end      the splice's end; the region must cover [offset, end).
//   --wrap     auto (default) widens on failure as described above; none
//              checks only the smallest region and reports its own result.
//
// Prints `region <start>-<end> parse OK`, or `region <start>-<end> parse FAILED`
// followed by each parser's error. Exit 0 = OK, 1 = parse failure, 2 = usage
// (including a span that leaves its module or the bundle), 3 = unverified: no
// Node that parses current syntax was found, and Bun alone enforces no
// strict-mode or early errors.

import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const { splitModuleBundle } = require('./lib/moduleBundle.cjs');

const tt = acorn.tokTypes;

const TOKENIZER_OPTIONS = {
  ecmaVersion: 'latest',
  allowHashBang: true,
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowImportExportEverywhere: true,
};

const OPENERS = new Map([
  [tt.braceL, '}'],
  [tt.dollarBraceL, '}'],
  [tt.parenL, ')'],
  [tt.bracketL, ']'],
]);
const CLOSERS = new Map([
  [tt.braceR, '}'],
  [tt.parenR, ')'],
  [tt.bracketR, ']'],
]);

const METHOD_MODIFIERS = new Set(['static', 'async', 'get', 'set']);

// Keywords whose `(...)` opens a block, never a method of that name.
const BLOCK_KEYWORDS = new Set([
  tt._if,
  tt._for,
  tt._while,
  tt._switch,
  tt._catch,
  tt._with,
]);

const isName = (tok, value) =>
  tok && tok.type === tt.name && (value === undefined || tok.value === value);

const isKey = tok =>
  tok &&
  (tok.type === tt.name ||
    tok.type === tt.privateId ||
    tok.type === tt.string ||
    tok.type === tt.num ||
    tok.type.keyword !== undefined ||
    tok.type === tt.bracketR);

/** The module of a (possibly virtual) bundle that holds `offset`. */
export const segmentAt = (code, offset) => {
  const segments = splitModuleBundle(code) || [
    { name: '<bundle>', start: 0, source: code },
  ];
  return (
    segments.find(
      s => offset >= s.start && offset <= s.start + s.source.length
    ) || null
  );
};

// For a `{` preceded by `prev` inside `container`: where the function whose
// body it opens starts, and how to wrap that function so it parses on its own;
// null when the brace opens a plain block or literal.
const functionHead = (prev, container) => {
  if (!prev) return null;
  if (prev.type === tt.arrow) {
    const params = prev.before;
    if (!params) return null;
    let start = params.type === tt.parenR ? params.open.start : params.start;
    const lead =
      params.type === tt.parenR ? params.open.before.at(-1) : params.prior;
    if (isName(lead, 'async')) start = lead.start;
    return { kind: 'arrow', start, wrap: 'paren' };
  }
  if (prev.type !== tt.parenR) return null;
  const before = prev.open.before;
  const b1 = before.at(-1);
  const b2 = before.at(-2);
  const b3 = before.at(-3);
  let fn = null;
  if (b1 && b1.type === tt._function) fn = b1;
  else if (b1 && b1.type === tt.star && b2 && b2.type === tt._function) fn = b2;
  else if (isKey(b1) && b2 && b2.type === tt._function) fn = b2;
  else if (
    isKey(b1) &&
    b2 &&
    b2.type === tt.star &&
    b3 &&
    b3.type === tt._function
  )
    fn = b3;
  if (fn) {
    const idx = before.indexOf(fn);
    const lead = before[idx - 1];
    const start = isName(lead, 'async') ? lead.start : fn.start;
    return { kind: 'function', start, wrap: 'paren' };
  }
  if (!isKey(b1) || BLOCK_KEYWORDS.has(b1.type)) return null;
  if (!container || container.type !== tt.braceL) return null;
  const computed = b1.type === tt.bracketR;
  let start = computed ? b1.open.start : b1.start;
  const lead = computed ? b1.open.before : before.slice(0, -1);
  for (let i = lead.length - 1; i >= 0; i -= 1) {
    const t = lead[i];
    if (t.type === tt.star || (isName(t) && METHOD_MODIFIERS.has(t.value)))
      start = t.start;
    else break;
  }
  return {
    kind: 'method',
    start,
    wrap: container && container.classBody ? 'class' : 'object',
  };
};

/**
 * Tokenize `source` and return the regions enclosing [offset, end), innermost
 * first, each `{ kind, start, end, wrap }` in source positions. Throws when the
 * source does not tokenize or its brackets do not balance.
 */
export const enclosingRegions = (source, offset, end = offset) => {
  const stack = [];
  const recent = [];
  const pendingClasses = [];
  const straddling = [];
  let snapshot = null;

  const take = sourceType => {
    const tokens = acorn.tokenizer(source, {
      ...TOKENIZER_OPTIONS,
      sourceType,
    });
    for (;;) {
      const raw = tokens.getToken();
      if (raw.type === tt.eof) break;
      const tok = {
        type: raw.type,
        value: raw.value,
        start: raw.start,
        end: raw.end,
      };
      if (!snapshot && tok.end > offset) snapshot = stack.slice();

      // `class` opens a class only when a name, `extends` or the body
      // follows; `x.class` and `{class:1}` are property names.
      const pc = pendingClasses.at(-1);
      if (pc && pc.next === undefined) {
        pc.next = tok.type;
        if (![tt.name, tt._extends, tt.braceL].includes(tok.type))
          pendingClasses.pop();
      }
      const last = recent.at(-1);
      if (
        tok.type === tt._class &&
        !(last && (last.type === tt.dot || last.type === tt.questionDot))
      ) {
        pendingClasses.push({ start: tok.start, depth: stack.length });
      }
      if (tok.type === tt.arrow) {
        tok.before = recent.at(-1);
        if (tok.before) tok.before.prior = recent.at(-2);
      }

      const closes = OPENERS.get(tok.type);
      if (closes) {
        const open = {
          type: tok.type,
          start: tok.start,
          closes,
          before: recent.slice(-5),
          region: null,
          end: -1,
        };
        if (tok.type === tt.braceL) {
          const pc = pendingClasses.at(-1);
          if (pc && pc.depth === stack.length) {
            pendingClasses.pop();
            open.classBody = true;
            open.region = { kind: 'class', start: pc.start, wrap: 'paren' };
          } else {
            const head = functionHead(recent.at(-1), stack.at(-1));
            if (head) open.region = head;
          }
          // A function whose head starts before the offset and whose body
          // opens after it (a splice into its parameters) still encloses it.
          if (open.region && open.region.start <= offset && tok.start >= offset)
            straddling.push(open);
        }
        stack.push(open);
        tok.open = open;
      } else {
        const want = CLOSERS.get(tok.type);
        if (want) {
          const open = stack.pop();
          if (!open || open.closes !== want) {
            const err = new Error(
              `unbalanced '${want}' at ${tok.start}` +
                (open ? ` (open '${open.closes}' from ${open.start})` : '')
            );
            err.pos = tok.start;
            throw err;
          }
          open.end = tok.end;
          tok.open = open;
        }
      }
      recent.push(tok);
      if (recent.length > 8) recent.shift();
    }
    if (stack.length) {
      const open = stack.at(-1);
      const err = new Error(
        `unclosed bracket opened at ${open.start} (expects '${open.closes}')`
      );
      err.pos = open.start;
      throw err;
    }
  };

  try {
    take('module');
  } catch (moduleErr) {
    stack.length = 0;
    recent.length = 0;
    pendingClasses.length = 0;
    straddling.length = 0;
    snapshot = null;
    try {
      take('script');
    } catch {
      throw moduleErr;
    }
  }

  return [...(snapshot || []), ...straddling]
    .filter(o => o.region && o.end >= end)
    .map(o => ({
      ...o.region,
      end: o.end,
      useStrict:
        o.region.kind !== 'class' && hasUseStrictDirective(source, o.start + 1),
    }))
    .sort((a, b) => a.end - a.start - (b.end - b.start));
};

const SKIP_TRIVIA = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
const STRING_LITERAL =
  /"((?:[^"\\\n\r]|\\[\s\S])*)"|'((?:[^'\\\n\r]|\\[\s\S])*)'/y;

/**
 * Whether the directive prologue starting at `at` (a function body just past
 * its `{`, or a source's start) holds an exact `"use strict"` directive.
 */
export const hasUseStrictDirective = (source, at = 0) => {
  let i = at;
  if (i === 0 && source.startsWith('#!'))
    i = source.indexOf('\n') + 1 || source.length;
  for (;;) {
    SKIP_TRIVIA.lastIndex = i;
    SKIP_TRIVIA.exec(source);
    STRING_LITERAL.lastIndex = SKIP_TRIVIA.lastIndex;
    const m = STRING_LITERAL.exec(source);
    if (!m) return false;
    SKIP_TRIVIA.lastIndex = STRING_LITERAL.lastIndex;
    const gap = SKIP_TRIVIA.exec(source)[0];
    const j = SKIP_TRIVIA.lastIndex;
    const next = source[j];
    // A string followed by anything but `;`, `}`, the end, or a new statement
    // on the next line is an expression, which ends the prologue.
    const ends =
      next === undefined ||
      next === ';' ||
      next === '}' ||
      (gap.includes('\n') && /[\w$"'{]/.test(next));
    if (!ends) return false;
    if ((m[1] ?? m[2]) === 'use strict') return true;
    if (next !== ';') return false;
    i = j + 1;
  }
};

/**
 * How Bun loads `source`: 'module' (ESM, strict throughout) or 'script'.
 * Bun's compiled output carries a `// @bun` pragma on every module, with
 * `@bun-cjs` on a CommonJS one; without a pragma, ESM syntax decides.
 */
export const sourceKind = source => {
  const head = source.slice(0, 4096).replace(/^#![^\n]*\n/, '');
  const pragma = head.match(/^\s*\/\/ *@bun\b([^\n]*)/);
  if (pragma) return /@bun-cjs\b/.test(pragma[1]) ? 'script' : 'module';
  // A depth-0 `export`, or a depth-0 `import` that is not `import(`, is a
  // declaration; `import.meta` is module-only anywhere.
  const recent = [];
  let depth = 0;
  try {
    for (const tok of acorn.tokenizer(source, {
      ...TOKENIZER_OPTIONS,
      sourceType: 'script',
    })) {
      const b1 = recent.at(-1);
      const b2 = recent.at(-2);
      const member = b2 && (b2.type === tt.dot || b2.type === tt.questionDot);
      if (b1 && b1.type === tt._import && !member) {
        if (tok.type === tt.dot) return 'module';
        if (b1.depth === 0 && tok.type !== tt.parenL) return 'module';
      }
      if (b1 && b1.type === tt._export && b1.depth === 0 && !member)
        return 'module';
      if (OPENERS.has(tok.type)) depth++;
      else if (CLOSERS.has(tok.type)) depth--;
      recent.push({ type: tok.type, depth });
      if (recent.length > 2) recent.shift();
    }
  } catch {
    return /^\s*(?:import\s*[\w${*"']|export\s*[\w${*])/m.test(source) ||
      /\bimport\.meta\b/.test(source)
      ? 'module'
      : 'script';
  }
  return 'script';
};

const WRAPS = {
  none: ['', ''],
  paren: ['(', '\n)'],
  object: ['({', '\n})'],
  class: ['(class{', '\n})'],
};

const lineColToIndex = (text, line, col) => {
  let at = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return text.length;
    at = nl + 1;
  }
  return at + col;
};

const BUN_CHECKER = `
const fs = require('fs');
const t = new Bun.Transpiler({ loader: 'js' });
const out = [];
for (const file of JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))) {
  try { t.transformSync(fs.readFileSync(file, 'utf8')); out.push({ ok: true }); }
  catch (e) {
    const first = (e.errors && e.errors[0]) || e;
    const p = first.position || {};
    out.push({ ok: false, message: String(first.message || e.message),
      line: p.line, column: p.column === undefined ? undefined : p.column - 1 });
  }
}
process.stdout.write(JSON.stringify(out));
`;

export const findBun = () => {
  const candidates = [
    process.env.BUN,
    path.join(os.homedir(), '.bun', 'bin', 'bun'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const r = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? 'bun' : null;
};

// Claude Code ships syntax older Node lacks (`await using`, Node 24+), so a
// Node that cannot parse it would fail every module that holds it. Use the
// first Node that can, newest mise install last resort.
const NODE_PROBE = 'async function f(){await using r=x}\n';

const nodeVersions = () => {
  const root = path.join(os.homedir(), '.local/share/mise/installs/node');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root).filter(d => /^\d+\.\d+\.\d+$/.test(d));
  } catch {
    return [];
  }
  const key = v => v.split('.').map(Number);
  dirs.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  return dirs.map(d => path.join(root, d, 'bin', 'node'));
};

let nodeChoice;
export const findNode = () => {
  if (nodeChoice !== undefined) return nodeChoice;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseRegion-probe-'));
  try {
    const probe = path.join(dir, 'probe.mjs');
    fs.writeFileSync(probe, NODE_PROBE);
    const candidates = [
      process.env.PARSE_REGION_NODE,
      process.execPath,
      'node',
      ...nodeVersions(),
    ].filter(Boolean);
    nodeChoice = null;
    for (const bin of candidates) {
      const r = spawnSync(bin, ['--check', probe], { stdio: 'ignore' });
      if (r.status === 0) {
        const v = spawnSync(bin, ['--version'], { encoding: 'utf8' });
        nodeChoice = { bin, version: (v.stdout || '').trim() };
        break;
      }
    }
    return nodeChoice;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const nodeCheck = (bin, file, text) => {
  // A syntax error echoes its whole source line, which on a minified module
  // runs to megabytes and is cut short in a pipe: capture it through a file.
  const errFile = `${file}.err`;
  const fd = fs.openSync(errFile, 'w');
  let status;
  try {
    status = spawnSync(bin, ['--check', file], {
      stdio: ['ignore', 'ignore', fd],
    }).status;
  } finally {
    fs.closeSync(fd);
  }
  if (status === 0) return { ok: true };
  const err = fs.readFileSync(errFile, 'utf8');
  const m = err.match(/:(\d+)\n([^\n]*)\n(\s*)\^/);
  const msg = (err.match(/^SyntaxError: .*$/m) || [err.trim()])[0];
  if (!m) return { ok: false, message: msg };
  return {
    ok: false,
    message: msg,
    index: lineColToIndex(text, Number(m[1]), m[3].length),
  };
};

/**
 * Parse-check candidates `{ text, prefixLen, base, length, kind }`, innermost
 * first, with Bun and Node; `kind` 'module' checks as ESM, 'script' as
 * CommonJS. Returns per-candidate `{ ok, bun, node }` for those tried;
 * `index` fields are bundle offsets.
 *
 * A region cut out of its context drops the constraints that context puts on
 * it: a second `constructor` in the class, a binding that clashes with one
 * beside it. So an OK counts only once the next enclosing candidate parses
 * too (or it is the last one); checking stops there.
 */
export const checkCandidates = (
  candidates,
  { bun = findBun(), node = findNode() } = {}
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseRegion-'));
  try {
    const files = candidates.map((c, i) => {
      const file = path.join(
        dir,
        `r${i}.${c.kind === 'module' ? 'mjs' : 'cjs'}`
      );
      fs.writeFileSync(file, c.text);
      return file;
    });
    let bunResults = null;
    if (bun) {
      const list = path.join(dir, 'list.json');
      const script = path.join(dir, 'check.cjs');
      fs.writeFileSync(list, JSON.stringify(files));
      fs.writeFileSync(script, BUN_CHECKER);
      bunResults = JSON.parse(
        execFileSync(bun, [script, list], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        })
      );
    }
    const toBundle = (c, idx) =>
      idx === undefined
        ? undefined
        : c.base + Math.max(0, Math.min(idx - c.prefixLen, c.length));
    const results = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      let b = bunResults ? bunResults[i] : { ok: true, skipped: true };
      if (b && !b.ok && b.line !== undefined) {
        b = {
          ...b,
          index: toBundle(c, lineColToIndex(c.text, b.line, b.column ?? 0)),
        };
      }
      let n = { ok: true, skipped: true };
      if (node) {
        n = nodeCheck(node.bin, files[i], c.text);
        if (!n.ok) n = { ...n, index: toBundle(c, n.index) };
      }
      const ok = b.ok && n.ok;
      results.push({ ok, bun: b, node: n });
      if (ok && (i === candidates.length - 1 || (i > 0 && results[i - 1].ok)))
        break;
    }
    return results;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Check the code around `offset` (string index) of `code`; `opts.end` is the
 * splice's end, which must lie in the same module. Returns `{ ok, verdict,
 * region, smallest, segment, tried, results, note }`: `verdict` is 'ok',
 * 'failed', or 'unverified' (Bun alone accepted it; Bun's transpiler enforces
 * no strict-mode or early errors, so only Node's agreement makes it an OK).
 * `region` holds bundle offsets of the widest region checked on an OK, the
 * smallest failing one on a failure. Throws a RangeError for a span outside
 * the bundle or crossing a module boundary.
 */
export const parseRegion = (code, offset, opts = {}) => {
  const end = opts.end ?? offset;
  const show = opts.formatOffset || (i => String(i));
  if (!(offset >= 0 && offset <= code.length))
    throw new RangeError(
      `offset ${show(offset)} is outside the bundle (it ends at ${show(code.length)})`
    );
  if (!(end >= offset && end <= code.length))
    throw new RangeError(
      `end ${show(end)} must lie between the offset ${show(offset)} and the bundle's end ${show(code.length)}`
    );
  const wrapMode = opts.wrap || 'auto';
  const seg = segmentAt(code, offset);
  if (!seg)
    throw new RangeError(
      `offset ${show(offset)} is not inside a module (it is in a module sentinel or the bundle header)`
    );
  const segEnd = seg.start + seg.source.length;
  if (end > segEnd)
    throw new RangeError(
      `span ${show(offset)}-${show(end)} crosses the end of module ${seg.name} at ${show(segEnd)}; check each module's part of the splice on its own`
    );
  const local = offset - seg.start;
  const localEnd = end - seg.start;

  let regions = [];
  let note = null;
  try {
    regions = enclosingRegions(seg.source, local, localEnd);
  } catch (e) {
    note = `module does not tokenize cleanly (${e.message.replace(/\d+/g, d =>
      show(Number(d) + seg.start)
    )}); checking the whole module`;
  }

  const kind = sourceKind(seg.source);
  const strictPrologue =
    kind === 'script' && hasUseStrictDirective(seg.source, 0);
  const whole = {
    kind: 'module',
    start: 0,
    end: seg.source.length,
    wrap: 'none',
  };
  let chain = [...regions, whole];
  if (wrapMode === 'none') chain = chain.slice(0, 1);

  const candidates = chain.map((r, i) => {
    const [pre, post] = WRAPS[wrapMode === 'none' ? 'none' : r.wrap];
    // Cut out of a module, a class, or a function or script under "use
    // strict", a script region is strict code only if it says so again.
    const strict =
      kind === 'script' &&
      r !== whole &&
      (strictPrologue ||
        chain.slice(i + 1).some(o => o.kind === 'class' || o.useStrict));
    const lead = (strict ? '"use strict";' : '') + pre;
    const body = seg.source.slice(r.start, r.end);
    return {
      text: lead + body + post,
      prefixLen: lead.length,
      base: seg.start + r.start,
      length: body.length,
      kind,
    };
  });
  const bun = opts.bun === undefined ? findBun() : opts.bun;
  const node = opts.node === undefined ? findNode() : opts.node;
  if (!bun && !node) throw new Error('neither bun nor a capable node found');
  const results = checkCandidates(candidates, { bun, node });
  const passed = results[results.length - 1].ok;
  const at = passed ? results.length - 1 : results.findIndex(r => !r.ok);
  const verdict = !passed ? 'failed' : node ? 'ok' : 'unverified';
  const toBundleRegion = r => ({
    kind: r.kind,
    wrap: wrapMode === 'none' ? 'none' : r.wrap,
    start: seg.start + r.start,
    end: seg.start + r.end,
  });
  return {
    ok: verdict === 'ok',
    verdict,
    region: toBundleRegion(chain[at]),
    smallest: toBundleRegion(chain[0]),
    regionIndex: at,
    sourceKind: kind,
    segment: {
      name: seg.name,
      start: seg.start,
      end: segEnd,
    },
    tried: results.length,
    results,
    lastRegion: chain[results.length - 1],
    note,
    parsers: [
      bun ? 'bun' : 'bun not found',
      node ? `node ${node.version}` : 'no node that parses `await using`',
    ].join(' + '),
  };
};

const main = () => {
  const args = process.argv.slice(2);
  const flag = name => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const bytes = args.includes('--bytes');
  if (bytes) args.splice(args.indexOf('--bytes'), 1);
  const endArg = flag('--end');
  const wrap = flag('--wrap') || 'auto';
  const [bundlePath, offsetArg] = args;
  const usage =
    'usage: node tools/parseRegion.mjs <bundle.js> <offset> [--end <offset>] [--wrap auto|none] [--bytes]';
  if (
    !bundlePath ||
    !/^\d+$/.test(offsetArg || '') ||
    (endArg !== null && !/^\d+$/.test(endArg)) ||
    !['auto', 'none'].includes(wrap)
  ) {
    console.error(usage);
    process.exit(2);
  }
  if (!fs.existsSync(bundlePath)) {
    console.error(`parseRegion: missing ${bundlePath}`);
    process.exit(2);
  }
  const buf = fs.readFileSync(bundlePath);
  const code = buf.toString('utf8');
  const toIndex = n => (bytes ? buf.subarray(0, n).toString('utf8').length : n);
  const toOut = i => (bytes ? Buffer.byteLength(code.slice(0, i), 'utf8') : i);
  const limit = bytes ? buf.length : code.length;
  const unit = bytes ? 'bytes' : 'chars';
  for (const [label, v] of [
    ['offset', offsetArg],
    ['--end', endArg],
  ]) {
    if (v !== null && Number(v) > limit) {
      console.error(
        `parseRegion: ${label} ${v} is past the end of the bundle (${limit} ${unit})`
      );
      process.exit(2);
    }
  }

  const offset = toIndex(Number(offsetArg));
  const end = endArg === null ? offset : toIndex(Number(endArg));
  if (end < offset) {
    console.error(`parseRegion: --end ${endArg} is before the offset`);
    process.exit(2);
  }

  let res;
  try {
    res = parseRegion(code, offset, {
      end,
      wrap,
      formatOffset: i => String(toOut(i)),
    });
  } catch (e) {
    console.error(`parseRegion: ${e.message}`);
    process.exit(2);
  }
  const span = r => `${toOut(r.start)}-${toOut(r.end)}`;
  const where = `in ${res.sourceKind} ${res.segment.name}, ${res.parsers}`;
  if (res.note) console.log(`note: ${res.note}`);
  if (res.verdict !== 'failed') {
    const contextOnly = res.results.filter(r => !r.ok).length;
    console.log(
      `region ${span(res.region)} parse ${res.ok ? 'OK' : 'UNVERIFIED'}`
    );
    console.log(
      `  ${res.region.kind} (wrap ${res.region.wrap}) ${where}` +
        (res.tried > 1
          ? `; smallest region ${res.smallest.kind} ${span(res.smallest)}` +
            (contextOnly
              ? `, ${contextOnly} region(s) failed only for want of context`
              : '')
          : '')
    );
    if (res.ok) process.exit(0);
    console.log(
      '  only Bun checked it, and Bun does not enforce strict-mode or early errors; ' +
        'install a Node that parses `await using` (24+) or set PARSE_REGION_NODE'
    );
    process.exit(3);
  }
  console.log(`region ${span(res.region)} parse FAILED`);
  const describe = (who, r, regionLabel) => {
    if (r.ok) return;
    const at = r.index === undefined ? '' : ` at ${toOut(r.index)}`;
    console.log(`  ${who} (${regionLabel}): ${r.message}${at}`);
  };
  const first = res.results[res.regionIndex];
  const last = res.results[res.results.length - 1];
  describe('bun', first.bun, res.region.kind);
  describe('node', first.node, res.region.kind);
  if (last !== first) {
    describe('bun', last.bun, `whole ${res.lastRegion.kind}`);
    describe('node', last.node, `whole ${res.lastRegion.kind}`);
  }
  console.log(`  ${where.slice(3)} ${span(res.segment)}`);
  process.exit(1);
};

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
)
  main();
