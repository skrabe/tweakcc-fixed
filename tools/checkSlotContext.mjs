#!/usr/bin/env node
// Report slots a trim kept while cutting the words that gave them meaning.
//
// checkTrimSlots asks whether a runtime token still occurs. It cannot see a
// trim that keeps the token and deletes its sentence around it. CC 2.1.291
// shipped exactly that: data-task-notification-queued-remote-notifications-nudge
// was pristine `... before you read them). Call ${VAR} now, before other work,
// and keep calling it until it reports 0 remaining. ...` and the override kept
// `... before you read them). ${VAR}` — a bare tool name dangling after the
// sentence that used to tell the model to call it. Slot present, label bound,
// apply clean, smoke green: every gate passed.
//
// The rule compares each slot occurrence in a trimmed body against every
// pristine occurrence of the same label, on its two nearest context tokens:
//
//   - A context token is the nearest WORD on that side (letters, digits, `_`,
//     `'`, `-`, compared case-insensitively), the nearest neighbouring SLOT
//     (named by its leading identifier), or a BOUNDARY. Quotes, brackets,
//     commas, colons, dashes, escaped backticks, markdown emphasis and the
//     articles a/an/the are transparent: they decorate the slot's phrase, they
//     do not say what the slot is for (`use the ${X} tool` == `use ${X}`).
//   - A boundary is a sentence end (`.` `!` `?` not followed by a word char),
//     a newline, the start or end of the body, or the edge of a template
//     branch inside a conditional. A word across a sentence break belongs to
//     a different idea, so it says nothing about this slot.
//   - Every label an interpolation RENDERS shares that interpolation's context
//     (`${f(B.y)}`, the branches of `${C?B:""}`); a ternary condition renders
//     nothing of its own and is skipped; labels inside a nested template branch
//     take the context of the prose in that branch.
//
// A finding is an occurrence whose left token matches NO pristine occurrence
// of that label AND whose right token matches none either. One surviving side
// means the slot is still anchored in a phrase the author kept; both sides
// gone means its phrase was cut or rewritten.
//
// Measured 2026-10-07 on the CC 2.1.292 LCC set (769 trims, 1005 slot
// occurrences in 314 of them), with the 2.1.291 failure as the negative
// control (override left BOUNDARY vs pristine `call`, right BOUNDARY vs `now`
// — flagged under every variant below):
//   nearest word, articles significant ............ 32 findings / 19 files
//   + articles transparent ......................... 24 / 15
//   + ternary conditions skipped (this unit) ....... 20 / 12
//   two-token window instead of one ................ 34 / 20 (stricter, noisier)
// Of the 20, one was a real defect (tool-description-artifact-database-guidance
// moved the comma-terminated `"str_replace" ...,` list fragment out of the
// write_db op list to after a full stop) and 19 were deliberate rewordings,
// each read and ruled on in data/slot-context-allowlist.json.
//
// Not automatically wrong: an author may rewrite a slot's sentence on purpose.
// Each finding needs a reason, recorded per label in
// data/slot-context-allowlist.json keyed `<id>` -> `{ bodyHash, tokens: {
// <label>: <reason> } }`. The row is keyed on the deployed body's hash so an
// edit re-opens it; a row whose label no longer fires is reported as stale.
//
// Usage:
//   node tools/checkSlotContext.mjs <prompts.json> --set=<abs dir> --ids=<file>
//   node tools/checkSlotContext.mjs <prompts.json> --set=<abs dir> --all
//   node tools/checkSlotContext.mjs <prompts.json> --sets=<a>,<b> --all
//     --ids  newline-separated ids this run changed.
//     --all  every trimmed override in the set(s).
//     --json <path>  write the findings for a downstream verifier packet.
//
// Exit 0 = no unreviewed findings, 1 = findings or stale rows, 2 = could not run.

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const {
  parseOverrideArgs,
  resolveOverrideSets,
  printAuditedSets,
} = require('./lib/overrideSets.cjs');

