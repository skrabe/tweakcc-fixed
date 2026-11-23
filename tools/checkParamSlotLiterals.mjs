#!/usr/bin/env node
/**
 * Param-slot literal gate — model-facing prose that reaches the model as a
 * CALL-SITE ARGUMENT to a builder whose template is already catalogued.
 *
 * Three gates already look for uncatalogued model-facing text, and all three
 * are blind to this shape:
 *
 *   - the prose gate in `promptExtractor` judges each string node alone, and
 *     these are short with a bare `fn(` lead, so they never clear the bar;
 *   - `detectionCoverage` assembles multi-NODE composites (`a+b`, `[…].join`),
 *     and each of these is a single node;
 *   - `checkSlotLiterals` walks a catalogued prompt's slots, but only resolves
 *     an expression that is a literal or a nearby declarator. When the slot
 *     expression is a PARAMETER of the enclosing function, the values live at
 *     that function's call sites, which it never visits.
 *
 * Found on CC 2.1.238 in the bash worktree isolation guard:
 *
 *   let i = (g, y = `Run the equivalent from ${r} without the redirect.`) =>
 *     `${n} is isolated in the worktree ${r}, but this command ${g}. Refusing…`;
 *   …
 *   return i("is too complex to verify that it stays inside the worktree", s);
 *
 * The template IS catalogued. `${g}` is a parameter. 17 of the 21 refusal
 * clauses passed the prose gate on length alone and were catalogued; the other
 * four were invisible — and two of those had HELD ids at 2.1.237, losing them
 * when Anthropic split the remedy clause into its own variable. The same shape
 * hides three credential-source phrases and three remedies naming exact env
 * vars and commands behind `tool-result-artifact-login-blocked-by-credential`.
 *
 * Facing is not the question, exactly as in `checkSlotLiterals`: the enclosing
 * template is a catalogued prompt by construction, so anything a slot renders
 * is text the model receives. The question is whether the literal carries
 * something the model acts on.
 *
 *   catalogue   an instruction, a constraint, a name the model must reproduce
 *   glue        labels or joins an interpolated value; nothing to override
 *   not-a-slot  a resolution artifact — this text is not really in the slot
 *   off-route   really in the slot, but every path from this call site drops
 *               or catches the result before the model sees it
 *
 * Verdicts are content-hash keyed in data/param-slot-allowlist.json, so they
 * are version-independent: reviewing a literal once keeps it quiet forever and
 * only genuinely-new prose fires on a bump.
 *
 * Unlike `checkSlotLiterals`, a `catalogue` verdict here does NOT land by
 * itself — the extractor has no hook for a call-site argument. Record a
 * `{"facing":"model", id/name/desc}` entry in data/prompt-classification.json
 * instead, which short-circuits the prose gate on the next extraction. Get the
 * key by probing with TWEAKCC_DUMP_CANDIDATES, never by guessing: the cache is
 * keyed on what the extractor hashes, which for a template is the body with the
 * identifier stripped out of every `${…}`.
 *
 * Usage:
 *   node tools/checkParamSlotLiterals.mjs <cli.js> <prompts.json> [--update-allowlist]
 *
 * Exit: 0 all reviewed · 1 unreviewed findings · 2 could not run.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const parser = require('@babel/parser');
const {
  splitModuleBundle,
  parseModuleSegment,
} = require('./lib/moduleBundle.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALLOWLIST = path.resolve(HERE, '../data/param-slot-allowlist.json');

// Shorter than this and a literal cannot carry an instruction; it is a label,
// a separator or a pluralisation. Measured on 2.1.238: at 20 the gate reports
// 7 findings and all 7 were genuine, so the bar is not costing recall.
const MIN_LEN = 20;
// Long enough to identify the literal inside a catalogued body without matching
// half the corpus.
const PROBE_LEN = 40;

const die = (msg, code = 2) => {
  console.error(msg);
  process.exit(code);
};

// `pieces` are the literal text around each substitution; joining them is the
// same form the extractor hashes, so it is what a catalogued body looks like.
const pieceJoin = p => (p.pieces || []).filter(x => typeof x === 'string').join('');

const PARSE_OPTIONS = { sourceType: 'unambiguous', errorRecovery: true };

// A literal argument, in the same form the extractor would hash it: a template
// keeps its structure with the identifier stripped from every substitution.
const literalOf = arg => {
  if (!arg) return null;
  if (arg.type === 'StringLiteral') return arg.value;
  if (arg.type === 'TemplateLiteral') {
    return arg.quasis.map(q => q.value.cooked ?? '').join('${}');
  }
  return null;
};

// A body with every substitution emptied to `${}`: pieces keep the remainder of
// each slot expression (`${.name}`), quasis keep nothing, so this is the one
// form a template and its catalogued prompt share.
const emptySlots = body => {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '$' && body[i + 1] === '{' && body[i - 1] !== '\\') {
      let depth = 1;
      let j = i + 2;
      for (; j < body.length && depth; j += 1) {
        if (body[j] === '{') depth += 1;
        else if (body[j] === '}') depth -= 1;
      }
      out += '${}';
      i = j - 1;
    } else out += body[i];
  }
  return out;
};

const hash = text =>
  crypto.createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

// Content hash -> {text, sites}: every builder/param a literal is passed to.
export function findParamSlotLiterals(src, prompts) {
  // Two different questions, two different sets. Deciding whether a TEMPLATE is
  // catalogued needs a 30-char head to match on, so short bodies are useless
  // there. Deciding whether a LITERAL is already catalogued in its own right must
  // consider every body at any length — `data-chrome-image-not-inlined-decode-
  // failed` is 20 characters, and filtering it out of the membership set made the
  // gate re-report a prompt it had just catalogued.
  const withIds = prompts.filter(p => p.id);
  const allBodies = withIds.map(pieceJoin);
  const catAll = allBodies.join('\n\n');
  // A template is admitted on a 30-char head match. Its host is the catalogued
  // prompt whose slot-emptied body it reproduces, else every prompt sharing
  // that head.
  const byHead = new Map();
  const byShape = new Map();
  const index = (map, k, id) => {
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(id);
  };
  withIds.forEach((p, i) => {
    if (allBodies[i].length > 30) index(byHead, allBodies[i].slice(0, 30), p.id);
    index(byShape, emptySlots(allBodies[i]), p.id);
  });
  const hostsOf = node => {
    const cooked = node.quasis.map(q => q.value.cooked ?? '');
    const heads = [cooked.join('${}'), cooked.join('')].flatMap(b => [
      ...(byHead.get(b.slice(0, 30)) || []),
    ]);
    if (!heads.length) return [];
    for (const qs of [cooked, node.quasis.map(q => q.value.raw)]) {
      const exact = byShape.get(qs.join('${}'));
      if (exact) return [...exact].sort();
    }
    return [...new Set(heads)].sort();
  };
  const findings = new Map();

  const ingest = ast => {
    const templates = [];
    const fnByName = new Map();
    const calls = [];

    const walk = (node, chain) => {
      if (!node || typeof node.type !== 'string') return;
      const isFn = /Function/.test(node.type);
      const next = isFn ? [...chain, node] : chain;
      if (node.type === 'TemplateLiteral') templates.push({ node, chain: next });
      if (
        node.type === 'VariableDeclarator' &&
        node.id?.type === 'Identifier' &&
        node.init &&
        /Function/.test(node.init.type)
      ) {
        fnByName.set(node.id.name, node.init);
      }
      if (node.type === 'FunctionDeclaration' && node.id) fnByName.set(node.id.name, node);
      if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') calls.push(node);
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
        const v = node[key];
        if (Array.isArray(v)) {
          for (const c of v) if (c && typeof c.type === 'string') walk(c, next);
        } else if (v && typeof v.type === 'string') walk(v, next);
      }
    };
    walk(ast, []);

    const nameByFn = new Map([...fnByName].map(([k, v]) => [v, k]));
    const callsByName = new Map();
    for (const c of calls) {
      const list = callsByName.get(c.callee.name);
      if (list) list.push(c);
      else callsByName.set(c.callee.name, [c]);
    }

    for (const { node, chain } of templates) {
      const hosts = hostsOf(node);
      if (!hosts.length) continue;

      for (const expr of node.expressions) {
        if (expr.type !== 'Identifier') continue;
        // Innermost enclosing function that declares this name as a parameter.
        for (let d = chain.length - 1; d >= 0; d -= 1) {
          const fn = chain[d];
          const idx = (fn.params || []).findIndex(
            p => p.type === 'Identifier' && p.name === expr.name
          );
          if (idx === -1) continue;
          const fname = nameByFn.get(fn);
          if (fname) {
            for (const call of callsByName.get(fname) || []) {
              const lit = literalOf(call.arguments[idx]);
              if (lit === null) continue;
              const trimmed = lit.trim();
              if (trimmed.length < MIN_LEN) continue;
              // Already in the catalogue in its own right? Then nothing to report.
              const probe = (lit.split('${}')[0] || lit).trim().slice(0, PROBE_LEN);
              if (probe.length < MIN_LEN || catAll.includes(probe)) continue;
              const key = hash(lit);
              if (!findings.has(key)) findings.set(key, { text: lit, sites: [] });
              const f = findings.get(key);
              const site = {
                hosts,
                builder: fname,
                param: expr.name,
                paramIndex: idx,
                offset: call.start,
              };
              const same = s =>
                s.hosts.join() === hosts.join() &&
                s.builder === fname &&
                s.param === expr.name;
              if (!f.sites.some(same)) f.sites.push(site);
            }
          }
          break;
        }
      }
    }
  };

  const segments = splitModuleBundle(src);
  if (segments) {
    for (const seg of segments) {
      const file = parseModuleSegment(seg, PARSE_OPTIONS, 'param-slot');
      if (!file) continue;
      ingest(file.program);
    }
  } else {
    ingest(parser.parse(src, PARSE_OPTIONS).program);
  }
  return findings;
}

const VERDICTS = new Set(['catalogue', 'glue', 'not-a-slot', 'off-route']);
// `off-route` and `not-a-slot` rule on one site, yet rows are keyed by content:
// a literal ruled off-route where one host drops it is not reviewed where
// another host renders it to the model. Those verdicts cover only the host
// prompt(s) they name in `promptId`/`promptIds`, the catalogued template the
// parameter renders into. The builder's minified name is no identity: it
// changes every build and two modules' `g` collide. `catalogue` and `glue` are
// about the text and cover every site.
const SITE_VERDICTS = new Set(['not-a-slot', 'off-route']);
const rowHosts = row =>
  [row.promptId, ...(Array.isArray(row.promptIds) ? row.promptIds : [])].filter(
    Boolean
  );
export const rowCovers = (row, site) =>
  Boolean(row) &&
  VERDICTS.has(row.verdict) &&
  (!SITE_VERDICTS.has(row.verdict) ||
    rowHosts(row).some(h => site.hosts.includes(h)));

export function unreviewedSites(findings, allow) {
  const out = [];
  for (const [key, f] of findings)
    for (const site of f.sites)
      if (!rowCovers(allow[key], site)) out.push([key, f, site]);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const update = argv.includes('--update-allowlist');
  const [cliPath, jsonPath] = argv.filter(a => !a.startsWith('--'));
  if (!cliPath || !jsonPath) {
    die('usage: checkParamSlotLiterals.mjs <cli.js> <prompts.json> [--update-allowlist]');
  }
  for (const p of [cliPath, jsonPath]) {
    if (!fs.existsSync(p)) die(`missing input: ${p}`);
  }

  const src = fs.readFileSync(cliPath, 'utf8');
  const prompts = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).prompts;
  let findings;
  try {
    findings = findParamSlotLiterals(src, prompts);
  } catch (err) {
    die(`could not parse ${cliPath}: ${err.message}`);
  }

  let allow = {};
  if (fs.existsSync(ALLOWLIST)) {
    try {
      allow = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8'));
    } catch (err) {
      die(`could not read ${ALLOWLIST}: ${err.message}`);
    }
  }

  const unreviewed = unreviewedSites(findings, allow);

  if (update) {
    for (const [key, f, site] of unreviewed) {
      // A site verdict ruled for another builder stays: overwriting it would
      // erase that review. Replace it by hand with a verdict on the text.
      if (allow[key] && VERDICTS.has(allow[key].verdict)) {
        console.log(
          `param-slot: kept [${key}] ${allow[key].verdict} at ${rowHosts(allow[key]).join(', ') || '(no host)'}; rule ${site.hosts.join(', ')} by hand (add it to promptIds, or replace the row with a verdict on the text)`
        );
        continue;
      }
      allow[key] = {
        promptId: site.hosts[0],
        ...(site.hosts.length > 1 && { promptIds: site.hosts.slice(1) }),
        builder: site.builder,
        param: site.param,
        note: 'REVIEW ME - replace with the verdict (catalogue|glue|not-a-slot|off-route) and its reason',
        text: f.text,
      };
    }
    fs.writeFileSync(ALLOWLIST, JSON.stringify(allow, null, 2) + '\n');
    console.log(`param-slot: allowlist written with ${Object.keys(allow).length} entries`);
    console.log('Set each "verdict", then re-run without the flag.');
    process.exitCode = 0;
    return;
  }

  const sites = [...findings.values()].reduce((n, f) => n + f.sites.length, 0);
  // One candidate per literal and call site: a site verdict reviews one site.
  console.log(
    `param-slot literals: ${sites} candidate(s), ` +
      `${sites - unreviewed.length} reviewed, ${unreviewed.length} unreviewed ` +
      `(${findings.size} distinct literal(s))`
  );
  for (const [key, f, site] of unreviewed) {
    console.log(
      `\n  ${site.hosts.join(', ')} via ${site.builder}(#${site.paramIndex} = ${site.param}) @${site.offset} [${key}]`
    );
    console.log(`    ${JSON.stringify(f.text.slice(0, 200))}`);
  }
  if (unreviewed.length) {
    console.log(
      '\nRead each call site. A literal carrying an instruction, a constraint, or a name the\n' +
        'model must reproduce is "catalogue" — record {"facing":"model", id, name, desc} in\n' +
        'data/prompt-classification.json against the hash the extractor uses (probe it with\n' +
        'TWEAKCC_DUMP_CANDIDATES). A label or separator is "glue". Then:\n' +
        '  node tools/checkParamSlotLiterals.mjs <cli.js> <json> --update-allowlist'
    );
    process.exitCode = 1;
    return;
  }
  console.log('param-slot literals: PASS — every call-site argument reviewed');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
