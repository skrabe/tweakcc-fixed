#!/usr/bin/env node
// Refuse an identifierMap that changed under an UNCHANGED slot shape.
//
// A prompt whose `identifiers` array is identical between two catalogues has
// the same interpolation slots in the same order, so its slot NAMES have no
// reason to move: every override addresses slots by those names, and a rename
// either strands the override (`${OLD_NAME}` no longer resolves — and when it
// sits inside an expression the apply-time leak check cannot see it, so the
// raw identifier ships into a template literal and every interactive turn
// ends on a swallowed ReferenceError, CC 2.1.257) or, worse, re-binds it to a
// different slot with valid-but-wrong content and no error at all.
//
// Both ways this has happened were pipeline slips, not content changes: a
// stale NEW_PROMPT_ASSIGNMENTS map overlaying a correct carried map, and an
// extractor run without TWEAKCC_UPSTREAM_JSON that regenerated eight maps the
// previous catalogue had adopted from upstream. Neither is visible in the
// apply log, four-zeros, the safety harness or the smoke. This is.
//
// A drift can be deliberate — a curated correction of a map that was wrong in
// the previous catalogue (coordinator-mode, 2.1.257). Acknowledge those by id
// with --allow so the run's intent is on record.
//
// Usage:
//   node tools/checkMapDrift.mjs <prev prompts.json> <next prompts.json> [--allow=<id>,<id>…]
//
// Exit 0 = no unacknowledged drift, 1 = drift, 2 = could not run.
import fs from 'node:fs';

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
const allow = new Set(
  args
    .filter(a => a.startsWith('--allow='))
    .flatMap(a => a.slice('--allow='.length).split(','))
    .filter(Boolean)
);
if (files.length !== 2) {
  console.error('usage: checkMapDrift.mjs <prev.json> <next.json> [--allow=id,…]');
  process.exit(2);
}
const load = f => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')).prompts;
  } catch (e) {
    console.error(`could not read ${f}: ${e.message}`);
    process.exit(2);
  }
};
const byId = list => new Map(list.map(p => [p.id, p]));
const prev = byId(load(files[0]));
const next = byId(load(files[1]));

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const drifted = [];
const acknowledged = [];
let compared = 0;
for (const [id, p] of next) {
  const o = prev.get(id);
  if (!o) continue;
  if (!same(o.identifiers, p.identifiers)) continue;
  compared++;
  // Only LIVE slots count: a stale key for a slot that no longer exists is
  // pruned by the extractor and names nothing an override could bind to.
  const slots = [...new Set((p.identifiers ?? []).map(String))];
  const changes = slots
    .filter(k => (o.identifierMap ?? {})[k] !== (p.identifierMap ?? {})[k])
    .map(k => `[${k}] ${(o.identifierMap ?? {})[k] ?? '∅'} → ${(p.identifierMap ?? {})[k] ?? '∅'}`);
  if (changes.length === 0) continue;
  (allow.has(id) ? acknowledged : drifted).push({ id, changes });
}

for (const d of acknowledged) {
  console.log(`  ✓ ${d.id}: acknowledged rename — ${d.changes.join('; ')}`);
}
for (const d of drifted) {
  console.log(`  ✗ ${d.id}: slot names moved under an unchanged shape — ${d.changes.join('; ')}`);
}
console.log(
  `${drifted.length ? '✗' : '✓'} identifierMap drift: ${drifted.length} unacknowledged, ${acknowledged.length} acknowledged, ${compared} same-shape prompts compared`
);
process.exit(drifted.length ? 1 : 0);
