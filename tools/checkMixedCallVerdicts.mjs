#!/usr/bin/env node
// Mixed-verdict gate: a call group (the literal arguments at one position
// across every call of one function in a module) whose arms are ruled both
// `model` and `ui`/`internal`.
//
// A callee usually sends every argument at a position down one route, so a
// split ruling means a wrong verdict unless the call sites themselves route
// differently: a generic error class thrown on one path and caught on another,
// or one caller rendering the result where another drops it. Each classify
// agent rules a string from its own call site, so nothing compared the
// verdicts of one callee's arguments. On CC 2.1.296, 23 of 40 such groups held
// 51 wrong verdicts between them (slash-command output sent to the model ruled
// `ui`, workflow refusal fragments ruled `internal` beside their catalogued
// head).
//
// data/mixed-call-verdicts.json records reviews per arm. An entry is keyed by
// the group's fingerprint (see mixedRulings in checkSiblingArms.mjs) and holds
// the group's reviewed model arms and its reviews, each naming why the call
// sites route differently and the `(arm key, facing)` pairs it covers. Only
// arms no review covers are raised, so a group of a hundred arms re-raises the
// one arm that changed, not all of them. When a group's earned model arms
// change, its fingerprint changes; the entries at the same argument position
// that share one of its model arms are the same callee, and their reviews carry
// over until --record or --prune files them under the new fingerprint. A model
// arm none of those entries reviewed is raised like any other arm: text wrongly
// ruled model would otherwise ride in on its callee's old reviews. An entry
// that shares no model arm with any group stays while a group at its position
// still raises one of its reviewed arms, and its reasons are shown there as
// suggestions, not coverage.
//
// Usage:
//   node tools/checkMixedCallVerdicts.mjs <cli.js> <prompts.json>
//     [--cache data/prompt-classification.json]
//     [--allowlist data/mixed-call-verdicts.json] [--json]
//   ... --record <reviews.json>   add reviews
//   ... --prune                   drop entries and arms the scan no longer has
// <reviews.json> is [{key, why, arms?}]: key is the fingerprint a MIXED line
// prints, arms the arm keys to cover (default: every arm the group raises). A
// group with a wrong verdict is fixed in the classification cache instead.
// UNEARNED-MIXED lines are advisory and never change the exit status: groups
// that would be mixed if a model arm written as a literal argument counted
// even where its text is also used outside the group's calls.
// Exit 0 = every mixed arm reviewed, 1 = unreviewed arms or a rejected record,
// 2 = usage error, a bundle segment that could not be parsed, or two groups
// sharing a fingerprint.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CACHE, scanSiblingArmsShared } from './checkSiblingArms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOWLIST = path.join(
  HERE,
  '..',
  'data',
  'mixed-call-verdicts.json'
);

const PREVIEW = 60;
export const preview = body =>
  body.length > PREVIEW ? body.slice(0, PREVIEW - 1) + '…' : body;

export function fingerprintCollisions(mixed) {
  const count = new Map();
  for (const m of mixed)
    count.set(m.fingerprint, (count.get(m.fingerprint) || 0) + 1);
  return [...count].filter(([, n]) => n > 1).map(([fp]) => fp);
}

// The entries whose reviews apply to each group: its own, or else those at the
// same argument position sharing one of its model arms (the same callee, whose
// model text changed) that no current group owns.
function sourcesOf(mixed, allowlist) {
  const owned = new Set(
    mixed.map(m => m.fingerprint).filter(fp => allowlist[fp])
  );
  return new Map(
    mixed.map(m => {
      if (allowlist[m.fingerprint]) return [m, [m.fingerprint]];
      const keys = new Set(m.model.map(a => a.key));
      const carried = Object.keys(allowlist).filter(
        fp =>
          !owned.has(fp) &&
          allowlist[fp].position === m.position &&
          Object.keys(allowlist[fp].model || {}).some(k => keys.has(k))
      );
      return [m, carried];
    })
  );
}

const covers = (entries, arm) =>
  entries.some(e =>
    (e.reviews || []).some(
      r => r.why && r.arms?.[arm.key]?.facing === arm.facing
    )
  );

