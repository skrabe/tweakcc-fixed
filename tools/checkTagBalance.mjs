#!/usr/bin/env node
// Report XML-like wrapper tags a trim left unclosed or closed out of order.
//
// The override body is read by the model as-is, so `<name>` with no `</name>`
// leaves everything after it inside an open wrapper. The auto-mode security
// monitor override shipped that way: it kept `<cc_automode_session_rules>` and
// dropped the closer, and no other gate looks at tag structure.
//
// The rule is relative to pristine, because pristine itself carries tags that
// are never closed in the text: code-side REPLACE markers
// (`<cross_session_messages_rule>`, `<permissions_template>`) that the binary
// swaps out with `.replace("<tag>", …)`, and placeholders (`<name>`). A tag
// NAME is flagged only when pristine has it balanced (opens == closes > 0) and
// the trimmed override does not. A nesting break is flagged only when the names
// balanced in BOTH pass a stack check in pristine and fail it in the override.
//
// Tag-like text in prose is not structure. `<analysis>` inside a backtick code
// span, or in a fenced block, names a tag instead of opening one, so both are
// blanked before counting (see stripLiteral).
//
// Usage:
//   node tools/checkTagBalance.mjs <prompts.json> --set=<dir> --all
//   node tools/checkTagBalance.mjs <prompts.json> --sets=<a>,<b> --ids=<file>
//     --ids  newline-separated ids to check. Gate mode.
//     --all  every trimmed override (non-empty, differs from pristine).
//     --json <path>  write the findings.
//
// A reviewed finding is recorded in data/tag-balance-allowlist.json, keyed
// `<id>` -> `{ bodyHash, reviewed, tags: { <tag>: <reason> } }`. The row is
// keyed on the deployed body's hash, so a later edit re-opens the question.
//
// Exit 0 = no findings, 1 = findings or stale allowlist rows, 2 = nothing
// checked or could not run.

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

const TAG = /<(\/?)([A-Za-z][\w-]*)(?:\s[^<>\n]*)?(\/?)>/g;

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

// Blank fenced blocks and inline backtick spans so a prose mention of a tag
// does not count as one. Newlines survive so offsets stay meaningful.
export const stripLiteral = s =>
  s
    .replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));

// Structure, not mentions. Per line, a same-name open/close pair is a balanced
// inline element and cancels. Of what is left, a tag counts only when one side
// of it on its line holds nothing but whitespace or other tags. "Wrap your
// analysis in <analysis> tags first" is a prose mention (text on both sides).
// Either side, not just the start, because pristine itself puts the real
// wrapper after prose: `...laundering.<cc_automode_session_rules><cross_...>`.
export const tagEvents = text => {
  const events = [];
  for (const line of stripLiteral(text || '').split('\n')) {
    const found = [...line.matchAll(TAG)].filter(m => !m[3]);
    const used = new Set();
    for (let i = 0; i < found.length; i++) {
      if (found[i][1] === '/' || used.has(i)) continue;
      for (let j = i + 1; j < found.length; j++) {
        if (
          !used.has(j) &&
          found[j][1] === '/' &&
          found[j][2] === found[i][2]
        ) {
          used.add(i).add(j);
          events.push(
            { name: found[i][2], close: false },
            { name: found[i][2], close: true }
          );
          break;
        }
      }
    }
    found.forEach((m, i) => {
      if (used.has(i)) return;
      const before = line.slice(0, m.index).replace(TAG, '').trim();
      const after = line
        .slice(m.index + m[0].length)
        .replace(TAG, '')
        .trim();
      if (before === '' || after === '')
        events.push({ name: m[2], close: m[1] === '/' });
    });
  }
  return events;
};

export const tagCounts = events => {
  const counts = new Map();
  for (const e of events) {
    const c = counts.get(e.name) || { open: 0, close: 0 };
    c[e.close ? 'close' : 'open']++;
    counts.set(e.name, c);
  }
  return counts;
};

const balanced = c => c && c.open > 0 && c.open === c.close;

// Stack check over the given names only. Returns the first tag whose closer
// does not match the innermost open one, or null when the order is sound.
export const nestingBreak = (events, names) => {
  const stack = [];
  for (const e of events) {
    if (!names.has(e.name)) continue;
    if (!e.close) {
      stack.push(e.name);
      continue;
    }
    if (stack[stack.length - 1] !== e.name) return e.name;
    stack.pop();
  }
  return null;
};

// A same-id multi-site prompt carries several pristine bodies; any one of them
// can be the baseline the override was trimmed from, so a tag is judged against
// the body that has it balanced.
export const tagFindings = (pristineBodies, deployed) => {
  const dep = tagEvents(deployed);
  const depCounts = tagCounts(dep);
  const found = new Map();
  const nesting = new Map();
  for (const pb of pristineBodies) {
    const pe = tagEvents(pb);
    const pc = tagCounts(pe);
    const both = new Set();
    for (const [name, c] of pc) {
      if (!balanced(c)) continue;
      const d = depCounts.get(name) || { open: 0, close: 0 };
      if (d.open !== d.close)
        found.set(
          name,
          `<${name}> ×${d.open} / </${name}> ×${d.close} (pristine ×${c.open}/×${c.close})`
        );
      else if (balanced(d)) both.add(name);
    }
    if (both.size && nestingBreak(pe, both) === null) {
      const bad = nestingBreak(dep, both);
      if (bad) nesting.set(bad, `</${bad}> closes out of order`);
    }
  }
  const out = [];
  for (const [tag, detail] of found)
    out.push({ tag, kind: 'unbalanced', detail });
  for (const [tag, detail] of nesting)
    if (!found.has(tag)) out.push({ tag, kind: 'nesting', detail });
  return out;
};

