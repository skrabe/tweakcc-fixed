#!/usr/bin/env node
// Refuse to blank a literal the BINARY matches against text.
//
// Most catalogued strings are only ever emitted — the minifier hoists them into
// a module const and the const is interpolated into a message. Overriding one
// changes what the model reads and nothing else. A small minority are also
// PREDICATES: CC passes them to `.includes()` / `.startsWith()` / `.indexOf()`
// to classify text. Blanking one of those does not shorten a prompt, it inverts
// a branch, because `"anything".includes("")` is unconditionally true.
//
// That is skrabe/lobotomized-claude-code#24. `system-prompt-command-name-framing-tag-3`
// is `<command-name>/loop</command-name>`, which CC greps stored transcripts for
// to decide whether a session was a `/loop` session and should be hidden:
//
//   catch { if (i) return o.includes("<command-name>/loop</command-name>"); continue }
//   ...
//   return c.some((u) => u.includes("<command-name>/loop</command-name>"))
//
// Wiped to "", every session holding any user message classified as a loop
// session, and `/resume` listed 5 of 50. The sibling `-2` is `zUp`, the prefilter
// the session-descriptor scanner runs over raw transcript lines, so blanking it
// also cost every row its title. Both are markup, both read as "no prose value"
// to an audit pass, and neither is reachable by any other gate: the binary boots,
// `--print` smokes READY, four-zeros is clean, and nothing errors. It only shows
// up as history quietly going missing.
//
// The rule is deliberately NOT "these literals must stay pristine". CC also
// matches literals it produced itself from the same const — `tool-result-tool-use-rejected-stop`
// is emitted as a tool result and later re-detected with `.startsWith(JLe)`, and
// since the override rewrites both sides at once the predicate still holds.
// Those are legitimately editable. The invariant that never survives is
// emptiness, so EMPTY is the gate and edited-but-non-empty is reported.
//
// Usage:
//   node tools/checkScannedLiterals.mjs <cli.js> <prompts.json> --set=<abs dir>
//     --set   override set to check; repeatable.
//     --json <path>  write findings for a downstream verifier packet.
//
// Exit 0 = no blanked predicate, 1 = findings, 2 = could not run.

import fs from 'node:fs';
import path from 'node:path';

// String methods that consume a literal as a needle rather than emitting it.
const MATCHERS = [
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'split',
  'search',
];

// A slot-free prompt reconstructs to a plain literal; anything carrying a
// runtime slot is interpolated, never a predicate needle.
export const literalOf = p => {
  const pieces = p.pieces || [];
  if (!pieces.every(x => typeof x === 'string')) return null;
  const s = pieces.join('');
  return s.trim() ? s : null;
};

export const bodyOf = text =>
  text.replace(/^<!--[\s\S]*?-->\s*\n?/, '').replace(/\s+$/, '');

const quoted = (lit, q) =>
  q +
  lit
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(q, 'g'), '\\' + q)
    .replace(/\n/g, '\\n') +
  q;

// Identifiers the minifier assigns exactly once at module scope are real
// constants. A name assigned all over the file is a local temp — `o` is not
// "the const holding this prompt" just because some `o=` happened to precede it.
const assignedOnce = (src, name) => {
  let count = 0;
  for (
    let i = src.indexOf(name + '=');
    i !== -1;
    i = src.indexOf(name + '=', i + 1)
  ) {
    const before = src[i - 1];
    const after = src[i + name.length + 1];
    if (before && /[\w$]/.test(before)) continue;
    if (after === '=') continue; // ==, ===
    if (++count > 1) return false;
  }
  return count === 1;
};

// Evidence that the binary treats this literal as a needle: either passed
// inline to a matcher, or bound to a single-assignment const that is.
export const matchEvidence = (src, lit) => {
  const found = [];
  for (const q of ['"', "'"]) {
    const needle = quoted(lit, q);
    if (!src.includes(needle)) continue;

    for (const fn of MATCHERS) {
      if (src.includes(`.${fn}(${needle})`)) found.push(`inline .${fn}()`);
    }

    const names = new Set();
    let i = src.indexOf(needle);
    for (let n = 0; i !== -1 && n < 20; n++, i = src.indexOf(needle, i + 1)) {
      const pre = src.slice(Math.max(0, i - 40), i).trimEnd();
      if (!pre.endsWith('=')) continue;
      const m = pre
        .slice(0, -1)
        .trimEnd()
        .match(/[$\w]+$/);
      if (m && m[0].length <= 12) names.add(m[0]);
    }
    for (const name of names) {
      if (!assignedOnce(src, name)) continue;
      for (const fn of MATCHERS) {
        if (
          src.includes(`.${fn}(${name})`) ||
          src.includes(`.${fn}(${name},`)
        ) {
          found.push(`${name} -> .${fn}()`);
        }
      }
    }
  }
  return [...new Set(found)];
};