export const BOUNDARY = '⟂';
// Articles decorate the slot's noun phrase without saying what it is for:
// `use the ${X} tool` and `use ${X}` are the same instruction.
const TRANSPARENT = new Set(['a', 'an', 'the']);

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

export const bodyHash = b =>
  crypto.createHash('sha1').update(b.trim()).digest('hex').slice(0, 12);

const isWordChar = c => /[\p{L}\p{N}_'-]/u.test(c);
const isIdentStart = c => /[A-Za-z_$]/.test(c);
const isIdentChar = c => /[\w$]/.test(c);
const escaped = (s, i) => {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++;
  return n % 2 === 1;
};

// Parse `${ ... }` starting just after the `${`. Returns the index after the
// closing `}` and the identifiers whose value the interpolation RENDERS. A
// ternary's condition (`${HAS_X?`...`:""}`, `${F()?"a":"b"}`) only picks a
// branch; the text that reaches the model is the branch, whose own slots are
// checked inside it, so the condition has no phrase of its own to lose. Nested
// template branches are scanned as independent runs.
const parseExpr = (s, i, runs) => {
  const rendered = [];
  let pending = [];
  let first = null;
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '}' && depth === 0) {
      rendered.push(...pending);
      return { end: i + 1, idents: rendered, first };
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0 && c === '?') {
      if (s[i + 1] === '?' || s[i + 1] === '.') {
        i += 2;
        continue;
      }
      pending = [];
    } else if (depth === 0 && c === ':') {
      rendered.push(...pending);
      pending = [];
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && !(s[j] === c && !escaped(s, j))) j++;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const run = scanRun(s, i + 1, true, runs);
      i = run.end + 1;
      continue;
    }
    if (
      isIdentStart(c) &&
      !(i > 0 && (isIdentChar(s[i - 1]) || s[i - 1] === '.'))
    ) {
      let j = i + 1;
      while (j < s.length && isIdentChar(s[j])) j++;
      pending.push(s.slice(i, j));
      first ??= s.slice(i, j);
      i = j;
      continue;
    }
    i++;
  }
  rendered.push(...pending);
  return { end: s.length, idents: rendered, first };
};

// Scan a prose run (the body, or a template branch inside an expression) into
// a stream of context items. Each finished stream is pushed onto `runs`.
const scanRun = (s, i, inTemplate, runs) => {
  const items = [{ t: 'b' }];
  while (i < s.length) {
    const c = s[i];
    if (inTemplate && c === '`' && !escaped(s, i)) break;
    if (c === '$' && s[i + 1] === '{' && !escaped(s, i)) {
      const { end, idents, first } = parseExpr(s, i + 2, runs);
      items.push({ t: 's', idents, lead: first });
      i = end;
      continue;
    }
    if (c === '\n') {
      items.push({ t: 'b' });
      i++;
      continue;
    }
    if (/[.!?]/.test(c) && !(i + 1 < s.length && isWordChar(s[i + 1]))) {
      items.push({ t: 'b' });
      i++;
      continue;
    }
    if (isWordChar(c)) {
      let j = i + 1;
      while (j < s.length && isWordChar(s[j])) j++;
      const v = s.slice(i, j).toLowerCase();
      if (/[\p{L}\p{N}]/u.test(v) && !TRANSPARENT.has(v))
        items.push({ t: 'w', v });
      i = j;
      continue;
    }
    i++;
  }
  items.push({ t: 'b' });
  runs.push(items);
  return { end: i };
};

const ctxToken = item =>
  item.t === 'b'
    ? BOUNDARY
    : item.t === 'w'
      ? item.v
      : `\${${item.lead || '?'}}`;

// Every slot occurrence in `text`, as { label, left, right }. Only labels in
// `labels` are reported; a label repeated inside one interpolation counts once.
export const slotOccurrences = (text, labels) => {
  const runs = [];
  scanRun(text || '', 0, false, runs);
  const out = [];
  for (const items of runs) {
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (it.t !== 's') continue;
      const left = ctxToken(items[k - 1]);
      const right = ctxToken(items[k + 1]);
      for (const label of new Set(it.idents))
        if (labels.has(label)) out.push({ label, left, right });
    }
  }
  return out;
};

