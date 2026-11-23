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
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  parseOverrideArgs,
  resolveOverrideSets,
  appliedPromptsDir,
  printAuditedSets,
} = require('./lib/overrideSets.cjs');

const parsed = parseOverrideArgs(process.argv.slice(2));
const sets = resolveOverrideSets(parsed, { fallback: 'applied' });
const restPos = parsed.rest.filter(a => a !== '--fix');
const version = restPos[0] || '';
const FIX = parsed.rest.includes('--fix');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: checkParallelSetDrift.mjs <version> [--fix]');
  process.exit(2);
}

const REPO = path.resolve(new URL('..', import.meta.url).pathname);

let active = null;
const applied = appliedPromptsDir();
if (fs.existsSync(applied)) {
  try {
    const dir = fs.realpathSync(applied);
    active = { dir, name: path.basename(dir) };
  } catch {
    active = null;
  }
}
const others = sets.filter(s => !active || s.dir !== active.dir);
printAuditedSets(active ? [active, ...others] : others);

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
const currentVersions = new Map();
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
      if (!currentVersions.has(p.id)) currentVersions.set(p.id, new Set());
      currentVersions.get(p.id).add(String(p.version));
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

const stale = [];
const propagate = [];
const divergent = [];

if (active) {
  for (const id of current.keys()) {
    const activeFile = path.join(active.dir, `${id}.md`);
    if (!fs.existsSync(activeFile)) continue;
    const activeSplit = split(activeFile);
    const activeBody = activeSplit.body.trim();
    const cur = current.get(id);
    const past = historical.get(id);

    for (const other of others) {
      const f = path.join(other.dir, `${id}.md`);
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
      if (past.has(b)) (activeIsStub ? stale : propagate).push({ id, set: other.name, cc, file: f, was: b.length, now: activeBody.length, empty: activeBody === '' });
      else divergent.push({ id, set: other.name, cc });
    }
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

// `--apply` conflict-checks the ACTIVE set only, so a parallel override whose
// ccVersion no longer equals the prompt's catalogue version is never reported,
// whatever its body: on CC 2.1.276 three opus-5 overrides were still at
// 2.1.191/2.1.207 and a curated opus-5 trim sat one release behind. Every such
// file is a conflict the realign pass must see.
const versionLag = [];
for (const other of others) {
  for (const [id, vers] of currentVersions) {
    const f = path.join(other.dir, `${id}.md`);
    if (!fs.existsSync(f)) continue;
    const cc = (/^ccVersion:\s*(.+)$/m.exec(split(f).head) || [])[1]?.trim() || '?';
    if (!vers.has(cc) && !stale.some(s => s.file === f)) versionLag.push({ id, set: other.name, cc, want: [...vers].join('|') });
  }
}
if (versionLag.length) {
  console.log(`\nparallel-set ccVersion lag (a conflict --apply never reports; realign each): ${versionLag.length}`);
  for (const v of versionLag) console.log(`  ${v.set.replace('system-prompts-', '').padEnd(9)} ${v.id}  ccVersion=${v.cc} -> ${v.want}`);
} else console.log('parallel-set ccVersion lag: 0');

if (FIX && stale.length && active) {
  for (const s of stale) {
    const activeSplit = split(path.join(active.dir, `${s.id}.md`));
    const target = split(s.file);
    const head = target.head.replace(/^ccVersion:.*$/m, `ccVersion: ${(/^ccVersion:\s*(.+)$/m.exec(activeSplit.head) || [, version])[1]}`);
    fs.writeFileSync(s.file, `<!--\n${head}\n-->\n${activeSplit.body}`);
  }
  console.log(`\nmirrored ${stale.length} stale stub(s) from ${active.name}`);
}

process.exitCode = (stale.length && !FIX) || versionLag.length ? 1 : 0;
