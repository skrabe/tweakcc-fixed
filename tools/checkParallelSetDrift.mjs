#!/usr/bin/env node
// `--apply` rebases and reports conflicts ONLY against ~/.tweakcc/system-prompts,
// the active set. A prompt whose pristine drifts is silently refreshed there and
// never in the parallel per-model sets, and because it never enters the conflict
// list nothing else points at it either — so a parallel copy can hold an
// arbitrarily old body indefinitely (memory: parallel-set-drift).
//
// This reports, for every id, each parallel set whose body is byte-identical to
// some OLDER pristine for that id while the active set has moved on. That is the
// provable case: the set was tracking pristine, pristine moved, the set did not.
// A genuinely divergent body (a real trim) is reported separately and needs a
// human call, never an automatic mirror.
//
//   node tools/checkParallelSetDrift.mjs <version> [--fix]
//
// --fix mirrors the ACTIVE set's current body into every set proven to be a
// stale pristine stub, and rewrites that file's ccVersion.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LCC = path.join(os.homedir(), '.tweakcc', 'lobotomized-claude-code');
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const version = process.argv[2] || '';
const FIX = process.argv.includes('--fix');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: checkParallelSetDrift.mjs <version> [--fix]');
  process.exit(2);
}

const activeDir = fs.realpathSync(path.join(os.homedir(), '.tweakcc', 'system-prompts'));
const activeName = path.basename(activeDir);

// Reconstruct a prompt body. TWO invariants, both easy to get wrong and both
// wrong in the first cut of this file:
//   1. `pieces` ALREADY carry the `${` and `}` delimiters ("owned by you${",
//      "}; includes …"), so the label is inserted BARE. Wrapping it again emits
//      `${${LABEL}}`, which matches nothing and makes an exact pristine stub
//      look like a curated body.
//   2. The identifierMap key is `identifiers[i]`, NOT `i`. They coincide often
//      enough to hide the bug.
// This mirrors reconstructContentFromPieces in src/systemPromptSync.ts.
const reconstruct = p => {
  const pieces = p.pieces || [];
  if (!pieces.length) return p.content || '';
  const ids = p.identifiers || [];
  const map = p.identifierMap || {};
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    out += pieces[i];
    if (i < ids.length) out += map[String(ids[i])] || `UNKNOWN_${ids[i]}`;
  }
  return out;
};

// Every pristine body this id has EVER had, across the committed catalogue. A
// parallel body matching any of them was tracking pristine at that point.
const historical = new Map();
const current = new Map();
const files = fs
  .readdirSync(path.join(REPO, 'data/prompts'))
  .filter(f => /^prompts-\d+\.\d+\.\d+\.json$/.test(f));
for (const f of files) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(REPO, 'data/prompts', f), 'utf8')); }
  catch { continue; }
  const isCurrent = f === `prompts-${version}.json`;
  for (const p of doc.prompts || []) {
    if (!p.id) continue;
    const b = reconstruct(p).trim();
    if (!historical.has(p.id)) historical.set(p.id, new Set());
    historical.get(p.id).add(b);
    if (isCurrent) {
      if (!current.has(p.id)) current.set(p.id, new Set());
      current.get(p.id).add(b);
    }
  }
}

const split = file => {
  const raw = fs.readFileSync(file, 'utf8');
  const m = /^<!--\n([\s\S]*?)\n-->\n?/.exec(raw);
  return m
    ? { head: m[1], body: raw.slice(m[0].length), full: raw, headEnd: m[0].length }
    : { head: '', body: raw, full: raw, headEnd: 0 };
};

const sets = fs
  .readdirSync(LCC)
  .filter(d => /^system-prompts-/.test(d) && fs.statSync(path.join(LCC, d)).isDirectory());
const parallel = sets.filter(s => s !== activeName);

const stale = [];
const propagate = [];
const divergent = [];

for (const id of current.keys()) {
  const activeFile = path.join(LCC, activeName, `${id}.md`);
  if (!fs.existsSync(activeFile)) continue;
  const active = split(activeFile);
  const activeBody = active.body.trim();
  const cur = current.get(id);
  const past = historical.get(id);

  for (const set of parallel) {
    const f = path.join(LCC, set, `${id}.md`);
    if (!fs.existsSync(f)) continue;
    const { head, body } = split(f);
    const b = body.trim();
    if (b === activeBody) continue;        // already in step
    if (cur.has(b)) continue;              // matches a CURRENT pristine site — fine
    const cc = (/^ccVersion:\s*(.+)$/m.exec(head) || [])[1] || '?';
    // Mirroring is only MECHANICAL when the active body is itself a current
    // pristine stub — then the parallel set was tracking pristine and simply
    // missed a refresh. When the active body is curated (a trim, or an empty
    // body = deliberate suppression), copying it across is a CONTENT decision
    // and belongs to the propagation pass, not to an automatic fix.
    const activeIsStub = cur.has(activeBody);
    if (past.has(b)) (activeIsStub ? stale : propagate).push({ id, set, cc, file: f, was: b.length, now: activeBody.length, empty: activeBody === '' });
    else divergent.push({ id, set, cc });
  }
}

if (stale.length) {
  console.log(`stale pristine stubs (tracking an OLDER pristine while the active set moved): ${stale.length}`);
  for (const s of stale) console.log(`  ${s.set.replace('system-prompts-', '').padEnd(9)} ${s.id}  ccVersion=${s.cc}  ${s.was} -> ${s.now}`);
} else console.log('stale pristine stubs: 0');

if (propagate.length) {
  console.log(`\nstale AND the active set now carries a curated body — content propagation, decide each: ${propagate.length}`);
  for (const p of propagate) console.log(`  ${p.set.replace('system-prompts-', '').padEnd(9)} ${p.id}  ccVersion=${p.cc}  ${p.was} -> ${p.now}${p.empty ? '  (active is SUPPRESSED — mirroring wipes it here too)' : ''}`);
}

if (divergent.length) {
  console.log(`\ndivergent bodies (deliberate per-model trims — NOT auto-mirrored, decide each): ${divergent.length}`);
  for (const d of divergent) console.log(`  ${d.set.replace('system-prompts-', '').padEnd(9)} ${d.id}  ccVersion=${d.cc}`);

}

if (FIX && stale.length) {
  for (const s of stale) {
    const active = split(path.join(LCC, activeName, `${s.id}.md`));
    const target = split(s.file);
    const head = target.head.replace(/^ccVersion:.*$/m, `ccVersion: ${(/^ccVersion:\s*(.+)$/m.exec(active.head) || [, version])[1]}`);
    fs.writeFileSync(s.file, `<!--\n${head}\n-->\n${active.body}`);
  }
  console.log(`\nmirrored ${stale.length} stale stub(s) from ${activeName}`);
}

process.exit(stale.length && !FIX ? 1 : 0);