export const labelsOf = entries => {
  const set = new Set();
  for (const p of entries)
    for (const v of Object.values(p.identifierMap || {})) set.add(v);
  return set;
};

// The core rule. `entries` are the catalogue entries for one id (a multi-site
// id has several); `body` is the deployed override body.
export const contextFindings = (entries, body) => {
  const labels = labelsOf(entries);
  const lefts = new Map();
  const rights = new Map();
  for (const p of entries)
    for (const o of slotOccurrences(reconstruct(p), labels)) {
      if (!lefts.has(o.label)) lefts.set(o.label, new Set());
      if (!rights.has(o.label)) rights.set(o.label, new Set());
      lefts.get(o.label).add(o.left);
      rights.get(o.label).add(o.right);
    }
  const out = [];
  for (const o of slotOccurrences(body, labels)) {
    if (!lefts.has(o.label)) continue;
    if (lefts.get(o.label).has(o.left) || rights.get(o.label).has(o.right))
      continue;
    out.push({
      ...o,
      pristineLeft: [...lefts.get(o.label)],
      pristineRight: [...rights.get(o.label)],
    });
  }
  return out;
};

export const isTrim = (entries, body) => {
  const b = body.trim();
  if (!b) return false;
  return !entries.some(p => reconstruct(p).trim() === b);
};

