#!/usr/bin/env node
// Refuse an identifierMap that changed under an UNCHANGED slot shape, or a
// name that now sits on a different variable after the identifiers array
// CHANGED shape.
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
// When the identifiers array DOES change, carrying names by index is the
// same silent mis-bind: CC 2.1.269 inserted a ternary with three new
// variables AHEAD of system-prompt-worker-agent's old two, and the extractor
// kept {0: MAX_SUBAGENT_SPAWN_DEPTH_FN, 1: AGENT_TOOL_NAME} on the new
// skill-routing flag and commit-skill name. Valid names, wrong slots, no
// crash. Names that stay bound to the same variable (appended slots, or a
// rename-in-place at the same surrounding text) must pass; a name whose
// local context in NEXT shares nothing with PREV is a moved binding.
//
// Context fingerprint: ~40 chars of the preceding piece's tail and ~40 of
// the following piece's head, whitespace-normalised, nested ${…} trimmed,
// plus the slot's use-shape (call/member/value). Two contexts match when
// 3-gram Dice ≥ 0.5 on the combined window, or on one side that still has
// enough alphanumeric text (10 chars before / 8 after). 0.5 is about half
// the local trigrams surviving a minor edit; the 2.1.269 misbind scored
// 0.07–0.25, a correct carry and an append-at-end score 1.0. Glue-only
// windows (`}` / `${` / `(`) are not evidence either way.
//
// A drift can be deliberate — a curated correction of a map that was wrong
// in the previous catalogue (coordinator-mode, 2.1.257). Acknowledge those
// by id with --allow so the run's intent is on record.
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
  console.error(
    'usage: checkMapDrift.mjs <prev.json> <next.json> [--allow=id,…]'
  );
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
// How each slot is USED: the character after it says whether pristine calls it
// (`(`), reads a member (`.`/`[`), or interpolates the value. An identical
// `identifiers` array can still hide a slot whose expression changed kind —
// CC 2.1.268 turned `${e!==null?pEr():…}` into `${e!==null?pEr:…}` — and a name
// that follows that change (`…_FN` → plain) is the catalogue being right, not
// drifting. Only a rename under an unchanged use-shape is the slip this gate is for.
const slotShapeOf = after => {
  const ch = after[0] ?? '';
  if (ch === '(') return 'call';
  if (ch === '.' || ch === '[') return 'member';
  return 'value';
};
const slotShapes = p => {
  const shapes = new Map();
  const pieces = p.pieces ?? [];
  (p.identifiers ?? []).forEach((ident, i) => {
    const after = typeof pieces[i + 1] === 'string' ? pieces[i + 1] : '';
    const k = String(ident);
    shapes.set(
      k,
      [...(shapes.get(k) ?? []), slotShapeOf(after)].sort().join(',')
    );
  });
  return shapes;
};

const CONTEXT_WIN = 40;
const DICE_THRESHOLD = 0.5;
const MIN_BEFORE_PROSE = 10;
const MIN_AFTER_PROSE = 8;

const trimNested = s => {
  let prevS;
  do {
    prevS = s;
    s = s.replace(/\$\{[^{}]*\}/g, '');
  } while (s !== prevS);
  return s;
};
const norm = s => trimNested(s).replace(/\s+/g, ' ').trim();
const proseLen = s => s.replace(/[^A-Za-z0-9]/g, '').length;
const grams = s => {
  if (s.length < 3) return s ? new Set([s]) : new Set();
  const out = new Set();
  for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
  return out;
};
const dice = (a, b) => {
  if (a === b && a !== '') return 1;
  if (!a || !b) return 0;
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
};
const highSignal = ctx =>
  proseLen(ctx.before) >= MIN_BEFORE_PROSE ||
  proseLen(ctx.after) >= MIN_AFTER_PROSE;