// Every arm of a group as `{key, facing, body}`, its model arms included.
const armsOf = m => [
  ...m.model.map(a => ({ key: a.key, facing: 'model', body: a.body })),
  ...m.other,
];

// A group with no entry takes its model arms as given: reviewing its other
// arms against them is the review. Once an entry exists, a model arm it does
// not hold is new text the reviews never saw.
function unreviewedArms(m, entries) {
  const known = new Set(entries.flatMap(e => Object.keys(e.model || {})));
  return armsOf(m).filter(a =>
    a.facing === 'model'
      ? entries.length && !known.has(a.key) && !covers(entries, a)
      : !covers(entries, a)
  );
}

// Entries no group owns or draws on whose reviews name an arm a group at their
// position raises at the same facing, as {fingerprint: [{entry, why, arms}]}.
function suggestionsFor(open, allowlist, drawn) {
  const out = new Map();
  for (const m of open) {
    const raised = new Map(m.uncovered.map(a => [a.key, a.facing]));
    const found = [];
    for (const [fp, e] of Object.entries(allowlist)) {
      if (drawn.has(fp) || e.position !== m.position) continue;
      for (const r of e.reviews || []) {
        const arms = Object.entries(r.arms || {})
          .filter(([k, v]) => r.why && raised.get(k) === v.facing)
          .map(([k]) => k);
        if (arms.length) found.push({ entry: fp, why: r.why, arms });
      }
    }
    if (found.length) out.set(m.fingerprint, found);
  }
  return out;
}

// Every group with an arm no review covers, with those arms as `uncovered` and
// the reasons of unowned entries naming them as `suggested`.
export function unreviewedMixed(mixed, allowlist) {
  const sources = sourcesOf(mixed, allowlist);
  const open = [];
  for (const m of mixed) {
    const from = sources.get(m);
    const uncovered = unreviewedArms(
      m,
      from.map(fp => allowlist[fp])
    );
    if (uncovered.length)
      open.push({
        ...m,
        uncovered,
        ...(from.length && from[0] !== m.fingerprint && { carriedFrom: from }),
      });
  }
  const drawn = new Set([...sources.values()].flat());
  const suggested = suggestionsFor(open, allowlist, drawn);
  return open.map(m =>
    suggested.has(m.fingerprint)
      ? { ...m, suggested: suggested.get(m.fingerprint) }
      : m
  );
}

// An entry's model map holds the model arms its reviews have seen: those its
// sources held or a review covers, or every one for a group with no sources.
const entryFor = (m, reviews, from) => {
  const known = new Set([
    ...from.flatMap(e => Object.keys(e.model || {})),
    ...reviews.flatMap(r =>
      Object.entries(r.arms).flatMap(([k, v]) =>
        v.facing === 'model' ? [k] : []
      )
    ),
  ]);
  return {
    at: m.at,
    model: Object.fromEntries(
      m.model
        .filter(a => !from.length || known.has(a.key))
        .map(a => [a.key, preview(a.body)])
    ),
    position: m.position,
    reviews,
  };
};

// The reviews of `from` restricted to arms the group still raises with the same
// facing; reviews left with no arm are dropped and reviews giving the same
// reason are merged.
function liveReviews(m, from) {
  const current = new Map(armsOf(m).map(a => [a.key, a]));
  const byWhy = new Map();
  for (const e of from)
    for (const r of e.reviews || []) {
      const arms = Object.entries(r.arms || {}).filter(
        ([k, v]) => current.get(k)?.facing === v.facing
      );
      if (!r.why || !arms.length) continue;
      if (!byWhy.has(r.why)) byWhy.set(r.why, {});
      for (const [k] of arms)
        byWhy.get(r.why)[k] = {
          facing: current.get(k).facing,
          preview: preview(current.get(k).body),
        };
    }
  return [...byWhy].map(([why, arms]) => ({ arms, why }));
}

// The entries an allowlist still needs: those a group draws on or that hold a
// suggestion for a group.
function neededEntries(mixed, allowlist) {
  const drawn = new Set([...sourcesOf(mixed, allowlist).values()].flat());
  for (const m of unreviewedMixed(mixed, allowlist))
    for (const s of m.suggested || []) drawn.add(s.entry);
  return drawn;
}

