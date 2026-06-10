#!/usr/bin/env node
// Surviving-placeholder (orphan) report — the apply-time companion to the
// mis-bind audit. Where auditMisbinds.mjs checks placeholders the override DOES
// bind (right name, wrong slot), this enumerates placeholders that bind to
// NOTHING: a `${...}` whose leading identifier is not a known slot for its
// prompt, so it survives `--apply` as a raw `${NAME}` into a live template
// literal and fires `ReferenceError: NAME is not defined` at boot. That runtime-
// orphan class is what boot-verify catches live (e.g. IS_TRUTHY_FN on 2.1.168/
// .169); this tool surfaces the same set statically, as structured data, so a
// downstream gate can map each finding to its ReferenceError signature without a
// live install. auditMisbinds deliberately skips this set ("leak/uncomparable:
// other gates cover it") — this is that other gate.
//
// Two things distinguish detection from a bare-`${NAME}` scan:
//   1. It covers the EXPRESSION class, not just bare names. The crashing forms
//      are interpolation expressions — `${!IS_TRUTHY_FN(PROCESS_OBJECT.env.X)&&..?`…`}`,
//      `${ATTACHMENT_OBJECT.blockingError.command}`, `${ADDITIONAL_DREAM_GUIDANCE_FN()}`.
//      The leading identifier of the expression is the one that must resolve in
//      runtime scope, so that is what we extract. (auditMisbinds' `\$\{([A-Z]…)`
//      regex matches only when the identifier is FLUSH against `${`, so it misses
//      the leading-operator forms like `${!IS_TRUTHY_FN(…)` entirely.)
//   2. Escaped `\${…}` is inert (the patcher emits it as a literal dollar-brace),
//      so it is never an orphan and is not flagged.
//
// Known-slot set, per prompt: the prompt's own identifierMap values (the slots
// the patcher can actually fill for that prompt). For an override whose id has no
// counterpart in the prompts JSON (a tweakcc-own prompt), fall back to the UNION
// of identifierMap values across every prompt — the conservative floor that still
// flags names that are a slot NOWHERE (PROCESS_OBJECT, CRON_DURABLE_FLAG, …).
// No ALL_CAPS grammar guessing: the slot vocabulary is taken only from the JSON.
//
// The union here intentionally mirrors `loadIdentifierMapUnion` in
// src/systemPromptSync.ts (the apply path's skip-guard source). If this lands in
// the apply path instead of as a standalone tool, it should call that directly
// rather than re-deriving the union — see the PR for that redirect. Two things the
// apply-path guard does NOT do today, which this adds: (1) it matches only the
// bare `${NAME}` form (regex requires `}` flush after the name), so it misses the
// expression class that actually boot-crashes; (2) it only SKIPS names that ARE
// in the union — it never emits the surviving set that is absent from the union
// (PROCESS_OBJECT) or per-prompt-orphaned (IS_TRUTHY_FN on a prompt that has no
// such slot). That surviving set is what a downstream gate needs.
//
// Opt-in: this is a standalone tool. It writes a single JSON object to stdout and
// touches nothing in the normal `--apply` path.
//
// Usage:
//   node tools/reportOrphans.mjs [promptsJson] [overridesDir]
// Defaults target the local showtime layout (same as auditMisbinds.mjs).
//
// Output (stdout, one JSON object):
//   { "version": "2.1.x", "prompts": { "<promptId>": ["VAR", ...] } }
// keyed per prompt id + variable, so the consumer maps each finding to a
// `ReferenceError: <VAR> is not defined` signature. Empty `prompts` => no
// surviving placeholders found. Exit code is always 0 (a report, not a gate);
// the consumer decides what a non-empty set means.
import fs from 'node:fs';
import path from 'node:path';

const VER = process.env.CC_VER || '2.1.168';
const promptsJson = process.argv[2] || `data/prompts/prompts-${VER}.json`;
const overridesDir =
  process.argv[3] ||
  `${process.env.HOME}/.tweakcc/lobotomized-claude-code/system-prompts-opus-4-8`;

// --- pure helpers (version-independent; unit-tested in reportOrphans.test.mjs) ---

// Extract the leading identifier of every unescaped `${...}` interpolation in a
// body. The leading identifier is the first [A-Z][A-Z0-9_]+ token immediately
// inside the braces, after any leading operators/whitespace (`!`, spaces) but
// before any `(`, `.`, etc. — that is the name that must resolve in runtime scope
// for the expression to evaluate. Returns names in source order (deduped by the
// caller). Escaped `\${...}` is skipped via the lookbehind.
export function extractLeadingIdentifiers(body) {
  const out = [];
  const open = /(?<!\\)\$\{/g;
  let m;
  while ((m = open.exec(body)) !== null) {
    const rest = body.slice(m.index + 2);
    // skip leading unary operators / whitespace, then require an UPPER-led ident.
    const id = rest.match(/^[\s!~+\-]*([A-Z][A-Z0-9_]+)/);
    if (id) out.push(id[1]);
  }
  return out;
}

// Build the set of known slot names for a prompts JSON: the union of every
// prompt's identifierMap values. Also returns a per-id map of that prompt's own
// slot names, so callers can prefer the precise per-prompt set.
export function buildKnownSlots(promptsData) {
  const union = new Set();
  const byId = {};
  for (const p of promptsData.prompts || []) {
    const slots = new Set(Object.values(p.identifierMap || {}));
    if (p.id) byId[p.id] = slots;
    for (const v of slots) union.add(v);
  }
  return { union, byId };
}

// The surviving-placeholder set for one override body, given its prompt id and
// the known-slot model. Per-prompt slots are authoritative when the id is in the
// JSON; otherwise fall back to the union. A leading identifier not in that set is
// a surviving placeholder (would be a ReferenceError at runtime).
export function survivingPlaceholders(body, id, known) {
  const slots = known.byId[id] || known.union;
  const seen = new Set();
  const orphans = [];
  for (const name of extractLeadingIdentifiers(body)) {
    if (slots.has(name) || seen.has(name)) continue;
    seen.add(name);
    orphans.push(name);
  }
  return orphans;
}

// --- driver (only runs when invoked as a script, not on import) ---

function stripFrontmatter(raw) {
  return (raw.match(/^<!--[\s\S]*?-->\n?([\s\S]*)$/) || [, raw])[1];
}

function main() {
  const promptsData = JSON.parse(fs.readFileSync(promptsJson, 'utf8'));
  const known = buildKnownSlots(promptsData);

  const prompts = {};
  for (const f of fs.readdirSync(overridesDir)) {
    if (!f.endsWith('.md')) continue;
    const id = f.slice(0, -3);
    // inline-* overrides remap minified idents positionally, not by name — the
    // identifierMap model does not apply to them (same carve-out as auditMisbinds).
    if (id.startsWith('inline-')) continue;
    const body = stripFrontmatter(
      fs.readFileSync(path.join(overridesDir, f), 'utf8')
    );
    const orphans = survivingPlaceholders(body, id, known);
    if (orphans.length) prompts[id] = orphans;
  }

  process.stdout.write(
    JSON.stringify({ version: promptsData.version, prompts }, null, 2) + '\n'
  );
}

// Run only as a script. Importing the helpers (e.g. from the test) is side-effect
// free.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