// Fold the allowlist over raw findings. `bodies` maps id -> [deployed bodies]
// (one per audited set) so a row can be judged against every set at once.
export const evaluate = ({ entriesById, bodiesById, ids, allow = {} }) => {
  const findings = [];
  const justified = [];
  const stale = [];
  let checked = 0;
  for (const id of ids) {
    const entries = entriesById.get(id);
    if (!entries) continue;
    const rule = allow[id];
    let ruleUsed = false;
    const firedLabels = new Set();
    for (const { set, body } of bodiesById.get(id) || []) {
      if (!isTrim(entries, body)) continue;
      checked++;
      const raw = contextFindings(entries, body);
      const live =
        rule && rule.bodyHash === bodyHash(body) ? rule.tokens || {} : {};
      if (rule && rule.bodyHash === bodyHash(body)) ruleUsed = true;
      for (const f of raw) {
        if (f.label in live) {
          firedLabels.add(f.label);
          justified.push({ id, set, label: f.label, reason: live[f.label] });
        } else findings.push({ id, set, ...f });
      }
    }
    if (rule && !ruleUsed)
      stale.push({
        id,
        why: `no audited body matches bodyHash ${rule.bodyHash}; re-review and re-key the row`,
      });
    else if (rule)
      for (const label of Object.keys(rule.tokens || {}))
        if (!firedLabels.has(label))
          stale.push({ id, why: `${label} no longer fires; delete the row` });
  }
  const seen = new Set();
  const dedupJustified = justified.filter(j => {
    const k = `${j.id}\0${j.set}\0${j.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { findings, justified: dedupJustified, stale, checked };
};

const shadowedIds = setDir => {
  const shadowed = new Set();
  for (const dir of [
    setDir,
    path.join(path.dirname(setDir), 'system-reminders'),
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const fm = fs.readFileSync(path.join(dir, f), 'utf8').split('-->')[0];
      const m = fm.match(/^shadows:\n((?:\s+-\s+.*\n?)+)/m);
      if (!m) continue;
      for (const line of m[1].split('\n')) {
        const id = line.replace(/^\s+-\s+/, '').trim();
        if (id) shadowed.add(id);
      }
    }
  }
  return shadowed;
};

const main = () => {
  const die = (msg, code = 2) => {
    console.error(`checkSlotContext: ${msg}`);
    process.exit(code);
  };

  const parsed = parseOverrideArgs(process.argv.slice(2));
  const args = parsed.rest;
  const jsonPath = args.find(a => !a.startsWith('--'));
  const idsFile = (args.find(a => a.startsWith('--ids=')) || '').slice(6);
  const all = args.includes('--all');
  const outIdx = args.indexOf('--json');
  const outPath = outIdx === -1 ? null : args[outIdx + 1];

  if (!jsonPath || !parsed.specified)
    die(
      'usage: <prompts.json> (--set=<dir> | --sets=<a>,<b>) (--ids=<file> | --all) [--json <path>]'
    );
  if (!idsFile && !all) die('pass --ids=<file> to gate a bump, or --all');
  const resolved = resolveOverrideSets(parsed, { fallback: 'none' });
  if (!resolved.length) die('no override set resolved');
  printAuditedSets(resolved);
  if (!fs.existsSync(jsonPath)) die(`no prompts JSON at ${jsonPath}`);
  if (idsFile && !fs.existsSync(idsFile)) die(`no ids file at ${idsFile}`);

  const prompts = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).prompts || [];
  const entriesById = new Map();
  for (const p of prompts) {
    if (!p.id) continue;
    if (!entriesById.has(p.id)) entriesById.set(p.id, []);
    entriesById.get(p.id).push(p);
  }

  const bodiesById = new Map();
  let shadowSkipped = 0;
  for (const { dir, name } of resolved) {
    if (!fs.existsSync(dir)) die(`no override set at ${dir}`);
    const shadowed = shadowedIds(dir);
    for (const id of entriesById.keys()) {
      const file = path.join(dir, `${id}.md`);
      if (!fs.existsSync(file)) continue;
      if (shadowed.has(id)) {
        shadowSkipped++;
        continue;
      }
      const body = stripFrontmatter(fs.readFileSync(file, 'utf8'));
      if (!bodiesById.has(id)) bodiesById.set(id, []);
      bodiesById.get(id).push({ set: name, body });
    }
  }

  const ids = idsFile
    ? fs
        .readFileSync(idsFile, 'utf8')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
    : [...bodiesById.keys()];

  const allowPath = path.join(
    path.dirname(url.fileURLToPath(import.meta.url)),
    '..',
    'data',
    'slot-context-allowlist.json'
  );
  const allow = fs.existsSync(allowPath)
    ? JSON.parse(fs.readFileSync(allowPath, 'utf8'))
    : {};

  // In --ids mode a row for an id outside the run is not judged.
  const scopedAllow = Object.fromEntries(
    Object.entries(allow).filter(([id]) => ids.includes(id))
  );
  const { findings, justified, stale, checked } = evaluate({
    entriesById,
    bodiesById,
    ids,
    allow: scopedAllow,
  });

  for (const j of justified)
    console.log(`  ✓ ${j.set}/${j.id}: ${j.label} — justified: ${j.reason}`);
  for (const st of stale)
    console.log(`  ! ${st.id}: allowlist row is stale — ${st.why}`);
  if (shadowSkipped)
    console.log(
      `  · ${shadowSkipped} id(s) owned by another override skipped (shadows: frontmatter)`
    );

  if (outPath) fs.writeFileSync(outPath, JSON.stringify(findings, null, 1));

  if (!findings.length) {
    console.log(
      `checkSlotContext: 0 — every kept slot still sits in a pristine phrase across ${checked} trimmed override(s) (${justified.length} reviewed)`
    );
    process.exit(stale.length ? 1 : 0);
  }

  const byId = new Map();
  for (const f of findings) {
    const k = `${f.set}/${f.id}`;
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(f);
  }
  console.log(
    `checkSlotContext: ${findings.length} slot occurrence(s) in ${byId.size} of ${checked} trimmed override(s) lost the words on both sides (${justified.length} reviewed)`
  );
  for (const [k, fs_] of byId) {
    console.log(`  ${k}`);
    for (const f of fs_)
      console.log(
        `      ${f.label}: override [${f.left}] _ [${f.right}]  pristine [${f.pristineLeft.join(' | ')}] _ [${f.pristineRight.join(' | ')}]`
      );
  }
  console.log(
    '\nA kept slot whose surrounding words were cut on both sides usually renders a\n' +
      'bare value with no instruction around it. Restore the phrase, or record why\n' +
      'the rewrite is sound in data/slot-context-allowlist.json.'
  );
  process.exit(1);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main();
}