// A SECOND needle shape, new in CC 2.1.265: a rewrite table. CC passes a
// description through `FN(text, [[needle, replacement], ...])` to restate it for
// another tool surface (the artifact tool's MCP variant restates every
// "write_db with db_op 'update' ... only:" prefix as "action 'update' ... only:").
//
// This is strictly harsher than the `.startsWith(CONST)` case above. There both
// sides come from the same const, so an override that rewrites the prompt
// rewrites the predicate with it and the match still holds. Here the needle is a
// SEPARATE literal in the binary, compared against text the override controls —
// so ANY edit that drops the needle, not just blanking, silently makes the
// rewrite a no-op and ships the un-restated wording to the other surface. No
// other gate sees it: the literal is still in the bundle, the prompt still
// applies, and nothing errors.
const jsString = (src, i) => {
  const out = [];
  const q = src[i];
  i += 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      out.push(src[i + 1]);
      i += 2;
      continue;
    }
    if (c === q) return [out.join(''), i + 1];
    out.push(c);
    i += 1;
  }
  return [null, i];
};

// Every `[[ "needle", "replacement" ], ...]` table passed as a call argument.
// A needle missing from an override is only a broken rewrite when the sentence
// it sat in is still there, reworded: that reworded text reaches the other
// surface un-restated. When the whole sentence was deleted there is nothing
// left to restate, and the rewrite's no-op is harmless. The sentence is taken
// from pristine; either remainder of it (before or after the needle) still
// present in the override means the sentence survived.
export const sentenceSurvives = (pristine, needle, override) => {
  const at = pristine.indexOf(needle);
  if (at < 0) return true;
  const before = pristine.slice(0, at);
  const after = pristine.slice(at + needle.length);
  const start =
    Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n')) + 1;
  const endRel = after.search(/\.(\s|$)|\n/);
  const head = before.slice(start).trim();
  const tail = (endRel < 0 ? after : after.slice(0, endRel)).trim();
  const flat = s => s.replace(/\s+/g, ' ');
  const ov = flat(override);
  return [head, tail].some(
    part => part.length >= 12 && ov.includes(flat(part))
  );
};