const main = () => {
  const die = (msg, code = 2) => {
    console.error(`checkTagBalance: ${msg}`);
    process.exit(code);
  };

  const parsed = parseOverrideArgs(process.argv.slice(2));
  const args = parsed.rest;
  const jsonPath = args.find(a => !a.startsWith('--'));
  const idsFile = (args.find(a => a.startsWith('--ids=')) || '').slice(6);
  const all = args.includes('--all');
  const outIdx = args.indexOf('--json');
  const outPath = outIdx === -1 ? null : args[outIdx + 1];
  const allowArg = (args.find(a => a.startsWith('--allowlist=')) || '').slice(
    12
  );

  if (!jsonPath || !parsed.specified)
    die(
      'usage: <prompts.json> --set=<dir> | --sets=<a,b> (--ids=<file> | --all) [--json <path>]'
    );
  if (!idsFile && !all)
    die('pass --ids=<file> to gate a bump, or --all to check the whole set');
  const resolved = resolveOverrideSets(parsed, { fallback: 'none' });
  if (!resolved.length) die('no override set resolved');
  printAuditedSets(resolved);
  if (!fs.existsSync(jsonPath)) die(`no prompts JSON at ${jsonPath}`);

  let prompts;
  try {
    prompts = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).prompts || [];
  } catch (e) {
    die(`unreadable prompts JSON at ${jsonPath}: ${e.message}`);
  }
  const pristine = new Map();
  for (const p of prompts) {
    if (!p.id) continue;
    if (!pristine.has(p.id)) pristine.set(p.id, []);
    pristine.get(p.id).push(reconstruct(p));
  }

  const allowPath =
    allowArg ||
    path.join(
      path.dirname(url.fileURLToPath(import.meta.url)),
      '..',
      'data',
      'tag-balance-allowlist.json'
    );
  const allow = fs.existsSync(allowPath)
    ? JSON.parse(fs.readFileSync(allowPath, 'utf8'))
    : {};
  const bodyHash = b =>
    crypto.createHash('sha1').update(b.trim()).digest('hex').slice(0, 12);

  const wanted = idsFile
    ? fs
        .readFileSync(idsFile, 'utf8')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
    : null;

  const findings = [];
  const justified = [];
  const stale = [];
  let checked = 0;
  let shadowSkipped = 0;
  for (const set of resolved) {
    const setDir = set.dir;
    if (!fs.existsSync(setDir)) die(`no override set at ${setDir}`);
    // Ids another override shadows render nothing from this set.
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
        if (m)
          for (const line of m[1].split('\n')) {
            const id = line.replace(/^\s+-\s+/, '').trim();
            if (id) shadowed.add(id);
          }
      }
    }
    const ids =
      wanted ??
      fs
        .readdirSync(setDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.slice(0, -3));
    for (const id of ids) {
      const file = path.join(setDir, `${id}.md`);
      if (!pristine.has(id) || !fs.existsSync(file)) continue;
      if (shadowed.has(id)) {
        shadowSkipped++;
        continue;
      }
      const body = stripFrontmatter(fs.readFileSync(file, 'utf8'));
      if (
        body.trim() === '' ||
        pristine.get(id).some(p => p.trim() === body.trim())
      )
        continue;
      checked++;
      const key = `${id}@${path.basename(setDir)}`;
      const rule = allow[id];
      const fresh = rule && rule.bodyHash === bodyHash(body);
      const live = fresh ? rule.tags || {} : {};
      if (rule && !fresh)
        stale.push({
          id,
          why: `override body changed (now ${bodyHash(body)}); re-review and re-key the row`,
        });
      const all_ = tagFindings(pristine.get(id), body);
      for (const t of Object.keys(live))
        if (!all_.some(f => f.tag === t))
          stale.push({
            id,
            why: `<${t}> is no longer flagged; delete the row`,
          });
      for (const f of all_) {
        if (f.tag in live)
          justified.push({ id, tag: f.tag, reason: live[f.tag] });
        else findings.push({ id, set: path.basename(setDir), key, ...f });
      }
    }
  }

  console.log(`checkTagBalance: ${checked} trimmed override(s) checked`);
  if (!checked)
    die(
      'nothing to check (empty set, --ids selecting nothing, or no trimmed override)'
    );
  for (const j of justified)
    console.log(`  ✓ ${j.id}: <${j.tag}> — justified: ${j.reason}`);
  for (const st of stale)
    console.log(`  ! ${st.id}: allowlist row is stale — ${st.why}`);
  if (shadowSkipped)
    console.log(
      `  · ${shadowSkipped} id(s) owned by another override skipped (shadows:)`
    );
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(findings, null, 1));

  if (!findings.length && !stale.length) {
    console.log(
      'checkTagBalance: 0 — every wrapper tag pristine balances is still balanced and nested'
    );
    process.exit(0);
  }
  if (findings.length) {
    console.log(`checkTagBalance: ${findings.length} tag finding(s)`);
    for (const f of findings)
      console.log(`  ${f.kind.padEnd(10)} ${f.id} [${f.set}]  ${f.detail}`);
    console.log(
      '\nAn unclosed wrapper puts the rest of the prompt inside it. Restore the closer, or add a\n' +
        'reasoned row to data/tag-balance-allowlist.json if the break is intended.'
    );
  }
  process.exit(1);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main();
}