// Adds `reviews` ([{key, why, arms?}]) to a copy of `allowlist`. A group
// reviewed from carried entries is filed under its fingerprint with those
// reviews; an entry it drew on or that suggested reasons for it is then
// dropped once no current group needs it.
export function recordReviews(allowlist, reviews, mixed) {
  const next = { ...allowlist };
  const problems = [];
  const open = new Map(
    unreviewedMixed(mixed, allowlist).map(m => [m.fingerprint, m])
  );
  const sources = sourcesOf(mixed, allowlist);
  const current = new Set(mixed.map(m => m.fingerprint));
  const seen = new Set();
  const rows = [];
  if (!Array.isArray(reviews))
    return { allowlist, recorded: 0, problems: ['reviews must be an array'] };
  for (const r of reviews) {
    const key = r?.key;
    if (typeof key !== 'string' || !/^[0-9a-f]{16}$/.test(key))
      problems.push(`bad key: ${JSON.stringify(key)}`);
    else if (seen.has(key)) problems.push(`${key}: listed twice in this batch`);
    else if (typeof r.why !== 'string' || r.why.trim().length < 20)
      problems.push(`${key}: why must name the differing routes`);
    else if (!current.has(key))
      problems.push(`${key}: not a current mixed group`);
    else if (!open.has(key))
      problems.push(`${key}: every arm is already reviewed`);
    else {
      const raised = new Map(open.get(key).uncovered.map(a => [a.key, a]));
      const picked = r.arms ?? [...raised.keys()];
      const bad = Array.isArray(picked)
        ? picked.filter(k => !raised.has(k))
        : [JSON.stringify(picked)];
      if (bad.length)
        problems.push(`${key}: not an unreviewed arm here: ${bad.join(', ')}`);
      else if (!picked.length) problems.push(`${key}: arms picks no arm`);
      else if (new Set(picked).size !== picked.length)
        problems.push(`${key}: an arm is listed twice`);
      else
        rows.push({
          key,
          why: r.why.trim(),
          arms: picked.map(k => raised.get(k)),
        });
    }
    if (typeof key === 'string') seen.add(key);
  }
  if (problems.length || !rows.length)
    return { allowlist, recorded: 0, problems };
  const groups = new Map(mixed.map(m => [m.fingerprint, m]));
  for (const { key, why, arms } of rows) {
    const m = groups.get(key);
    const from = sources.get(m).map(fp => allowlist[fp]);
    const added = {
      reviews: [{ arms: Object.fromEntries(arms.map(a => [a.key, a])), why }],
    };
    next[key] = entryFor(m, liveReviews(m, [...from, added]), from);
  }
  const needed = neededEntries(mixed, next);
  for (const { key } of rows)
    for (const fp of [
      ...sources.get(groups.get(key)),
      ...(open.get(key).suggested || []).map(s => s.entry),
    ])
      if (fp !== key && !needed.has(fp)) delete next[fp];
  return { allowlist: next, recorded: rows.length, problems };
}

