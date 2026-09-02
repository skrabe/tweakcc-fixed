#!/usr/bin/env node
// Report machine-checkable API facts a trim deleted from the whole override set.
//
// This is the deterministic counterpart to the adversarial audit stage. An agent
// verifier SAMPLES: on the CC 2.1.237 managed-agents family two verify rounds
// each refuted 9-10 of 10 files, but between them they named only a handful of
// genuinely absent facts, disagreed about which, and re-flagged as "missing"
// several strings that were live on disk. Worse, most of what they reported was
// a stale `coveredBy` CITATION in the audit record rather than absent prompt
// text — and when a whole family is trimmed in one pass, every cross-citation is
// stale by construction, so those findings can never clear no matter how many
// repair rounds run. This tool enumerates instead, terminates, and reports only
// text that is genuinely reachable by nothing.
//
// What counts as a fact: a name the model has to reproduce EXACTLY for a request
// to succeed — an endpoint path, an SDK method chain, a CLI command, an object
// key. Prose can be reworded; `client.beta.memory_stores.memories.update` cannot.
// So facts are read out of code regions only (inline spans and fenced blocks),
// never running prose.
//
// Scope is the whole SET, not the file. An API fact only has to reach the model
// once; a trim that moves it from a tutorial fence in one prompt to a table in a
// sibling has lost nothing. Per-file scoping produced exactly that false finding
// on 2.1.237 (see tools/checkTrimSlots.mjs for the same reasoning applied to
// `{{}}` catalogue templates).
//
// Presence is asymmetric on purpose: facts are EXTRACTED from pristine code
// regions but checked as plain substrings anywhere in the deployed text. A fact
// that survived as prose rather than as a code key still reaches the model, and
// demanding it keep its original delimiter flagged `standard`, `medium`, and
// `city` as losses when all three were live.
//
// Usage:
//   node tools/checkFactCoverage.mjs <prompts.json> --set=<abs dir> --ids=<file>
//     --ids  newline-separated ids this run trimmed. Facts come from THEIR
//            pristine bodies; coverage is checked against the whole set.
//     --json <path>  write findings for a downstream repair packet.
//
// A fact the model never has to reproduce — pristine's own prose shorthand for
// a verdict, an internal field name that appears in neither the model's input
// nor its output contract — is justified in data/fact-coverage-allowlist.json,
// keyed `<id>` -> `{ <fact>: <reason> }`. Without that file the tool asked for
// a justification and gave it nowhere to live, so `shouldBlock` re-fired on
// every run after it had been ruled on. An entry whose fact is reachable again
// is reported as stale so the file cannot accumulate dead rows.
//
// Exit 0 = every fact still reachable, 1 = findings, 2 = could not run.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const SPAN = /`([^`\n]{1,400})`/g;
const FENCE = /```[^\n]*\n([\s\S]*?)```/g;
// A whole inline span is a fact when it is nothing but an identifier, a dotted
// chain, or a versioned path — `client.beta.agents.create`, `/v1/skills/{id}`.
const SPAN_SHAPE =
  /^(?:\/v1\/[A-Za-z0-9_{}/.-]+|[A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z0-9_-]+)*(?:\(\))?)$/;
