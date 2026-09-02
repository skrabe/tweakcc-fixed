#!/usr/bin/env node
// Report runtime interpolations a trim or suppression removed entirely.
//
// A prompt body carries two kinds of runtime token, and they are NOT scoped the
// same way. `${IDENTIFIER}` slots the patcher binds POSITIONALLY into this
// prompt's site in the binary, so the last one has to survive in THIS file or
// that site's binding is gone. `{{TEMPLATE}}` names CC resolves at render from
// the model catalogue, with no positional binding at all (the prompts carrying
// them have `identifiers: []`), so the question there is only whether the value
// still reaches the model ANYWHERE in the override set. A trim may delete a
// sentence containing either — that is allowed. What is almost never intended
// is deleting the last occurrence within the token's own scope.
//
// Conflating the two produced a false finding on 2.1.237: the managed-agents
// trim deleted a TypeScript sample fence whose only `{{OPUS_ID}}` was
// decorative, while the same token stayed live in the CreateAgent schema of
// data-managed-agents-endpoint-reference. Per-file scoping called that a loss.
//
// So the rule is deliberately not "the token sets must match". It is: a token
// pristine has and the deployed body has ZERO of. Measured on the CC 2.1.226
// audit that is 4 findings across 67 changed overrides, and one of the four was
// a real miss nothing else could see — `data-multiple-browsers-connected-tool-result`
// deleted `${VAR_1(VAR_2.askUserToolName)}` as "pure interpolation" when it
// renders the only instruction on an isError result, and the adversarial pass
// never selected it because that verdict cited no sibling.
//
// Scope matters. Run against a bump's CHANGED ids and it is a gate. Run it
// across the whole set and it is an INVENTORY of every such decision ever made
// — ~100 of 859 overrides — which is interesting once and useless as a gate, so
// `--all` reports and exits 0 while the scoped form exits non-zero.
//
// Usage:
//   node tools/checkTrimSlots.mjs <prompts.json> --set=<abs dir> --ids=<file>
//   node tools/checkTrimSlots.mjs <prompts.json> --set=<abs dir> --all
//     --ids  newline-separated ids this run changed. Gate mode.
//     --all  every override that differs from pristine. Report mode, exits 0.
//     --json <path>  write the findings for a downstream verifier packet.
//
// A drop that was reviewed and ruled correct (the sentence carrying the slot
// was itself justified to cut, or a suppressed example whose slot only named
// a callee) is recorded in data/trim-slot-allowlist.json, keyed
// `<id>` -> `{ <token>: <reason> }`. Until that file existed a ruled-on drop
// re-entered the worklist every time its id was touched, and the review that
// settled it lived only in a run transcript. The allowlist row is keyed on
// the deployed body's hash so a later edit to the override re-opens the
// question; a row for a token that is present again is reported as stale.
//
// Exit 0 = no findings (or --all), 1 = findings, 2 = could not run.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const TOKEN = /\$\{[^}]{0,120}\}|\{\{[^}]{0,80}\}\}/g;

