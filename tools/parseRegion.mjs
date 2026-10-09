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
// the whole module, which carries all its own context. The first region both
// parsers accept is the verdict; when even the whole module fails, the error is
// real. A tokenizer failure or unbalanced brackets in the module skip straight
// to the whole module, so a bad splice can never be judged by a mis-cut region.
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
// followed by each parser's error. Exit 0 = OK, 1 = parse failure, 2 = usage.

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
    .map(o => ({ ...o.region, end: o.end }))
    .sort((a, b) => a.end - a.start - (b.end - b.start));
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
 * Parse-check each candidate `{ text, prefixLen, base }` with Bun and Node.
 * Returns per-candidate `{ ok, bun, node }`; `index` fields are bundle offsets.
 */
export const checkCandidates = (
  candidates,
  { bun = findBun(), node = findNode() } = {}
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseRegion-'));
  try {
    const files = [];
    candidates.forEach((c, i) => {
      const mjs = path.join(dir, `r${i}.mjs`);
      const cjs = path.join(dir, `r${i}.cjs`);
      fs.writeFileSync(mjs, c.text);
      fs.writeFileSync(cjs, c.text);
      files.push({ mjs, cjs });
    });
    let bunResults = null;
    if (bun) {
      const list = path.join(dir, 'list.json');
      const script = path.join(dir, 'check.cjs');
      fs.writeFileSync(list, JSON.stringify(files.map(f => f.mjs)));
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
        n = nodeCheck(node.bin, files[i].mjs, c.text);
        if (!n.ok) {
          const script = nodeCheck(node.bin, files[i].cjs, c.text);
          if (script.ok) n = script;
        }
        if (!n.ok) n = { ...n, index: toBundle(c, n.index) };
      }
      results.push({ ok: b.ok && n.ok, bun: b, node: n });
      if (b.ok && n.ok) break;
    }
    return results;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Check the code around `offset` (string index) of `code`. Returns
 * `{ ok, region, segment, tried, results, note }`, `region` holding bundle
 * offsets of the verdict region.
 */
export const parseRegion = (code, offset, opts = {}) => {
  const end = opts.end ?? offset;
  const wrapMode = opts.wrap || 'auto';
  const seg = segmentAt(code, offset);
  if (!seg) throw new Error(`offset ${offset} is outside the bundle`);
  const local = offset - seg.start;
  const localEnd = Math.min(end - seg.start, seg.source.length);

  let regions = [];
  let note = null;
  try {
    regions = enclosingRegions(seg.source, local, localEnd);
  } catch (e) {
    note = `module does not tokenize cleanly (${e.message.replace(/\d+/g, d =>
      String(Number(d) + seg.start)
    )}); checking the whole module`;
  }

  const whole = {
    kind: 'module',
    start: 0,
    end: seg.source.length,
    wrap: 'none',
  };
  let chain = [...regions, whole];
  if (wrapMode === 'none') chain = chain.slice(0, 1);

  const candidates = chain.map(r => {
    const [pre, post] = WRAPS[wrapMode === 'none' ? 'none' : r.wrap];
    const body = seg.source.slice(r.start, r.end);
    return {
      text: pre + body + post,
      prefixLen: pre.length,
      base: seg.start + r.start,
      length: body.length,
    };
  });
  const bun = opts.bun === undefined ? findBun() : opts.bun;
  const node = opts.node === undefined ? findNode() : opts.node;
  if (!bun && !node) throw new Error('neither bun nor a capable node found');
  const results = checkCandidates(candidates, { bun, node });
  const okAt = results.findIndex(r => r.ok);
  const at = okAt >= 0 ? okAt : 0;
  const r = chain[at];
  return {
    ok: okAt >= 0,
    region: {
      kind: r.kind,
      wrap: wrapMode === 'none' ? 'none' : r.wrap,
      start: seg.start + r.start,
      end: seg.start + r.end,
    },
    segment: {
      name: seg.name,
      start: seg.start,
      end: seg.start + seg.source.length,
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

  const offset = toIndex(Number(offsetArg));
  const end = endArg === null ? offset : toIndex(Number(endArg));
  if (offset > code.length || end < offset) {
    console.error(
      `parseRegion: offset out of range (bundle is ${code.length} chars)`
    );
    process.exit(2);
  }

  const res = parseRegion(code, offset, { end, wrap });
  const span = r => `${toOut(r.start)}-${toOut(r.end)}`;
  const parsers = res.parsers;
  if (res.note) console.log(`note: ${res.note}`);
  if (res.ok) {
    console.log(`region ${span(res.region)} parse OK`);
    console.log(
      `  ${res.region.kind} (wrap ${res.region.wrap}) in module ${res.segment.name}, ${parsers}` +
        (res.tried > 1
          ? `; ${res.tried - 1} smaller region(s) failed only for want of context`
          : '')
    );
    process.exit(0);
  }
  console.log(`region ${span(res.region)} parse FAILED`);
  const describe = (who, r, regionLabel) => {
    if (r.ok) return;
    const where = r.index === undefined ? '' : ` at ${toOut(r.index)}`;
    console.log(`  ${who} (${regionLabel}): ${r.message}${where}`);
  };
  const first = res.results[0];
  const last = res.results[res.results.length - 1];
  describe('bun', first.bun, res.region.kind);
  describe('node', first.node, res.region.kind);
  if (res.results.length > 1) {
    describe('bun', last.bun, `whole ${res.lastRegion.kind}`);
    describe('node', last.node, `whole ${res.lastRegion.kind}`);
  }
  console.log(`  module ${res.segment.name} ${span(res.segment)}, ${parsers}`);
  process.exit(1);
};

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
)
  main();
