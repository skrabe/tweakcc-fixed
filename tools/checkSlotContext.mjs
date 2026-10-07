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
// The defects share one shape: the slot's RENDERED VALUE reads wrong where the
// trim left it. 2.1.291's nudge value was the bare tool name; TaskCreate's
// " and potentially assigned to teammates" landed after "…owners and
// dependencies."; the artifact-database str_replace list item, ending in a
// comma, landed after "…paths are shaped.". The false positives of a
// words-only rule were the opposite shape: a value that is a whole sentence or
// section, whose neighbouring sentence the trim cut — 59 of its 60 findings.
//
// So each slot's value is resolved from the pristine bundle
// (lib/slotValues.mjs: literals, every write to the binding, every
// ternary/||/?? branch, function returns, parameters at their call sites,
// imports — with eslint-scope bindings) and every non-empty branch is
// classified (classifyValue: fragment / name / sentence / other). An override
// occurrence is a finding when, for some branch and some placement, the value
// reads wrong in its new place and did not read that way in pristine:
//   fragment  now starts a sentence, where some pristine occurrence had a word
//             before it;
//   name      now stands alone, boundaries on both sides, which no pristine
//             occurrence did;
//   sentence  now follows a word mid-line, where pristine always had it at a
//             boundary.
// A placement identical to a pristine occurrence's (left, right) never fires.
// A neighbouring slot is not a word: its value's facing edge is the context,
// and when it can render nothing (or is unknown) the token behind it is too.
//
// The value rule only ADDS to the word-neighbour rule below; it never replaces
// it where the value is not fully known. The word rule also runs for a label
// with no resolved value, with any runtime (unknown) branch, or whose every
// known branch is `other`, and the findings union. A label that only renders
// "" is skipped by both.
//
// Context tokens (shared by both rules):
//   - A context token is the nearest WORD on that side (letters, digits, `_`,
//     `'`, `-`, compared case-insensitively), the nearest neighbouring SLOT
//     (named by its leading identifier), or a BOUNDARY. Quotes, brackets,
//     commas, colons, dashes, escaped backticks, markdown emphasis and the
//     articles a/an/the are transparent.
//   - A boundary is a sentence end (`.` `!` `?` not followed by a word char),
//     a newline, the start or end of the body, or the edge of a template
//     branch inside a conditional.
//   - Every label an interpolation RENDERS shares that interpolation's context
//     (the branches of `${C?B:""}`, `${B.slice(0,-1)}`); a ternary condition
//     and a call's arguments render nothing of their own and are skipped. A
//     label concatenated with string literals (`"Call " + T + " now"`) takes
//     the literals' adjacent words. String, template and regex literals are
//     skipped when matching the interpolation's closing brace.
//
// Word rule: a side survives when it is a word or slot token some pristine
// occurrence also has on that side; a boundary only counts as part of an exact
// pristine (left, right) pair. A finding is a placement where neither side
// survives.
//
// Measured 2026-10-07 on the CC 2.1.292 LCC set (769 trims, 929 slot
// occurrences; 524 judged by value alone, 142 by value and words, 256 by
// words only, 7 always empty):
//   words-only rule (first version) ................... 60 findings, 1 real
//   value rule, word rule as replacement fallback ..... 2 findings, 0 real
//   value rule + word rule union (this rule) .......... 11 findings, 0 real
// The 11 are all word-rule findings on runtime or `other` values, reviewed
// in the allowlist. The two known defects reconstructed against the real
// 2.1.292 values (TaskCreate, artifact-database str_replace) both flag as
// fragments. Planted-defect recall on the real values (a sentence break
// inserted before every mid-sentence fragment- or name-valued slot in the
// catalogue, and after it for names): 779/792 fragments, 1556/1575 names.
//
// Not automatically wrong: an author may restructure on purpose. Each finding
// needs a reason, recorded per label in data/slot-context-allowlist.json keyed
// `<id>` -> `{ bodyHash, pristineHash, valueHash, tokens: { <label>: <reason>
// } }`. The row holds only while the deployed body, the pristine pieces and
// the resolved slot values are all unchanged, so an edit on any side re-opens
// it. A row whose label no longer fires, whose override is gone or whose id
// left the catalogue is reported as stale (under --all, every row).
//
// Usage:
//   node tools/checkSlotContext.mjs <prompts.json> --set=<abs dir> --ids=<file>
//   node tools/checkSlotContext.mjs <prompts.json> --set=<abs dir> --all
//   node tools/checkSlotContext.mjs <prompts.json> --sets=<a>,<b> --all
//     --ids <file> | --ids=<file>  newline-separated ids this run changed.
//     --all  every trimmed override in the set(s), and every allowlist row.
//     --json <path> | --json=<path>  write the findings for a verifier packet.
//     --allowlist <path>  reviewed rows (default data/slot-context-allowlist.json).
//     --cli <path>  the PRISTINE bundle of the catalogue's version (default:
//                   $TWEAKCC_PRISTINE_CLI, else ~/.tweakcc/native-claudejs-orig.js);
//                   a bundle of another version is refused.
//
// Exit 0 = no unreviewed findings, 1 = findings or stale rows, 2 = could not
// run or checked nothing (unreadable/empty catalogue or allowlist, a set with
// no .md files, an --ids file naming no trimmed override, no pristine bundle
// or one of another version).

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { OPAQUE, resolveSlotValues } from './lib/slotValues.mjs';