const contextsMatch = (a, b) => {
  const combined = dice(
    `${a.shape}\n${a.before}\n${a.after}`,
    `${b.shape}\n${b.before}\n${b.after}`
  );
  if (combined >= DICE_THRESHOLD) return true;
  if (
    dice(a.before, b.before) >= DICE_THRESHOLD &&
    proseLen(a.before) >= MIN_BEFORE_PROSE &&
    proseLen(b.before) >= MIN_BEFORE_PROSE
  ) {
    return true;
  }
  if (
    dice(a.after, b.after) >= DICE_THRESHOLD &&
    proseLen(a.after) >= MIN_AFTER_PROSE &&
    proseLen(b.after) >= MIN_AFTER_PROSE
  ) {
    return true;
  }
  return false;
};
const nameContexts = p => {
  const pieces = p.pieces ?? [];
  const map = p.identifierMap ?? {};
  const out = new Map();
  (p.identifiers ?? []).forEach((ident, i) => {
    const name = map[String(ident)];
    if (!name) return;
    let before = typeof pieces[i] === 'string' ? pieces[i] : '';
    const after = typeof pieces[i + 1] === 'string' ? pieces[i + 1] : '';
    if (before.endsWith('${')) before = before.slice(0, -2);
    const ctx = {
      shape: slotShapeOf(after),
      before: norm(before).slice(-CONTEXT_WIN),
      after: norm(after).slice(0, CONTEXT_WIN),
    };
    out.set(name, [...(out.get(name) ?? []), ctx]);
  });
  return out;
};
const GENERATED_NAME = /_VAR_\d+$/;
const movedNames = (o, p) => {
  const prevCtx = nameContexts(o);
  const nextCtx = nameContexts(p);
  const names = [];
  for (const name of prevCtx.keys()) {
    if (!nextCtx.has(name)) continue;
    // Generated VAR_N labels are keyed on distinct-index, not on a
    // minified variable. Inserting a var at the front slides every later
    // index; the name VAR_3 still means "distinct index 3". Flagging that
    // is noise — the slip this class exists for is a curated name (the
    // kind an override writes) landing on a different variable.
    if (GENERATED_NAME.test(name)) continue;
    const a = (prevCtx.get(name) ?? []).filter(highSignal);
    const b = (nextCtx.get(name) ?? []).filter(highSignal);
    if (a.length === 0 || b.length === 0) continue;
    const shares = b.some(x => a.some(y => contextsMatch(x, y)));
    if (!shares) names.push(name);
  }
  return names;
};

const drifted = [];
const acknowledged = [];
const reshaped = [];
const moved = [];
let compared = 0;
for (const [id, p] of next) {
  const o = prev.get(id);
  if (!o) continue;
  if (!same(o.identifiers, p.identifiers)) {
    const names = movedNames(o, p);
    if (names.length === 0) continue;
    (allow.has(id) ? acknowledged : moved).push({
      id,
      kind: 'moved',
      changes: names,
    });
    continue;
  }
  compared++;
  // Only LIVE slots count: a stale key for a slot that no longer exists is
  // pruned by the extractor and names nothing an override could bind to.
  const slots = [...new Set((p.identifiers ?? []).map(String))];
  const changes = slots
    .filter(k => (o.identifierMap ?? {})[k] !== (p.identifierMap ?? {})[k])
    .map(
      k =>
        `[${k}] ${(o.identifierMap ?? {})[k] ?? '∅'} → ${(p.identifierMap ?? {})[k] ?? '∅'}`
    );
  if (changes.length === 0) continue;
  const os = slotShapes(o);
  const ps = slotShapes(p);
  const movedUnderSameShape = slots.some(
    k =>
      (o.identifierMap ?? {})[k] !== (p.identifierMap ?? {})[k] &&
      os.get(k) === ps.get(k)
  );
  if (!movedUnderSameShape) {
    reshaped.push({ id, changes });
    continue;
  }
  (allow.has(id) ? acknowledged : drifted).push({
    id,
    kind: 'rename',
    changes,
  });
}

for (const d of reshaped) {
  console.log(
    `  · ${d.id}: renamed with its slot's use-shape (call/member/value) — ${d.changes.join('; ')}`
  );
}

for (const d of acknowledged) {
  if (d.kind === 'moved') {
    console.log(
      `  ✓ ${d.id}: acknowledged moved binding — ${d.changes.join(', ')}`
    );
  } else {
    console.log(`  ✓ ${d.id}: acknowledged rename — ${d.changes.join('; ')}`);
  }
}
for (const d of drifted) {
  console.log(
    `  ✗ ${d.id}: slot names moved under an unchanged shape — ${d.changes.join('; ')}`
  );
}
for (const d of moved) {
  console.log(
    `  ✗ ${d.id}: name bound to a different variable — ${d.changes.join(', ')}`
  );
}
const failed = drifted.length + moved.length;
console.log(
  `${failed ? '✗' : '✓'} identifierMap drift: ${drifted.length} unacknowledged, ${acknowledged.length} acknowledged, ${reshaped.length} reshaped, ${moved.length} moved, ${compared} same-shape prompts compared`
);
process.exit(failed ? 1 : 0);