// Rebuilds `allowlist` from the current scan: each group's reviews filed under
// its fingerprint with only the arms it still raises at the recorded facing,
// and each entry holding a suggestion kept with only the reviews and arms it
// suggests. Reports the entries no group needs, the entries filed under a new
// fingerprint, and the arms dropped from the rest.
export function pruneReviews(allowlist, mixed) {
  const sources = sourcesOf(mixed, allowlist);
  const next = {};
  const kept = new Map();
  const rekeyed = [];
  const keep = (fp, k) => {
    if (!kept.has(fp)) kept.set(fp, new Set());
    kept.get(fp).add(k);
  };
  for (const m of mixed) {
    const from = sources.get(m);
    if (!from.length) continue;
    const facing = new Map(armsOf(m).map(a => [a.key, a.facing]));
    for (const fp of from) {
      if (fp !== m.fingerprint) rekeyed.push({ from: fp, to: m.fingerprint });
      kept.set(fp, kept.get(fp) || new Set());
      for (const r of allowlist[fp].reviews || [])
        for (const [k, v] of Object.entries(r.arms || {}))
          if (r.why && facing.get(k) === v.facing) keep(fp, k);
    }
    const entries = from.map(fp => allowlist[fp]);
    const reviews = liveReviews(m, entries);
    if (reviews.length) next[m.fingerprint] = entryFor(m, reviews, entries);
  }
  const suggested = new Map();
  for (const m of unreviewedMixed(mixed, allowlist))
    for (const s of m.suggested || []) {
      if (!suggested.has(s.entry)) suggested.set(s.entry, new Map());
      const byWhy = suggested.get(s.entry);
      byWhy.set(s.why, new Set([...(byWhy.get(s.why) || []), ...s.arms]));
      for (const k of s.arms) keep(s.entry, k);
    }
  for (const [fp, byWhy] of suggested) {
    const e = allowlist[fp];
    next[fp] = {
      ...e,
      reviews: (e.reviews || []).flatMap(r => {
        const arms = Object.entries(r.arms || {}).filter(([k]) =>
          byWhy.get(r.why)?.has(k)
        );
        return arms.length
          ? [{ arms: Object.fromEntries(arms), why: r.why }]
          : [];
      }),
    };
  }
  const removedEntries = [];
  const removedArms = [];
  for (const [fp, e] of Object.entries(allowlist)) {
    if (!kept.get(fp)?.size) {
      removedEntries.push({ key: fp, ...e });
      continue;
    }
    for (const r of e.reviews || [])
      for (const [k, v] of Object.entries(r.arms || {}))
        if (
          !kept.get(fp).has(k) ||
          (suggested.has(fp) && !suggested.get(fp).get(r.why)?.has(k))
        )
          removedArms.push({ entry: fp, key: k, ...v });
  }
  return { allowlist: next, removedEntries, removedArms, rekeyed };
}

const sortKeys = v =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map(k => [k, sortKeys(v[k])])
        )
      : v;

// Sorted keys, laid out by the repo's prettier config exactly as lint-staged
// would rewrite the file, so a --record or --prune diff holds only the change.
export async function formatAllowlist(allowlist) {
  const prettier = await import('prettier');
  const config = await prettier.resolveConfig(DEFAULT_ALLOWLIST, {
    editorconfig: true,
  });
  return prettier.format(JSON.stringify(sortKeys(allowlist), null, 2), {
    ...config,
    parser: 'json',
  });
}

async function writeAllowlist(file, allowlist) {
  const text = await formatAllowlist(allowlist);
  JSON.parse(text);
  fs.writeFileSync(file, text);
}

function parseArgs(argv) {
  const opt = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z]+)(?:=(.*))?$/);
    if (!m) opt.positional.push(argv[i]);
    else if (m[1] === 'json' || m[1] === 'prune') opt[m[1]] = true;
    else if (['cache', 'allowlist', 'record'].includes(m[1]))
      opt[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
    else throw new Error(`unknown option --${m[1]}`);
  }
  return opt;
}

