#!/usr/bin/env node
// Call-slot audit — the prevention gate for the "override calls a value slot as a
// function" bug class (see reference_print_smoke_misses_interactive_prompt_bugs).
// An override that writes `${VAR()}` (or `${VAR(args)}`) is only safe if VAR's
// pristine slot is itself a call. If the binary interpolates that slot as a bare
// value (`${e}`, often a pre-computed `let e=fn();...${e}`), the spliced `${e()}`
// calls a string -> runtime TypeError. The scratchpad-directory override shipped
// exactly this (2.1.186 / PR #19): it broke EVERY interactive TUI turn while
// `claude --print` passed clean, because `--print` returns null before the line.
// None of the other static gates catch it: `${e()}` parses fine, and the
// mis-bind / orphan-var gates check slot bindings, not call-vs-value.
//
// The invariant (deterministic, no TUI needed): the pristine JSON content
// reconstructs each interpolation with the identifier NAME stripped but the
// surrounding syntax kept -> a direct call is `${(...)}` (char after `${` is
// `(`), a bare value is `${}`, a member is `${.x}`. So per prompt, the number of
// DISTINCT vars an override calls must not exceed the number of direct-call
// interpolations the pristine has. scratchpad: 1 called var vs 0 pristine calls
// -> flagged. (This is a necessary condition; it nails the realistic class where
// an author adds a spurious call. A real interactive turn remains the belt+braces
// for the rarer call-the-bare-and-skip-the-real-fn swap.)
//
// Two checks run: the per-prompt call COUNT above, and a per-label SHAPE check
// (see below) that resolves what each slot actually is and catches the opposite
// direction too — an override reading a call slot as a bare value.
//
// Usage: node tools/auditCallSlots.mjs [prompts.json] [--set=<dir> | set-dir ...]
//          [--ids=<file of ids, one per line>]
// Same flag shapes as checkTrimSlots and checkFactCoverage; --ids limits the
// audit to those prompt ids.
// Exits non-zero on any shape disagreement, and 2 if it could not run at all.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseOverrideArgs, resolveOverrideSets, printAuditedSets } =
  require('./lib/overrideSets.cjs');