// An object key in a code sample is API surface; a bare identifier beside it is
// usually sample scaffolding (`m.path`, `ev.id`), so require the trailing colon.
const KEY = /(?:^|[{,(\[]|\s)["']?([a-z][a-zA-Z0-9_]{3,})["']?\??\s*:/g;
// SDK chains and CLI commands are facts wherever they appear, including prose.
const CHAIN =
  /\bclient\.[A-Za-z_][A-Za-z0-9_.]{3,}|\bant\s+[a-z][a-z0-9:_-]{3,}/g;

export const reconstruct = p => {
  const pieces = p.pieces || [];
  const ids = p.identifiers || [];
  const map = p.identifierMap || {};
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    out += pieces[i];
    if (i < ids.length) out += map[String(ids[i])] ?? `UNKNOWN_${ids[i]}`;
  }
  return out;
};

export const stripFrontmatter = t => {
  if (!t.startsWith('<!--')) return t;
  const end = t.indexOf('-->');
  return end === -1 ? t : t.slice(end + 3).replace(/^\n/, '');
};

export const factsOf = text => {
  const t = text || '';
  const found = new Set();
  const regions = [];
  for (const m of t.matchAll(SPAN)) {
    const v = m[1].trim();
    if (v.length >= 4 && SPAN_SHAPE.test(v)) found.add(v);
    regions.push(m[1]);
  }
  for (const m of t.matchAll(FENCE)) regions.push(m[1]);
  for (const region of regions)
    for (const k of region.matchAll(KEY)) found.add(k[1]);
  for (const c of t.matchAll(CHAIN)) found.add(c[0].replace(/\s+/g, ' '));
  return found;
};

export const uncoveredFacts = (pristineBodies, deployedSetText) => {
  const want = new Set();
  for (const b of pristineBodies) for (const f of factsOf(b)) want.add(f);
  return [...want].filter(f => !deployedSetText.includes(f)).sort();
};

const main = () => {
  const die = (msg, code = 2) => {
    console.error(`checkFactCoverage: ${msg}`);
    process.exit(code);
  };
  const argv = process.argv.slice(2);
  const jsonPath = argv.find(a => !a.startsWith('--'));
  const setDir = (argv.find(a => a.startsWith('--set=')) || '').slice(6);
  const idsFile = (argv.find(a => a.startsWith('--ids=')) || '').slice(6);
  const outIdx = argv.indexOf('--json');
  const outPath = outIdx === -1 ? null : argv[outIdx + 1];

  if (!jsonPath || !setDir || !idsFile)
    die('usage: <prompts.json> --set=<abs dir> --ids=<file> [--json <path>]');
  if (!fs.existsSync(jsonPath)) die(`no prompts JSON at ${jsonPath}`);
  if (!fs.existsSync(setDir)) die(`no override set at ${setDir}`);
  if (!fs.existsSync(idsFile)) die(`no ids file at ${idsFile}`);

  const allowPath = path.join(
    path.dirname(url.fileURLToPath(import.meta.url)),
    '..',
    'data',
    'fact-coverage-allowlist.json'
  );
  const allow = fs.existsSync(allowPath)
    ? JSON.parse(fs.readFileSync(allowPath, 'utf8'))
    : {};

  const prompts = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).prompts || [];
  const pristine = new Map();
  for (const p of prompts) {
    if (!p.id) continue;
    if (!pristine.has(p.id)) pristine.set(p.id, []);
    pristine.get(p.id).push(reconstruct(p));
  }

  const ids = fs
    .readFileSync(idsFile, 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  // The deployed corpus is every override in the set PLUS the pristine body of
  // every catalogued id the set does not override. An absent file is not an
  // absent prompt: `syncPrompt` applies pristine for it, so that text reaches
  // the model. Scanning only `.md` files therefore under-counts coverage in
  // exactly the set where it matters most — `opus-4-7` carries real overrides
  // only, so nearly every id is delivered as pristine there, and the gate
  // reported `id()` from the artifact db contract as reachable nowhere while
  // `tool-description-artifact-database-guidance` was in fact supplying it
  // pristine.
  let deployed = '';
  const overridden = new Set();
  for (const f of fs.readdirSync(setDir)) {
    if (!f.endsWith('.md')) continue;
    overridden.add(f.slice(0, -3));
    deployed += fs.readFileSync(path.join(setDir, f), 'utf8');
  }
  for (const [id, bodies] of pristine) {
    if (overridden.has(id)) continue;
    for (const b of bodies) deployed += b + '\n';
  }

  const findings = [];
  const justified = [];
  const stale = [];
  for (const id of ids) {
    if (!pristine.has(id)) continue;
    const rules = allow[id] || {};
    const all = uncoveredFacts(pristine.get(id), deployed);
    const uncovered = all.filter(f => !(f in rules));
    for (const f of all)
      if (f in rules) justified.push({ id, fact: f, reason: rules[f] });
    for (const f of Object.keys(rules))
      if (!all.includes(f)) stale.push({ id, fact: f });
    if (uncovered.length) findings.push({ id, uncovered });
  }
  for (const j of justified)
    console.log(`  ✓ ${j.id}: ${j.fact} — justified: ${j.reason}`);
  for (const st of stale)
    console.log(
      `  ! ${st.id}: allowlist row for ${st.fact} is stale — the fact is reachable again; delete the row`
    );

  if (outPath) fs.writeFileSync(outPath, JSON.stringify(findings, null, 1));

  const total = findings.reduce((n, f) => n + f.uncovered.length, 0);
  if (!total) {
    console.log(
      `checkFactCoverage: 0 — every API fact from ${ids.length} trimmed prompt(s) is still reachable in ${path.basename(setDir)}`
    );
    process.exit(0);
  }
  console.log(
    `checkFactCoverage: ${total} API fact(s) from ${findings.length} of ${ids.length} trimmed prompt(s) are reachable nowhere in ${path.basename(setDir)}`
  );
  for (const f of findings) {
    console.log(`  ${f.id}`);
    for (const t of f.uncovered) console.log(`      gone  ${t}`);
  }
  console.log(
    '\nEach one is a name the model must reproduce exactly. Restore it verbatim\n' +
      'somewhere in the family, or justify per fact why nothing needs to emit it.'
  );
  process.exit(1);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main();
}