// `${...}` can nest a whole ternary, and the naive match then truncates at the
// first inner `}`. A slot's identity is its opening identifier, so compare on
// that; and drop the degenerate forms reconstruction can produce (`${}`,
// `${""}`), which name nothing and would be pure noise.
export const normalizeToken = tok => {
  const inner = tok.replace(/^\$\{|^\{\{|\}\}$|\}$/g, '').trim();
  if (!inner || /^(["']{2})$/.test(inner)) return null;
  const lead = inner.match(/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*/);
  return lead ? lead[0] : null;
};

export const tokensOf = s =>
  new Set(((s || '').match(TOKEN) || []).map(normalizeToken).filter(Boolean));

// The canonical reconstruction: the `${` and `}` are already in the pieces, so
// the BARE label is appended, and the map key is identifiers[i] — never i.
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

// A same-id multi-site prompt binds a different slot set per site, so the
// override has to satisfy the UNION — checking only the first entry is the
// same first-entry-only mistake that has misclassified stubs before.
export const isTemplateToken = raw => raw.startsWith('{{');

// Split a body's tokens by scope. Positional `${}` slots are keyed per-file;
// `{{}}` catalogue templates are keyed set-wide.
export const scopedTokensOf = s => {
  const slots = new Set();
  const templates = new Set();
  for (const raw of (s || '').match(TOKEN) || []) {
    const name = normalizeToken(raw);
    if (!name) continue;
    (isTemplateToken(raw) ? templates : slots).add(name);
  }
  return { slots, templates };
};

// `setTemplates` is every `{{}}` name still live anywhere in the override set.
// Omit it and template tokens fall back to per-file scoping, which is the old
// (over-strict) behaviour — callers that cannot see the whole set keep working.
export const lostTokens = (pristineBodies, deployed, setTemplates = null) => {
  const have = scopedTokensOf(deployed);
  const wantSlots = new Set();
  const wantTemplates = new Set();
  for (const b of pristineBodies) {
    const w = scopedTokensOf(b);
    for (const t of w.slots) wantSlots.add(t);
    for (const t of w.templates) wantTemplates.add(t);
  }
  const lost = [...wantSlots].filter(t => !have.slots.has(t));
  for (const t of wantTemplates) {
    if (have.templates.has(t)) continue;
    if (setTemplates && setTemplates.has(t)) continue;
    lost.push(t);
  }
  return lost;
};

const main = () => {
  const die = (msg, code = 2) => {
    console.error(`checkTrimSlots: ${msg}`);
    process.exit(code);
  };

  const args = process.argv.slice(2);
  const jsonPath = args.find(a => !a.startsWith('--'));
  const setDir = (args.find(a => a.startsWith('--set=')) || '').slice(6);
  const idsFile = (args.find(a => a.startsWith('--ids=')) || '').slice(6);
  const all = args.includes('--all');
  const outIdx = args.indexOf('--json');
  const outPath = outIdx === -1 ? null : args[outIdx + 1];

  if (!jsonPath || !setDir)
    die('usage: <prompts.json> --set=<dir> (--ids=<file> | --all) [--json <path>]');
  if (!idsFile && !all)
    die(
      'pass --ids=<file> to gate a bump, or --all to inventory the whole set — ' +
        'an unscoped gate reports every historical decision and gets ignored'
    );
  if (!fs.existsSync(jsonPath)) die(`no prompts JSON at ${jsonPath}`);
  if (!fs.existsSync(setDir)) die(`no override set at ${setDir}`);

  const prompts = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).prompts || [];
  const pristine = new Map();
  for (const p of prompts) {
    if (!p.id) continue;
    if (!pristine.has(p.id)) pristine.set(p.id, []);
    pristine.get(p.id).push(reconstruct(p));
  }

  const bodyOf = id => stripFrontmatter(fs.readFileSync(path.join(setDir, `${id}.md`), 'utf8'));

  const ids = idsFile
    ? fs.readFileSync(idsFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    : [...pristine.keys()].filter(id => {
        if (!fs.existsSync(path.join(setDir, `${id}.md`))) return false;
        const b = bodyOf(id).trim();
        return !pristine.get(id).some(p => p.trim() === b);
      });

  // Catalogue templates are set-scoped, so build the live set once: every `{{}}`
  // name still present in ANY override in this set. Reading the whole dir is
  // ~3k small files and takes well under a second; a per-file gate that cannot
  // see this produces false losses whenever a token moves between siblings.
  const setTemplates = new Set();
  for (const f of fs.readdirSync(setDir)) {
    if (!f.endsWith('.md')) continue;
    for (const t of scopedTokensOf(fs.readFileSync(path.join(setDir, f), 'utf8')).templates)
      setTemplates.add(t);
  }

  const allowPath = path.join(
    path.dirname(url.fileURLToPath(import.meta.url)),
    '..',
    'data',
    'trim-slot-allowlist.json'
  );
  const allow = fs.existsSync(allowPath) ? JSON.parse(fs.readFileSync(allowPath, 'utf8')) : {};
  const bodyHash = b => crypto.createHash('sha1').update(b.trim()).digest('hex').slice(0, 12);

  const findings = [];
  const justified = [];
  const stale = [];
  for (const id of ids) {
    if (!pristine.has(id) || !fs.existsSync(path.join(setDir, `${id}.md`))) continue;
    const body = bodyOf(id);
    const all = lostTokens(pristine.get(id), body, setTemplates);
    const rule = allow[id];
    const live = rule && rule.bodyHash === bodyHash(body) ? rule.tokens || {} : {};
    if (rule && rule.bodyHash !== bodyHash(body))
      stale.push({ id, why: `override body changed (now ${bodyHash(body)}); re-review and re-key the row` });
    for (const t of Object.keys(live)) if (!all.includes(t)) stale.push({ id, why: `${t} is present again; delete the row` });
    const lost = all.filter(t => !(t in live));
    for (const t of all) if (t in live) justified.push({ id, token: t, reason: live[t] });
    if (lost.length)
      findings.push({ id, suppressed: body.trim() === '', lost, remaining: [...tokensOf(body)] });
  }
  for (const j of justified) console.log(`  ✓ ${j.id}: ${j.token} — justified: ${j.reason}`);
  for (const st of stale) console.log(`  ! ${st.id}: allowlist row is stale — ${st.why}`);

  if (outPath) fs.writeFileSync(outPath, JSON.stringify(findings, null, 1));

  if (!findings.length) {
    console.log(
      `checkTrimSlots: 0 — every runtime token still has a home across ${ids.length} changed override(s)`
    );
    process.exit(0);
  }

  console.log(
    `checkTrimSlots: ${findings.length} override(s) dropped the last occurrence of a runtime token (of ${ids.length} checked)`
  );
  for (const f of findings) {
    console.log(`  ${f.suppressed ? 'suppressed' : 'trimmed'}  ${f.id}`);
    for (const t of f.lost) console.log(`      lost  ${t}`);
  }
  console.log(
    '\nNot automatically wrong: deleting a sentence whole takes its token with it.\n' +
      'Each one needs a reason — hand them to the adversarial pass rather than reverting blind.'
  );
  process.exit(all ? 0 : 1);
};

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  main();
}
