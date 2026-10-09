#!/usr/bin/env node
// Sibling-arm gate: when one arm of a switch or ternary is a catalogued
// model-facing literal, every other arm that returns a literal is almost
// certainly model-facing too, so each must be catalogued or carry a verdict.
//
// Why this exists. The extractor finds prompts one literal at a time: a long
// string clears the prose gate, a short one only gets in through a cache
// verdict. A short arm whose verdict was never asked for therefore falls
// through silently, even when its sibling arm two cases up is catalogued. On CC
// 2.1.295 the `call_only` arm of the unreachable-attached-machines reminder
// ("${h} A call to ${s?"it":"one of them"} takes up to 10 seconds to fail and
// ${y}") was missed while its `rechecked` sibling was catalogued; only a
// cross-check against the upstream catalogue noticed. The artifact approval
// question builder had two more (`delete` and the unattended `public_change`
// arm) with every other case catalogued.
//
// A group is
//   - a `switch`: the literals returned from each of its cases (through `if`
//     blocks inside the case, ternary arms, array elements and `||`/`??`), or
//   - a returned ternary: the literal leaves of a conditional that is a
//     `return` argument or an arrow body.
// A group is checked only when one of its leaves is catalogued (a `model`
// cache verdict or a catalogue body). Each other leaf that has no verdict at
// all, is not catalogued, and reads as words (two or more outside `${}`) is a
// finding. Leaves that already carry a `ui`/`internal` verdict were ruled on
// and are not re-reported.
//
// Usage:
//   node tools/checkSiblingArms.mjs <cli.js> <prompts.json>
//     [--cache data/prompt-classification.json] [--json]
// Exit 0 = no finding, 1 = findings, 2 = usage error.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  buildEntries,
  describe,
  detectVersion,
  keyVariants,
} from './probeCacheKey.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const ex = require('./promptExtractor.js');
const { splitModuleBundle } = require('./lib/moduleBundle.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE = path.join(
  HERE,
  '..',
  'data',
  'prompt-classification.json'
);

const USAGE =
  'usage: node tools/checkSiblingArms.mjs <cli.js> <prompts.json> [--cache <classification.json>] [--json]';

const FN_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

function parseSegment(source) {
  const opts = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
  };
  try {
    return acorn.parse(source, { ...opts, sourceType: 'module' });
  } catch {
    return acorn.parse(source, { ...opts, sourceType: 'script' });
  }
}

function childNodes(n) {
  const out = [];
  for (const key in n) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const c = n[key];
    if (!c || typeof c !== 'object') continue;
    if (Array.isArray(c)) {
      for (const x of c) if (x && typeof x.type === 'string') out.push(x);
    } else if (typeof c.type === 'string') out.push(c);
  }
  return out;
}

const isLiteralLeaf = n =>
  (n.type === 'Literal' && typeof n.value === 'string') ||
  n.type === 'TemplateLiteral';

// The literal values an expression can evaluate to, looking through ternary
// arms, array elements, `||`/`??` operands and the tail of a comma list.
function leaves(n, out = []) {
  if (!n) return out;
  if (isLiteralLeaf(n)) out.push(n);
  else if (n.type === 'ConditionalExpression') {
    leaves(n.consequent, out);
    leaves(n.alternate, out);
  } else if (n.type === 'ArrayExpression') {
    for (const el of n.elements)
      if (el && el.type !== 'SpreadElement') leaves(el, out);
  } else if (n.type === 'LogicalExpression' && n.operator !== '&&') {
    leaves(n.left, out);
    leaves(n.right, out);
  } else if (n.type === 'SequenceExpression') leaves(n.expressions.at(-1), out);
  return out;
}

// Return arguments reachable from a case body without entering a nested
// function or a nested switch (which forms its own group).
function caseReturns(stmts) {
  const out = [];
  const stack = [...stmts];
  while (stack.length) {
    const n = stack.pop();
    if (
      !n ||
      FN_TYPES.has(n.type) ||
      n.type === 'SwitchStatement' ||
      n.type === 'ClassBody'
    )
      continue;
    if (n.type === 'ReturnStatement') {
      if (n.argument) out.push(n.argument);
      continue;
    }
    if (/Expression$/.test(n.type)) continue;
    stack.push(...childNodes(n));
  }
  return out;
}

// Is the top of a ternary chain returned? Climbs through the wrappers leaves()
// looks through, then requires a `return` or an arrow body.
function isReturned(node, parents) {
  let cur = node;
  let p = parents.get(cur);
  while (
    p &&
    (p.type === 'ArrayExpression' ||
      (p.type === 'LogicalExpression' && p.operator !== '&&') ||
      (p.type === 'SequenceExpression' && p.expressions.at(-1) === cur))
  ) {
    cur = p;
    p = parents.get(cur);
  }
  if (!p) return false;
  if (p.type === 'ReturnStatement') return true;
  return p.type === 'ArrowFunctionExpression' && p.body === cur;
}