export const rewriteTableNeedles = src => {
  const needles = new Set();
  const re = /\b[$\w]+\(\s*(?:[$\w]+\.)?[$\w]+\s*,\s*\[\[/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('[[', m.index);
    let depth = 0;
    let k = open;
    for (; k < src.length; k += 1) {
      const c = src[k];
      if (c === '"' || c === "'") {
        [, k] = jsString(src, k);
        k -= 1;
        continue;
      }
      if (c === '[') depth += 1;
      else if (c === ']') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    const seg = src.slice(open, k + 1);
    const strings = [];
    for (let p = 0; p < seg.length; p += 1) {
      if (seg[p] === '"' || seg[p] === "'") {
        const [v, next] = jsString(seg, p);
        if (v === null) break;
        strings.push(v);
        p = next - 1;
      }
    }
    // A table is pairs; a short marker is not a prose needle worth guarding.
    if (strings.length < 2 || strings.length % 2 !== 0) continue;
    for (let a = 0; a < strings.length; a += 2) {
      if (strings[a].length >= 12) needles.add(strings[a]);
    }
  }
  return [...needles];
};

const main = () => {
  const args = process.argv.slice(2);
  const sets = args
    .filter(a => a.startsWith('--set='))
    .map(a => path.resolve(a.slice('--set='.length)));
  const jsonOut = (args[args.indexOf('--json') + 1] || '').startsWith('--')
    ? null
    : args.includes('--json')
      ? args[args.indexOf('--json') + 1]
      : null;
  const [cliPath, promptsPath] = args.filter(a => !a.startsWith('--'));

  if (!cliPath || !promptsPath || !sets.length) {
    console.error(
      'usage: checkScannedLiterals.mjs <cli.js> <prompts.json> --set=<dir> [--set=<dir>]'
    );
    process.exit(2);
  }
  for (const p of [cliPath, promptsPath, ...sets]) {
    if (!fs.existsSync(p)) {
      console.error(`checkScannedLiterals: missing ${p}`);
      process.exit(2);
    }
  }

  const src = fs.readFileSync(cliPath, 'utf8');
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf8')).prompts;

  const seen = new Set();
  const blanked = [];
  const edited = [];

  for (const p of prompts) {
    if (seen.has(p.id)) continue;
    const lit = literalOf(p);
    // A 4KB+ literal is prose; the needle cases are short markers, and scanning
    // the bundle for every long prompt costs far more than it can find.
    if (!lit || lit.length > 4000) continue;
    seen.add(p.id);

    const evidence = matchEvidence(src, lit);
    if (!evidence.length) continue;

    for (const set of sets) {
      const file = path.join(set, `${p.id}.md`);
      if (!fs.existsSync(file)) continue;
      const body = bodyOf(fs.readFileSync(file, 'utf8'));
      if (body.trim() === lit.trim()) continue;
      const row = {
        id: p.id,
        set: path.basename(set),
        literal: lit,
        evidence,
      };
      if (body.trim()) edited.push(row);
      else blanked.push(row);
    }
  }

  // Rewrite-table needles: the override must still CONTAIN the needle, because
  // the binary matches it against the override's own text (see rewriteTableNeedles).
  const brokenRewrites = [];
  const sentenceDeleted = [];
  const needles = rewriteTableNeedles(src);
  for (const needle of needles) {
    for (const p of prompts) {
      if (!p.id) continue;
      const body = (p.pieces || []).filter(x => typeof x === 'string').join('');
      if (!body.includes(needle)) continue;
      for (const set of sets) {
        const file = path.join(set, `${p.id}.md`);
        if (!fs.existsSync(file)) continue;
        const ov = bodyOf(fs.readFileSync(file, 'utf8'));
        if (!ov.trim()) continue; // a deliberate suppression emits nothing at all
        if (ov.includes(needle)) continue;
        if (!sentenceSurvives(body, needle, ov)) {
          sentenceDeleted.push({ id: p.id, set: path.basename(set), needle });
          continue;
        }
        brokenRewrites.push({ id: p.id, set: path.basename(set), needle });
      }
    }
  }
  for (const r of sentenceDeleted) {
    console.log(
      `note: ${r.set}/${r.id} deleted the whole sentence carrying rewrite needle ` +
        `${JSON.stringify(r.needle.slice(0, 60))} — nothing is left to restate`
    );
  }
  for (const r of brokenRewrites) {
    console.error(
      `BROKEN REWRITE     ${r.set}/${r.id}\n` +
        `   needle  : ${JSON.stringify(r.needle.slice(0, 100))}\n` +
        `   effect  : the binary rewrites this text for another tool surface by ` +
        `matching that needle; the override no longer contains it, so the rewrite ` +
        `silently no-ops and the un-restated wording ships`
    );
  }

  for (const r of blanked) {
    console.error(
      `BLANKED PREDICATE  ${r.set}/${r.id}\n` +
        `   literal : ${JSON.stringify(r.literal.slice(0, 100))}\n` +
        `   matched : ${r.evidence.join(', ')}\n` +
        `   effect  : the matcher becomes unconditionally true — restore pristine`
    );
  }
  for (const r of edited) {
    console.log(
      `note: ${r.set}/${r.id} rewrites a matched literal (${r.evidence.join(', ')}) — ` +
        `fine while CC compares against text it built from the same const`
    );
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ blanked, edited }, null, 2));
  }

  if (blanked.length || brokenRewrites.length) {
    console.error(
      `\nscanned literals: ${blanked.length} blanked predicate(s), ` +
        `${brokenRewrites.length} broken rewrite(s), ${edited.length} rewritten`
    );
    process.exit(1);
  }
  console.log(
    `✓ scanned literals: 0 blanked predicates, 0 broken rewrites ` +
      `(${edited.length} rewritten, ${seen.size} literals examined, ` +
      `${needles.length} rewrite-table needle(s))`
  );
};

if (import.meta.url === `file://${process.argv[1]}`) main();