async function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const allowlistPath = opt.allowlist || DEFAULT_ALLOWLIST;
  if (opt.positional.length !== 2 || (opt.record && opt.prune)) {
    console.error(
      'usage: node tools/checkMixedCallVerdicts.mjs <cli.js> <prompts.json> [--cache F] [--allowlist F] [--json] [--record <reviews.json> | --prune]'
    );
    process.exit(2);
  }
  const [cli, json] = opt.positional;
  const catalogue = JSON.parse(fs.readFileSync(json, 'utf8')).prompts;
  const cache = JSON.parse(fs.readFileSync(opt.cache || DEFAULT_CACHE, 'utf8'));
  const allowlist = fs.existsSync(allowlistPath)
    ? JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))
    : {};
  const r = scanSiblingArmsShared(cli, { catalogue, cache });
  const say = opt.json ? console.error : console.log;
  for (const u of r.unparsed)
    console.error(
      `UNPARSED segment ${u.name || '(bundle)'}@${u.start}: ${u.error}`
    );
  const collisions = fingerprintCollisions(r.mixed);
  for (const fp of collisions)
    console.error(
      `COLLISION ${fp}: groups @${r.mixed
        .filter(m => m.fingerprint === fp)
        .map(m => m.at)
        .join(', @')} share one fingerprint, so one review would cover both`
    );
  if ((opt.record || opt.prune) && (r.unparsed.length || collisions.length)) {
    console.error(
      'mixed call verdicts: refusing to write: the scan is incomplete or ambiguous'
    );
    process.exit(2);
  }
  if (opt.record) {
    const reviews = JSON.parse(fs.readFileSync(opt.record, 'utf8'));
    const rec = recordReviews(allowlist, reviews, r.mixed);
    for (const p of rec.problems) console.error(`FAIL ${p}`);
    if (rec.recorded) await writeAllowlist(allowlistPath, rec.allowlist);
    console.log(`mixed call verdicts: recorded ${rec.recorded} review(s)`);
    process.exit(rec.problems.length ? 1 : 0);
  }
  if (opt.prune) {
    const p = pruneReviews(allowlist, r.mixed);
    for (const e of p.removedEntries)
      console.log(
        `PRUNED entry ${e.key} @${e.at}: ${JSON.stringify(preview(e.reviews?.[0]?.why ?? ''))}`
      );
    for (const a of p.removedArms)
      console.log(
        `PRUNED arm ${a.key} (${a.facing}) from ${a.entry}: ${JSON.stringify(a.preview)}`
      );
    for (const k of p.rekeyed) console.log(`REKEYED ${k.from} -> ${k.to}`);
    await writeAllowlist(allowlistPath, p.allowlist);
    console.log(
      `mixed call verdicts: pruned ${p.removedEntries.length} entr(ies) and ${p.removedArms.length} arm(s), re-keyed ${p.rekeyed.length}; ${Object.keys(p.allowlist).length} entr(ies) kept`
    );
    process.exit(0);
  }
  const open = unreviewedMixed(r.mixed, allowlist);
  if (opt.json) console.log(JSON.stringify(open, null, 1));
  else
    for (const m of open) {
      const raised = new Set(m.uncovered.map(a => a.key));
      const others = m.uncovered.filter(a => a.facing !== 'model');
      const fresh = m.uncovered.length - others.length;
      console.log(
        `MIXED ${m.fingerprint} @${m.at} arg ${m.position}: ${others.length} of ${m.other.length} arm(s) unreviewed${fresh ? `, ${fresh} model arm(s) no review has seen` : ''}${m.carriedFrom ? ` (reviews carried from ${m.carriedFrom.join(', ')})` : ''}`
      );
      for (const a of m.model)
        console.log(
          `  model    ${a.key} ${JSON.stringify(a.body)}${raised.has(a.key) ? ' (new: unreviewed)' : ''}`
        );
      for (const a of others)
        console.log(
          `  ${a.facing.padEnd(8)} ${a.key} ${JSON.stringify(a.body)}`
        );
      for (const s of m.suggested || [])
        console.log(
          `  suggested by entry ${s.entry} for ${s.arms.join(', ')} (not coverage): ${JSON.stringify(s.why)}`
        );
    }
  for (const u of r.unearnedMixed) {
    say(
      `UNEARNED-MIXED ${u.fingerprint} @${u.at} ${u.callee}() arg ${u.position}: ${u.model.length} model arm(s) whose text is also used outside these calls, ${u.other.length} ui/internal arm(s)`
    );
    for (const a of u.model)
      say(
        `  model    ${a.key} ${JSON.stringify(preview(a.body))} (also at ${a.elsewhere.join(', ')})`
      );
    for (const a of u.other)
      say(
        `  ${a.facing.padEnd(8)} ${a.key} ${JSON.stringify(preview(a.body))}`
      );
  }
  if (r.unearnedMixed.length)
    say(
      `unearned mixed call groups: ${r.unearnedMixed.length} (advisory, not gated: a model arm written as a literal argument whose text is also used outside the group's calls)`
    );
  const arms = open.reduce((n, m) => n + m.uncovered.length, 0);
  const p = pruneReviews(allowlist, r.mixed);
  const stale =
    p.removedEntries.length + p.removedArms.length + p.rekeyed.length;
  say(
    `mixed call verdicts: ${open.length} unreviewed of ${r.mixed.length} call group(s) ruled both model and ui/internal (${arms} arm(s) to review${stale ? `; ${p.removedEntries.length} stale entr(ies), ${p.removedArms.length} stale arm(s), ${p.rekeyed.length} to re-key: run --prune` : ''})`
  );
  process.exit(
    r.unparsed.length || collisions.length ? 2 : open.length ? 1 : 0
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