// Every switch / returned-ternary group in `code`, as absolute literal ranges.
export function armGroups(code) {
  const segments = splitModuleBundle(code) || [
    { name: '', start: 0, source: code },
  ];
  const groups = [];
  for (const seg of segments) {
    let ast;
    try {
      ast = parseSegment(seg.source);
    } catch {
      continue;
    }
    const parents = new Map();
    const stack = [ast];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === 'SwitchStatement') {
        const arms = n.cases.flatMap(c =>
          caseReturns(c.consequent).flatMap(r => leaves(r))
        );
        if (arms.length > 1)
          groups.push({
            kind: 'switch',
            at: seg.start + n.start,
            arms: arms.map(a => [seg.start + a.start, seg.start + a.end]),
          });
      } else if (
        n.type === 'ConditionalExpression' &&
        parents.get(n)?.type !== 'ConditionalExpression' &&
        isReturned(n, parents)
      ) {
        const arms = leaves(n);
        if (arms.length > 1)
          groups.push({
            kind: 'ternary',
            at: seg.start + n.start,
            arms: arms.map(a => [seg.start + a.start, seg.start + a.end]),
          });
      }
      for (const c of childNodes(n)) {
        parents.set(c, n);
        stack.push(c);
      }
    }
  }
  return groups;
}

// Two or more words outside the `${…}` slots: an enum value, a bare slot or
// punctuation can be an arm but is never a prompt on its own.
export function readsAsWords(body) {
  let text = '';
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (depth === 0 && body[i] === '$' && body[i + 1] === '{') {
      depth = 1;
      i++;
      continue;
    }
    if (depth > 0) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') depth--;
      continue;
    }
    text += body[i];
  }
  return (text.match(/[A-Za-z]{2,}/g) || []).length >= 2;
}

function quietly(fn) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

// The scan proper. `catalogue` is the prompts array of a prompts JSON; `cache`
// the classification cache object.
export function scanSiblingArms(cliPath, { catalogue, cache, version } = {}) {
  const code = fs.readFileSync(cliPath, 'utf8');
  ex.setCcVersionForCacheLookups(version || detectVersion(cliPath, code));
  const records = quietly(() =>
    ex.collectLiteralSites(cliPath, { composites: true })
  );
  const byStart = new Map();
  for (const e of buildEntries(records)) {
    if (e.kind !== 'string' && e.kind !== 'template') continue;
    if (!byStart.has(e.start)) byStart.set(e.start, e);
  }
  const catalogued = new Map();
  for (const p of catalogue || []) {
    const body = (p.pieces || []).filter(x => typeof x === 'string').join('');
    for (const v of keyVariants(body))
      if (!catalogued.has(v.key)) catalogued.set(v.key, p.id);
  }
  const memo = new Map();
  const site = start => {
    if (memo.has(start)) return memo.get(start);
    const e = byStart.get(start);
    let r = null;
    if (e) {
      const d = describe(e, cache || {});
      const keys = keyVariants(e.cacheBody);
      const catId = keys.map(k => catalogued.get(k.key)).find(Boolean) || null;
      r = {
        start: e.start,
        end: e.end,
        kind: e.kind,
        body: e.cacheBody,
        key: keys[0]?.key,
        verdict: d.verdict,
        modelId:
          d.verdict?.facing === 'model'
            ? d.verdict.id || catId || '(unnamed)'
            : catId,
      };
    }
    memo.set(start, r);
    return r;
  };

  const groups = armGroups(code);
  const findings = [];
  const seen = new Set();
  let anchored = 0;
  let trivial = 0;
  for (const g of groups) {
    const arms = g.arms.map(([s]) => site(s)).filter(Boolean);
    const anchors = arms.filter(a => a.modelId);
    if (!anchors.length) continue;
    anchored++;
    for (const a of arms) {
      if (a.modelId || a.verdict || seen.has(a.start)) continue;
      if (!readsAsWords(a.body)) {
        trivial++;
        continue;
      }
      seen.add(a.start);
      findings.push({
        start: a.start,
        end: a.end,
        kind: a.kind,
        key: a.key,
        body: a.body,
        group: g.kind,
        groupAt: g.at,
        anchors: [...new Set(anchors.map(x => x.modelId))],
      });
    }
  }
  return { groups: groups.length, anchored, trivial, findings };
}

function parseArgs(argv) {
  const opt = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z]+)(?:=(.*))?$/);
    if (!m) opt.positional.push(argv[i]);
    else if (m[1] === 'json') opt.json = true;
    else if (m[1] === 'cache')
      opt.cache = m[2] !== undefined ? m[2] : argv[++i];
    else throw new Error(`unknown option --${m[1]}`);
  }
  if (opt.positional.length !== 2)
    throw new Error('need <cli.js> and <prompts.json>');
  return opt;
}

function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`checkSiblingArms: ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  const [cli, json] = opt.positional.map(p => path.resolve(p));
  for (const f of [cli, json]) {
    if (!fs.existsSync(f)) {
      console.error(`checkSiblingArms: no such file ${f}\n${USAGE}`);
      process.exit(2);
    }
  }
  const catalogue = JSON.parse(fs.readFileSync(json, 'utf8')).prompts || [];
  const cache = JSON.parse(
    fs.readFileSync(opt.cache ? path.resolve(opt.cache) : DEFAULT_CACHE, 'utf8')
  );
  const r = scanSiblingArms(cli, { catalogue, cache });
  if (opt.json) console.log(JSON.stringify(r, null, 1));
  else
    for (const f of r.findings)
      console.log(
        `SIBLING ${f.start}-${f.end} ${f.kind} raw=${f.key} ${f.group}@${f.groupAt} beside ${f.anchors.join(',')} ${JSON.stringify(f.body.length > 120 ? f.body.slice(0, 120) + '…' : f.body)}`
      );
  console.log(
    `sibling arms: ${r.findings.length} uncatalogued unclassified arm(s) in ${r.anchored} group(s) with a catalogued arm (${r.groups} switch/ternary groups scanned, ${r.trivial} non-prose arm(s) skipped)`
  );
  process.exit(r.findings.length ? 1 : 0);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