const require = createRequire(import.meta.url);
const {
  parseOverrideArgs,
  resolveOverrideSets,
  printAuditedSets,
  pristineCliPath,
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

export const pristineHash = entries =>
  crypto
    .createHash('sha1')
    .update(JSON.stringify(entries.map(p => p.pieces || [])))
    .digest('hex')
    .slice(0, 12);

const isWordChar = c => /[\p{L}\p{N}_'-]/u.test(c);
const isIdentStart = c => /[A-Za-z_$]/.test(c);
const isIdentChar = c => /[\w$]/.test(c);
const escaped = (s, i) => {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++;
  return n % 2 === 1;
};

const ctxToken = item =>
  item.t === 'b'
    ? BOUNDARY
    : item.t === 'w'
      ? item.v
      : `\${${item.lead || '?'}}`;

// The first and last REAL tokens of a literal's prose (scanRun wraps every
// run in artificial boundaries). null when the literal has no tokens.
const headToken = items => (items.length > 2 ? ctxToken(items[1]) : null);
const tailToken = items =>
  items.length > 2 ? ctxToken(items[items.length - 2]) : null;

// A `/` opens a regex literal, not a division, when nothing value-like
// precedes it in the expression.
const REGEX_PREV = new Set([...'(,=:[!&|?{};+-*%<>~^']);

// Parse `${ ... }` starting just after the `${`. Returns the index after the
// closing `}` and the occurrences the interpolation RENDERS, each
// { name, left?, right? }.
//
// - A ternary's condition (`${HAS_X?`...`:""}`, `${(F()?A:B)}`) only picks a
//   branch, so it is dropped; conditions are tracked per bracket level, so a
//   parenthesised ternary is handled the same as a bare one.
// - String, template and regex literals are skipped when matching braces, so a
//   `}` inside one cannot end the interpolation early.
// - A label concatenated with string literals (`"Call " + TOOL + " now"`) takes
//   its context from those literals' adjacent words; otherwise `left`/`right`
//   stay undefined and the caller uses the interpolation's outer context.
// - Template branches are scanned as independent runs onto `runs`.
const parseExpr = (s, i, runs) => {
  const frames = [{ rendered: [], pending: [], seq: [], afterId: false }];
  let first = null;
  let prevSig = null;
  // Anything beyond one label (a ternary, a literal, concatenation, `||`)
  // means the interpolation may render text no single label accounts for.
  let complex = false;
  const top = () => frames[frames.length - 1];
  const seqTail = n => top().seq.slice(-n);
  const pushStr = items => {
    const [a, b] = seqTail(2);
    if (a && b && a.k === 'id' && b.k === '+') {
      const h = headToken(items);
      if (h !== null) a.o.right = h;
    }
    top().seq.push({ k: 'str', items });
  };
  const pushId = name => {
    const o = { name };
    const [a, b] = seqTail(2);
    if (a && b && a.k === 'str' && b.k === '+') {
      const t = tailToken(a.items);
      if (t !== null) o.left = t;
    }
    top().pending.push(o);
    top().seq.push({ k: 'id', o });
    first ??= name;
  };
  const closeFrame = () => {
    const f = frames.pop();
    const p = top();
    // A call's arguments are not what the interpolation renders — its return
    // value is, and that belongs to the callee label.
    if (!f.afterId) {
      p.pending.push(...f.rendered, ...f.pending);
      p.seq.push({ k: 'op' });
    }
  };
  const finish = end => {
    while (frames.length > 1) closeFrame();
    const f = frames[0];
    return { end, occ: [...f.rendered, ...f.pending], first, complex };
  };
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '}' && frames.length === 1) return finish(i + 1);
    const sig = c;
    if (c === '{' || c === '(' || c === '[') {
      const last = top().seq[top().seq.length - 1];
      frames.push({
        rendered: [],
        pending: [],
        seq: [],
        afterId: c === '(' && !!last && last.k === 'id',
      });
    } else if (c === '}' || c === ')' || c === ']') {
      if (frames.length > 1) closeFrame();
    } else if (c === '?') {
      if (s[i + 1] === '?' || s[i + 1] === '.') {
        top().seq.push({ k: 'op' });
        prevSig = '?';
        i += 2;
        continue;
      }
      complex = true;
      top().pending = [];
      top().seq.push({ k: 'op' });
    } else if (c === ':') {
      complex = true;
      top().rendered.push(...top().pending);
      top().pending = [];
      top().seq.push({ k: 'op' });
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && !(s[j] === c && !escaped(s, j))) j++;
      const scratch = [];
      const { items } = scanRun(s.slice(i + 1, j), 0, false, scratch);
      complex = true;
      pushStr(items);
      prevSig = c;
      i = j + 1;
      continue;
    } else if (c === '`') {
      const run = scanRun(s, i + 1, true, runs);
      complex = true;
      pushStr(run.items);
      prevSig = c;
      i = run.end + 1;
      continue;
    } else if (
      c === '/' &&
      s[i + 1] !== '/' &&
      s[i + 1] !== '*' &&
      (prevSig === null || REGEX_PREV.has(prevSig))
    ) {
      let j = i + 1;
      let inClass = false;
      for (; j < s.length; j++) {
        if (escaped(s, j)) continue;
        if (s[j] === '[') inClass = true;
        else if (s[j] === ']') inClass = false;
        else if (s[j] === '/' && !inClass) break;
      }
      j++;
      while (j < s.length && /[a-z]/i.test(s[j])) j++;
      top().seq.push({ k: 'op' });
      prevSig = 'regex';
      i = j;
      continue;
    } else if (c === '.' && isIdentStart(s[i + 1] || '')) {
      let j = i + 1;
      while (j < s.length && isIdentChar(s[j])) j++;
      prevSig = 'x';
      i = j;
      continue;
    } else if (isIdentStart(c)) {
      let j = i + 1;
      while (j < s.length && isIdentChar(s[j])) j++;
      const word = s.slice(i, j);
      if (/^(typeof|instanceof|in|of|new|void|delete|return)$/.test(word)) {
        top().seq.push({ k: 'op' });
        prevSig = '(';
      } else {
        pushId(word);
        prevSig = 'x';
      }
      i = j;
      continue;
    } else if (c === '+') {
      complex = true;
      top().seq.push({ k: '+' });
    } else {
      if (c === '|' || c === '&' || c === ',') complex = true;
      top().seq.push({ k: 'op' });
    }
    prevSig = sig;
    i++;
  }
  return finish(s.length);
};