//
// Every maintained set is scanned, not one. This bug class is exactly the
// parallel-set-drift case: `--apply` rebases only the ACTIVE set, so a stale
// `${VAR()}` on a slot that became a bare value survives in the OTHER sets for
// dozens of releases while the active set stays green. Defaulting to a single
// hardcoded set name made the gate blind to the failures it exists to find.
const newestJson = () => {
  try {
    return fs
      .readdirSync('data/prompts')
      .filter(f => /^prompts-\d+\.\d+\.\d+\.json$/.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .pop();
  } catch {
    return null;
  }
};
const parsed = parseOverrideArgs(process.argv.slice(2));
const idsArg = parsed.rest.find(a => a.startsWith('--ids='));
parsed.rest = parsed.rest.filter(a => a !== idsArg);
const unknown = parsed.rest.filter(a => a.startsWith('--'));
if (unknown.length) {
  console.error(`call-slot audit: unknown flag ${unknown.join(', ')}`);
  process.exit(2);
}
let onlyIds = null;
if (idsArg) {
  try {
    onlyIds = new Set(
      fs
        .readFileSync(idsArg.slice('--ids='.length), 'utf8')
        .split(/\s+/)
        .filter(Boolean)
    );
  } catch (e) {
    console.error(`call-slot audit: SKIPPED — ids file unreadable (${e.message}).`);
    process.exit(2);
  }
}
const extraDirs = parsed.rest.slice(1);
if (extraDirs.length) {
  parsed.explicit.push(...extraDirs);
  parsed.specified = true;
}
const overrideDirs = resolveOverrideSets(parsed, { fallback: 'applied' });
printAuditedSets(overrideDirs);
const VER = process.env.CC_VER || null;
const ourJson =
  parsed.rest[0] ||
  (VER ? `data/prompts/prompts-${VER}.json` : `data/prompts/${newestJson()}`);

let OURS;
try {
  OURS = JSON.parse(fs.readFileSync(ourJson, 'utf8'));
} catch (e) {
  // A gate that could not run is a gate that did not run: exit non-zero so it
  // can never be read as "found nothing".
  console.error(`call-slot audit: SKIPPED — prompts JSON '${ourJson}' missing/unreadable (${e.message}).`);
  process.exit(2);
}
const files = [];
for (const set of overrideDirs) {
  let entries;
  try {
    entries = fs.readdirSync(set.dir).filter(f => f.endsWith('.md'));
  } catch (e) {
    console.error(`call-slot audit: SKIPPED — overrides dir '${set.dir}' missing (${e.message}).`);
    process.exit(2);
  }
  for (const f of entries) files.push({ dir: set.dir, name: set.name, f });
}

// id -> max number of direct-call interpolations across that id's JSON entries
// (multisite ids splice the same prompt; the override needs the calls to exist at
// the site it targets, so the lenient max avoids false positives on a variant).
const promptBody = p =>
  p.content || (p.pieces || []).filter(x => typeof x === 'string').join('');
const directCalls = s => (s.match(/\$\{\(/g) || []).length;
const callsById = {};
for (const p of OURS.prompts) {
  if (!p.id) continue;
  const n = directCalls(promptBody(p));
  callsById[p.id] = Math.max(callsById[p.id] ?? 0, n);
}

// The count check above is one-directional: it catches ${VAR()} on a value slot
// (a TypeError) but not ${VAR} on a CALL slot, which interpolates the FUNCTION
// OBJECT into the prompt — wrong content, no crash, and invisible to apply,
// four zeros and the smoke. 2.1.233 turned webfetch's
// ${eZ_} into ${eZ_()} and three sets kept the bare form.
//
// So also resolve each label's slot SHAPE. Pieces already carry the `${` and `}`,
// so identifiers[i] labels the slot between pieces[i] and pieces[i+1], and the
// first char of pieces[i+1] gives the shape: `(` a direct call, `.` a member,
// anything else a bare value. A label reused across slots collects every shape it
// legitimately takes, and only a shape outside that set is a finding.
const shapeOf = next => (next.startsWith('(') ? 'call' : next.startsWith('.') ? 'member' : 'value');
const shapesById = {};
for (const p of OURS.prompts) {
  if (!p.id || !Array.isArray(p.pieces) || !Array.isArray(p.identifiers)) continue;
  const map = p.identifierMap || {};
  const byLabel = (shapesById[p.id] ??= {});
  for (let i = 0; i < p.identifiers.length; i += 1) {
    const label = map[String(p.identifiers[i])];
    const next = p.pieces[i + 1];
    if (!label || typeof next !== 'string') continue;
    (byLabel[label] ??= new Set()).add(shapeOf(next));
  }
}

const findings = [];
for (const { dir, name, f } of files) {
  const id = f.slice(0, -3);
  // Only named-prompt overrides map to the JSON. inline-* / system-reminder-* use
  // other surfaces (positional remap / registry) and aren't in prompts JSON.
  if (!(id in callsById)) continue;
  if (onlyIds && !onlyIds.has(id)) continue;
  const raw = fs.readFileSync(`${dir}/${f}`, 'utf8');
  const body = (raw.match(/^<!--[\s\S]*?-->\n?([\s\S]*)$/) || [, raw])[1];
  // Distinct vars the override CALLS: ${VAR( ... — VAR immediately followed by `(`
  // (a direct call on VAR). Member-calls ${VAR.method( are not a direct call on
  // VAR and are correctly excluded. Skip escaped \${.
  const calledVars = new Set(
    [...body.matchAll(/(?<!\\)\$\{([A-Z][A-Z0-9_]+)\(/g)].map(m => m[1])
  );

  // Shape check, both directions, per label.
  const shapes = shapesById[id];
  if (shapes) {
    for (const m of body.matchAll(/(?<!\\)\$\{([A-Z][A-Z0-9_]+)([(.]?)/g)) {
      const [, label, punct] = m;
      const known = shapes[label];
      if (!known) continue;
      const used = punct === '(' ? 'call' : punct === '.' ? 'member' : 'value';
      if (known.has(used)) continue;
      findings.push(
        `${name}/${id}: override interpolates \${${label}${punct}} as a ${used}, but pristine only ever uses that slot as ${[...known].join('/')} — a call slot read as a value emits the function itself into the prompt`
      );
    }
  }

  if (!calledVars.size) continue;
  const available = callsById[id];
  if (calledVars.size > available) {
    findings.push(
      `${name}/${id}: override calls ${calledVars.size} distinct var(s) [${[...calledVars].join(', ')}] but pristine has only ${available} direct-call slot(s) — a ${'${VAR()}'} on a bare value slot throws at runtime`
    );
  }
}

if (findings.length) {
  console.error(
    `CALL-SLOT BUGS: ${findings.length} (an override's interpolation shape disagrees with the pristine slot)`
  );
  for (const m of findings) console.error('  ' + m);
  console.error(
    '\nFix: match the pristine shape exactly. Pristine renders a call as ${(...)}, a member as ${.x}, a value as ${}. ${VAR()} on a value slot throws at runtime; ${VAR} on a call slot silently interpolates the function itself. See reference_print_smoke_misses_interactive_prompt_bugs.'
  );
  process.exit(1);
}
console.log(
  `call-slot audit: 0 (every override interpolation matches its pristine slot shape; ${onlyIds ? `${files.filter(x => onlyIds.has(x.f.slice(0, -3))).length} of ` : ''}${files.length} file(s) across ${overrideDirs.length} set(s))`
);