// Scan a prose run (the body, or a template branch inside an expression) into
// a stream of context items. Each finished stream is pushed onto `runs`.
const scanRun = (s, i, inTemplate, runs) => {
  const items = [{ t: 'b' }];
  while (i < s.length) {
    const c = s[i];
    if (inTemplate && c === '`' && !escaped(s, i)) break;
    if (c === '$' && s[i + 1] === '{' && !escaped(s, i)) {
      const { end, occ, first, complex } = parseExpr(s, i + 2, runs);
      items.push({ t: 's', occ, lead: first, complex });
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
  return { end: i, items };
};

// The context token a neighbouring value presents on the side facing the
// slot: its last real token when it sits to the left, its first when to the
// right. A value ending (or starting) in an opaque `${}` presents a neutral
// slot token. null when the value has no tokens at all.
const edgeToken = (raw, dir) => {
  if (
    dir < 0
      ? new RegExp(`${OPAQUE}\\s*$`).test(raw)
      : new RegExp(`^\\s*${OPAQUE}`).test(raw)
  )
    return '${?}';
  const { items } = scanRun(raw, 0, false, []);
  if (items.length <= 2) return null;
  return ctxToken(dir < 0 ? items[items.length - 2] : items[1]);
};

// Every context token the slot at items[k] can actually see on side `dir`.
// A neighbouring slot is not a word: when its value is known, the facing edge
// of each of its branches is the context; when it can render nothing (or is
// unknown), the token beyond it is the context too. Without `valueOf` the
// neighbour stands as a neutral slot token, as it always did.
const sideTokens = (items, k, dir, valueOf, depth = 0) => {
  const it = items[k + dir];
  if (!it) return [BOUNDARY];
  if (it.t !== 's' || !valueOf || depth > 4) return [ctxToken(it)];
  const named = it.occ.map(o => valueOf(o.name));
  let branches;
  if (!it.complex && named.length === 1 && named[0]) branches = named[0];
  else branches = [null, '', ...named.flatMap(b => b || [])];
  const out = new Set();
  for (const b of branches) {
    if (b === null) {
      out.add(ctxToken(it));
      for (const t of sideTokens(items, k + dir, dir, valueOf, depth + 1))
        out.add(t);
      continue;
    }
    const edge = edgeToken(b, dir);
    if (edge === null)
      for (const t of sideTokens(items, k + dir, dir, valueOf, depth + 1))
        out.add(t);
    else out.add(edge);
  }
  return [...out];
};

// Every slot occurrence in `text`, as { label, left, right, lefts, rights }.
// `left`/`right` are the literal neighbouring tokens; `lefts`/`rights` are
// every token the slot can see once neighbouring slots' values are taken into
// account (see sideTokens). Only labels in `labels` are reported; a label
// repeated inside one interpolation counts once.
export const slotOccurrences = (text, labels, valueOf = null) => {
  const runs = [];
  scanRun(text || '', 0, false, runs);
  const out = [];
  for (const items of runs) {
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (it.t !== 's') continue;
      const outerLeft = ctxToken(items[k - 1]);
      const outerRight = ctxToken(items[k + 1]);
      const seen = new Set();
      for (const o of it.occ) {
        if (!labels.has(o.name)) continue;
        const left = o.left ?? outerLeft;
        const right = o.right ?? outerRight;
        const key = `${o.name}\0${left}\0${right}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const occ = { label: o.name, left, right };
        if (valueOf) {
          occ.lefts = o.left ? [o.left] : sideTokens(items, k, -1, valueOf);
          occ.rights = o.right ? [o.right] : sideTokens(items, k, 1, valueOf);
        }
        out.push(occ);
      }
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

// What a slot's rendered value looks like, from the value alone. `raw` is one
// branch as resolved by lib/slotValues.mjs (OPAQUE marks a nested `${}`).
// Order matters: the fragment tests run first, so " and assigned to
// teammates", "which follows" and a lone " and " are fragments, not names.
//   empty     renders nothing
//   fragment  a piece of a sentence: starts with a comma, a closing bracket or
//             a connective (and, or, but, which, that, in, with, to, for, …),
//             ends with a comma or a dangling connective, or is several words
//             starting lowercase
//   name      one token not ending a sentence (a tool name, URL, path, number)
//             or a short label with no sentence punctuation
//             ("ReadNotifications", "https://…/llms.txt", "October 2026")
//   sentence  starts a line, a list item, a heading or a capitalised word, and
//             ends with terminal punctuation or a newline ("Stop.")
//   other     anything else (an opaque start, an unterminated clause)
const CONNECTIVE =
  'and|or|but|nor|so|yet|which|that|who|whom|whose|where|when|while|whereas|unless|until|because|since|although|though|if|then|than|as|in|on|at|of|with|without|to|for|from|by|into|onto|plus';
export const classifyValue = raw => {
  const s = raw.trim();
  if (!s) return 'empty';
  const startsLine =
    /^[ \t]*\n/.test(raw) || /^(?:[-*+>]|#{1,6}|\d+[.)])\s/.test(s);
  const ends = /[.!?][)"'`*\]]*$/.test(s) || /\n[ \t]*$/.test(raw);
  if (/^[,;)\]]/.test(s)) return 'fragment';
  if (!startsLine && new RegExp(`^(?:${CONNECTIVE})(?![\\w$-])`).test(s))
    return 'fragment';
  if (new RegExp(`(?:,|(?:^|\\s)(?:${CONNECTIVE}|the|a|an))$`, 'i').test(s))
    return 'fragment';
  if (
    !s.includes(OPAQUE) &&
    ((!/\s/.test(s) && !/[.!?]$/.test(s)) ||
      (!/[.!?;:,\n]/.test(s) &&
        s.split(/\s+/).length <= 4 &&
        !/^\p{Ll}/u.test(s)))
  )
    return 'name';
  if (!startsLine && /^\p{Ll}/u.test(s)) return 'fragment';
  if ((startsLine || /^[\p{Lu}"'`*([]/u.test(s)) && ends) return 'sentence';
  return 'other';
};

const sideKind = tok =>
  tok === BOUNDARY ? 'boundary' : tok.startsWith('${') ? 'slot' : 'word';

// The word-neighbour rule. A side survives only when it is a WORD or SLOT
// token that some pristine occurrence of the label also has on that side. A
// boundary is not evidence on its own: half of all (id, label) pairs have some
// pristine occurrence at a sentence or line edge, so letting `⟂` match `⟂`
// passed a fully dangling `${T}` whenever any one pristine occurrence started
// a sentence. A boundary only counts as part of the exact (left, right) pair
// of one pristine occurrence — a slot that stood alone may stand alone now.
const wordRuleFires = (left, right, w) => {
  if (left !== BOUNDARY && w.lefts.has(left)) return false;
  if (right !== BOUNDARY && w.rights.has(right)) return false;
  return !w.pairs.has(`${left}\0${right}`);
};

// The value rule, for one placement (left, right) of one branch:
//   fragment  it now starts a sentence (left is a boundary) and some pristine
//             occurrence had a word before it;
//   name      it now stands alone (boundary on both sides) and no pristine
//             occurrence stood alone;
//   sentence  it now follows a word on the same line without opening its own
//             line, and no pristine occurrence had a word before it.
// A neighbouring slot token is neither a word nor a boundary, so it fires
// nothing, and a placement identical to some pristine (left, right) is not a
// change, so it fires nothing either.
const valueRuleFires = (kind, raw, left, right, w) => {
  if (w.pairs.has(`${left}\0${right}`)) return false;
  const lk = sideKind(left);
  if (kind === 'fragment')
    return lk === 'boundary' && [...w.lefts].some(l => sideKind(l) === 'word');
  if (kind === 'name')
    return (
      lk === 'boundary' &&
      right === BOUNDARY &&
      !w.pairs.has(`${BOUNDARY}\0${BOUNDARY}`)
    );
  if (kind === 'sentence')
    return (
      lk === 'word' &&
      !/^[ \t]*\n/.test(raw) &&
      w.lefts.has(BOUNDARY) &&
      ![...w.lefts].some(l => sideKind(l) === 'word')
    );
  return false;
};

const renderBranch = raw => raw.replace(new RegExp(OPAQUE, 'g'), '${…}');

// The core rule. `entries` are the catalogue entries for one id (a multi-site
// id has several); `body` is the deployed override body; `values` maps each
// label to its resolved `{ branches }` (lib/slotValues.mjs), null entries
// being runtime data.
//
// The value rule may only ADD to the word rule, never replace it where the
// value is not fully known: the word rule runs for a label with no resolved
// value, with ANY unknown branch, or whose every known non-empty branch is
// `other`; the value rule runs on every known non-empty branch; findings
// union. A label that only ever renders "" is skipped by both — it cannot
// read wrong anywhere.
export const contextFindings = (entries, body, values = new Map()) => {
  const labels = labelsOf(entries);
  const valueOf = label => values.get(label)?.branches;
  const want = new Map();
  for (const p of entries)
    for (const o of slotOccurrences(reconstruct(p), labels, valueOf)) {
      if (!want.has(o.label))
        want.set(o.label, {
          lefts: new Set(),
          rights: new Set(),
          pairs: new Set(),
        });
      const w = want.get(o.label);
      for (const l of o.lefts) w.lefts.add(l);
      for (const r of o.rights) w.rights.add(r);
      for (const l of o.lefts)
        for (const r of o.rights) w.pairs.add(`${l}\0${r}`);
    }
  const out = [];
  for (const o of slotOccurrences(body, labels, valueOf)) {
    const w = want.get(o.label);
    if (!w) continue;
    const all = valueOf(o.label);
    if (all && all.length && all.every(b => b === '')) continue;
    const known = (all || []).filter(b => b !== null && b.trim() !== '');
    const kinds = known.map(classifyValue);
    const useWord =
      !all ||
      !all.length ||
      all.includes(null) ||
      kinds.every(k => k === 'other');
    const base = {
      label: o.label,
      left: o.left,
      right: o.right,
      pristineLeft: [...w.lefts],
      pristineRight: [...w.rights],
    };
    let hit = null;
    for (let i = 0; i < known.length && !hit; i++)
      for (const left of o.lefts) {
        for (const right of o.rights)
          if (valueRuleFires(kinds[i], known[i], left, right, w)) {
            hit = {
              kind: kinds[i],
              value: renderBranch(known[i]),
              left,
              right,
            };
            break;
          }
        if (hit) break;
      }
    if (!hit && useWord)
      for (const left of o.lefts) {
        for (const right of o.rights)
          if (wordRuleFires(left, right, w)) {
            hit = { kind: 'unknown', left, right };
            break;
          }
        if (hit) break;
      }
    if (hit) out.push({ ...base, ...hit });
  }
  return out;
};

// Fingerprint of what an id's slots render, so a change to a VALUE (Anthropic
// turning a whole sentence into a fragment) re-opens a reviewed row. Typed:
// an unknown branch (null) and the literal text "null" hash differently.
export const valueHash = values =>
  crypto
    .createHash('sha1')
    .update(
      JSON.stringify(
        [...(values || new Map())]
          .map(([l, v]) => [
            l,
            [...v.branches].sort((a, b) =>
              a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0
            ),
          ])
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      )
    )
    .digest('hex')
    .slice(0, 12);

export const isTrim = (entries, body) => {
  const b = body.trim();
  if (!b) return false;
  return !entries.some(p => reconstruct(p).trim() === b);
};

// Fold the allowlist over raw findings. `bodiesById` maps id -> [{ set, body }]
// (one per audited set) so a row can be judged against every set at once. A
// row applies only while BOTH its override body hash and its pristine hash
// still match: an unchanged override over a changed pristine is a new question.
// Every row for an id in `ids` that never applied — override gone, id gone
// from the catalogue, no longer a trim, body or pristine changed — is stale.
export const evaluate = ({
  entriesById,
  bodiesById,
  ids,
  allow = {},
  valuesById = new Map(),
}) => {
  const findings = [];
  const justified = [];
  const stale = [];
  let checked = 0;
  for (const id of ids) {
    const entries = entriesById.get(id);
    const rule = allow[id];
    if (!entries) {
      if (rule)
        stale.push({
          id,
          why: 'id is no longer in the catalogue; delete the row',
        });
      continue;
    }
    const pHash = pristineHash(entries);
    const values = valuesById.get(id) || new Map();
    const vHash = valueHash(values);
    let ruleUsed = false;
    let trims = 0;
    const firedLabels = new Set();
    const bodies = bodiesById.get(id) || [];
    for (const { set, body } of bodies) {
      if (!isTrim(entries, body)) continue;
      trims++;
      checked++;
      const raw = contextFindings(entries, body, values);
      const applies =
        rule &&
        rule.bodyHash === bodyHash(body) &&
        rule.pristineHash === pHash &&
        rule.valueHash === vHash;
      if (applies) ruleUsed = true;
      const live = applies ? rule.tokens || {} : {};
      for (const f of raw) {
        if (f.label in live) {
          firedLabels.add(f.label);
          justified.push({ id, set, label: f.label, reason: live[f.label] });
        } else findings.push({ id, set, ...f });
      }
    }
    if (!rule) continue;
    if (!bodies.length)
      stale.push({
        id,
        why: 'no override file for this id in the audited set(s); delete the row',
      });
    else if (!trims)
      stale.push({
        id,
        why: 'the override is no longer a trim; delete the row',
      });
    else if (!ruleUsed) {
      const why = !bodies.some(b => rule.bodyHash === bodyHash(b.body))
        ? `no audited body matches bodyHash ${rule.bodyHash}; re-review and re-key the row`
        : rule.pristineHash !== pHash
          ? `pristine changed (now ${pHash}); re-review and re-key the row`
          : `a slot value changed (now ${vHash}); re-review and re-key the row`;
      stale.push({ id, why });
    } else
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

// Flags are order-independent: `--json path` and `--json=path` both work, and
// the catalogue is the first bare argument that is not a flag's value.
export const parseCliArgs = argv => {
  const out = {
    jsonPath: null,
    idsFile: null,
    all: false,
    outPath: null,
    cliPath: null,
    allowPath: null,
  };
  const errors = [];
  const valueOf = (a, i, name) => {
    if (a.startsWith(`${name}=`)) return [a.slice(name.length + 1), i];
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      errors.push(`${name} needs a value`);
      return [null, i];
    }
    return [v, i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--json' || a.startsWith('--json='))
      [out.outPath, i] = valueOf(a, i, '--json');
    else if (a === '--ids' || a.startsWith('--ids='))
      [out.idsFile, i] = valueOf(a, i, '--ids');
    else if (a === '--cli' || a.startsWith('--cli='))
      [out.cliPath, i] = valueOf(a, i, '--cli');
    else if (a === '--allowlist' || a.startsWith('--allowlist='))
      [out.allowPath, i] = valueOf(a, i, '--allowlist');
    else if (a.startsWith('--')) errors.push(`unknown flag ${a}`);
    else if (out.jsonPath === null) out.jsonPath = a;
    else errors.push(`unexpected argument ${a}`);
  }
  return { ...out, errors };
};

const main = () => {
  const die = (msg, code = 2) => {
    console.error(`checkSlotContext: ${msg}`);
    process.exit(code);
  };
  const readJson = (file, what) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return die(`could not read ${what} ${file}: ${e.message}`);
    }
  };

  const parsed = parseOverrideArgs(process.argv.slice(2));
  const {
    jsonPath,
    idsFile,
    all,
    outPath,
    cliPath,
    allowPath: allowArg,
    errors,
  } = parseCliArgs(parsed.rest);
  const usage =
    'usage: <prompts.json> (--set=<dir> | --sets=<a>,<b>) (--ids <file> | --all) [--cli <pristine cli.js>] [--allowlist <path>] [--json <path>]';
  if (errors.length) die(`${errors.join('; ')}\n${usage}`);
  if (!jsonPath || !parsed.specified) die(usage);
  if (!idsFile && !all) die('pass --ids <file> to gate a bump, or --all');
  if (idsFile && all) die('pass --ids or --all, not both');
  // resolveOverrideSets exits on its own when nothing resolves (exit 0 for an
  // empty `--sets=`); a gate that audits no set has not passed, so route
  // every such exit through die().
  const resolved = resolveOverrideSets(parsed, {
    fallback: 'none',
    exit: () => die('no override set resolved — nothing was checked'),
  });
  if (!resolved.length) die('no override set resolved — nothing was checked');
  printAuditedSets(resolved);
  if (!fs.existsSync(jsonPath)) die(`no prompts JSON at ${jsonPath}`);
  if (idsFile && !fs.existsSync(idsFile)) die(`no ids file at ${idsFile}`);

  const catalogue = readJson(jsonPath, 'prompts JSON');
  if (!Array.isArray(catalogue?.prompts) || !catalogue.prompts.length)
    die(`${jsonPath} has no "prompts" entries — wrong file?`);
  // Slot values come from the PRISTINE bundle of the catalogue's version: the
  // --cli path, else TWEAKCC_PRISTINE_CLI, else the copy --apply saves. A
  // bundle of another version would resolve the wrong values, so it is refused.
  const bundlePath =
    cliPath || process.env.TWEAKCC_PRISTINE_CLI || pristineCliPath();
  if (!fs.existsSync(bundlePath))
    die(`no pristine bundle at ${bundlePath} — pass --cli <cli.js>`);
  const source = fs.readFileSync(bundlePath, 'utf8');
  const versions = new Map();
  for (const m of source.matchAll(/VERSION:"(\d+\.\d+\.\d+)"/g))
    versions.set(m[1], (versions.get(m[1]) || 0) + 1);
  const bundleVersion = [...versions].sort((a, b) => b[1] - a[1])[0]?.[0];
  const catVersion =
    catalogue.version ||
    (path.basename(jsonPath).match(/(\d+\.\d+\.\d+)/) || [])[1];
  if (!bundleVersion || bundleVersion !== catVersion)
    die(
      `${bundlePath} is CC ${bundleVersion ?? 'unknown'}, the catalogue is ${catVersion ?? 'unknown'} — pass --cli for the matching pristine bundle`
    );
  const { values: valuesById, stats: resolveStats } = resolveSlotValues(
    source,
    catalogue
  );
  console.log(
    `slot values: ${resolveStats.promptsMatched} of ${resolveStats.slotBearing} slot-bearing catalogued prompt(s) located in ${path.basename(bundlePath)} (CC ${bundleVersion}); ${resolveStats.resolved} rendered slot position(s) fully resolved, ${resolveStats.unknown} with runtime data`
  );
  // A same-VERSION bundle that has been patched (an override applied) or is
  // otherwise not the pristine build still parses, but most templates no
  // longer match the catalogue and every slot silently falls back to the word
  // rule. Measured on the pristine 2.1.292 bundle: 5032 of 5032 slot-bearing
  // ids located. 90% leaves room for the few build-stamped or multi-site
  // templates a new version can miss while catching any patched bundle.
  if (resolveStats.promptsMatched < 0.9 * resolveStats.slotBearing)
    die(
      `only ${resolveStats.promptsMatched} of ${resolveStats.slotBearing} slot-bearing prompts were found in ${bundlePath} — is it the PRISTINE bundle? (floor 90%)`
    );

  const entriesById = new Map();
  for (const p of catalogue.prompts) {
    if (!p.id) continue;
    if (!entriesById.has(p.id)) entriesById.set(p.id, []);
    entriesById.get(p.id).push(p);
  }

  const bodiesById = new Map();
  let shadowSkipped = 0;
  for (const { dir, name } of resolved) {
    if (!fs.existsSync(dir)) die(`no override set at ${dir}`);
    if (!fs.readdirSync(dir).some(f => f.endsWith('.md')))
      die(`override set ${dir} has no .md files — wrong directory?`);
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

  const allowPath =
    allowArg ||
    path.join(
      path.dirname(url.fileURLToPath(import.meta.url)),
      '..',
      'data',
      'slot-context-allowlist.json'
    );
  if (allowArg && !fs.existsSync(allowArg)) die(`no allowlist at ${allowArg}`);
  const allow = fs.existsSync(allowPath)
    ? readJson(allowPath, 'allowlist')
    : {};

  // --all also walks every allowlist row, so a row whose override was deleted
  // or renamed, or whose id left the catalogue, is reported stale instead of
  // sitting unjudged forever. In --ids mode a row outside the run is not judged.
  const ids = idsFile
    ? [
        ...new Set(
          fs
            .readFileSync(idsFile, 'utf8')
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
        ),
      ]
    : [...new Set([...bodiesById.keys(), ...Object.keys(allow)])];
  if (idsFile && !ids.length)
    die(`${idsFile} names no ids — nothing was checked`);
  const scopedAllow = Object.fromEntries(
    Object.entries(allow).filter(([id]) => ids.includes(id))
  );
  const { findings, justified, stale, checked } = evaluate({
    entriesById,
    bodiesById,
    ids,
    allow: scopedAllow,
    valuesById,
  });

  // How each override slot occurrence was judged: by value alone (every
  // branch known and classified), by both rules (some branch unknown or only
  // `other`), by the word rule alone (no resolved value), or skipped (renders
  // only "").
  const judged = { value: 0, both: 0, word: 0, skipped: 0 };
  for (const id of ids) {
    const entries = entriesById.get(id);
    if (!entries) continue;
    const labels = labelsOf(entries);
    const values = valuesById.get(id) || new Map();
    for (const { body } of bodiesById.get(id) || []) {
      if (!isTrim(entries, body)) continue;
      for (const o of slotOccurrences(body, labels)) {
        const all = values.get(o.label)?.branches;
        const known = (all || []).filter(b => b !== null && b.trim() !== '');
        if (all && all.length && all.every(b => b === '')) judged.skipped++;
        else if (!known.length) judged.word++;
        else if (
          all.includes(null) ||
          known.every(b => classifyValue(b) === 'other')
        )
          judged.both++;
        else judged.value++;
      }
    }
  }
  console.log(
    `slot occurrences in trims: ${judged.value} by value, ${judged.both} by value and words (a branch is runtime data or unclassifiable), ${judged.word} by words only, ${judged.skipped} always empty`
  );

  for (const j of justified)
    console.log(`  ✓ ${j.set}/${j.id}: ${j.label} — justified: ${j.reason}`);
  for (const st of stale)
    console.log(`  ! ${st.id}: allowlist row is stale — ${st.why}`);
  if (shadowSkipped)
    console.log(
      `  · ${shadowSkipped} id(s) owned by another override skipped (shadows: frontmatter)`
    );

  if (outPath) fs.writeFileSync(outPath, JSON.stringify(findings, null, 1));

  // A gate that checked nothing has not passed. Under --ids every named id is
  // one this run changed; if none of them is a trim in the audited set, the
  // ids file or the set is wrong.
  if (!checked && (idsFile ? ids.length : true))
    die(
      idsFile
        ? `none of the ${ids.length} id(s) in ${idsFile} is a trimmed override in the audited set(s) — nothing was checked`
        : 'no trimmed override in the audited set(s) — nothing was checked'
    );

  if (!findings.length) {
    console.log(
      `checkSlotContext: 0 — every kept slot still renders in place across ${checked} trimmed override(s) (${justified.length} reviewed${stale.length ? `, ${stale.length} stale row(s)` : ''})`
    );
    process.exit(stale.length ? 1 : 0);
  }

  const byId = new Map();
  for (const f of findings) {
    const k = `${f.set}/${f.id}`;
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(f);
  }
  const byKind = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  console.log(
    `checkSlotContext: ${findings.length} slot occurrence(s) in ${byId.size} of ${checked} trimmed override(s) render out of place (${Object.entries(
      byKind
    )
      .map(([k, n]) => `${n} ${k}`)
      .join(
        ', '
      )}; ${justified.length} reviewed${stale.length ? `, ${stale.length} stale row(s)` : ''})`
  );
  for (const [k, list] of byId) {
    console.log(`  ${k}`);
    for (const f of list)
      console.log(
        `      ${f.label} [${f.kind}]: override [${f.left}] _ [${f.right}]  pristine [${f.pristineLeft.join(' | ')}] _ [${f.pristineRight.join(' | ')}]` +
          (f.value
            ? `\n        value ${JSON.stringify(f.value.slice(0, 160))}`
            : '')
      );
  }
  console.log(
    '\nA fragment now starting a sentence, a bare name now standing alone, a sentence\n' +
      'now run into a phrase — or, for a runtime value, a slot whose words were cut on\n' +
      'both sides. Restore the phrase, or record why the placement is sound in\n' +
      'data/slot-context-allowlist.json (bodyHash, pristineHash, valueHash).'
  );
  process.exit(1);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main();
}
