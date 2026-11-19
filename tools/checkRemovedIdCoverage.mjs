#!/usr/bin/env node
/**
 * Removed-id coverage gate — a catalogued prompt that LEFT the catalogue while
 * its text is still in the bundle.
 *
 * Every other coverage gate runs forward: it starts from something the
 * extractor captured, or from a shape it knows how to assemble, and asks
 * whether that thing is catalogued. None of them can start from a prompt that
 * used to have an id and quietly stopped having one, because after the fact
 * there is nothing left pointing at it. The previous version's catalogue is the
 * only record that the text was ever ours, and it is thrown away at the moment
 * the new JSON is written.
 *
 * Found on CC 2.1.239. Anthropic folded the eight artifact published-path
 * checks into one shared validator:
 *
 *     // 2.1.238 — each message its own template, each one catalogued
 *     `files: published path ${JSON.stringify(e)} contains a backslash — …`
 *
 *     // 2.1.239 — one validator, the prefix hoisted to a call-site label
 *     function Gem(e, t) { … return { errMsg: `${t} ${JSON.stringify(e)} contains a backslash — …` } }
 *     Gem(e, "files: published path")
 *
 * Every body now opens with a bare `${t}`, so the leading literal piece is a
 * single space and the surviving prose is short. The prose gate drops it,
 * `detectionCoverage` only assembles multi-NODE composites and each of these is
 * one template node, and `checkParamSlotLiterals` surfaced only the one call
 * site whose argument carries prose rather than a label. Six model-facing
 * tool-results left the catalogue in one commit and every gate was green.
 *
 * The check runs the other way. For each id in `prev - cur`, slide a window
 * across the previous body's literal runs and ask where that text is now:
 *
 *   in-catalogue  the text is in the new JSON under some id. A rename or an
 *                 id-collision reshuffle — not a loss, but re-map any override
 *                 by CONTENT before trusting the id.
 *   in-sidecar    the text is a pending classify candidate. It gets a verdict
 *                 and a name this run; nothing to do here.
 *   IN-BUNDLE     the text is in cli.js and NOWHERE else. This is the finding:
 *                 model-facing prose that silently stopped being catalogued.
 *   gone          absent from all three. A real removal — archive the override.
 *
 * Only IN-BUNDLE fails. `gone` is reported so the archive list is computed
 * rather than eyeballed, and reviewed removals are recorded in the allowlist so
 * a stable removal stops being re-reported every bump.
 *
 * `in-catalogue` is a claim about the WHOLE body, not one window. CC 2.1.294
 * lost the resume-only arm of the orphaned-agents tail; its relaunch sibling
 * shares the opening clause, so the first 25-char window matched the sibling,
 * the id was called renamed to it, and the gate passed. A removed id counts as
 * renamed only when the catalogue carries most of its distinctive prose (slot
 * syntax stripped, so the shared `${x.length===1?…}` scaffolding is not
 * evidence), and even then a distinctive run the bundle holds more often than
 * the catalogue does is a site no successor covers: IN-BUNDLE.
 *
 * Two things the 25-char window has to get right, both of them §12 rows that
 * have cost a bump before:
 *
 *   - Probe ASCII-only. An em dash is `—` in the bundle, so a window
 *     carrying one reads as absent from a file that contains it.
 *   - Step the window by 5, not by its own width. A reword moves the boundary,
 *     and a stride-width sweep can miss a body that is 90% intact.
 *
 * A third: 25-char windows of generic English, YAML, or SDK snippets match the
 * bundle by coincidence after the prompt itself is gone. IN-BUNDLE is confirmed
 * with single-line ASCII probes of 32+ chars from mid-body (the bundle stores a
 * newline as a literal backslash-n, so a probe that spans a line break is a
 * false 0). A body whose 32+ probes are all absent is `gone`, even if a short
 * window hit. Short bodies with no 32+ run still use the 25-char fallback.
 *
 * Absence is counted with `String.prototype.includes`, never `grep`: one NUL
 * byte anywhere makes ugrep return false-empty for every pattern.
 *
 *   node tools/checkRemovedIdCoverage.mjs <cli.js> <prev.json> <cur.json> [--update-allowlist]
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseExpressionAt, tokenizer, tokTypes } from 'acorn';
import { loadMatcherCore } from './checkBakedIdentifiers.mjs';

const WINDOW = 25;
const STRIDE = 5;
const BUNDLE_PROBE_MIN = 32;
const BUNDLE_PROBE_COUNT = 8;
const ALLOWLIST =
  process.env.TWEAKCC_REMOVED_ID_ALLOWLIST ||
  path.join(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    'data',
    'removed-id-allowlist.json'
  );

const [cliPath, prevPath, curPath, ...flags] = process.argv.slice(2);
const updateAllowlist = flags.includes('--update-allowlist');
const RENAME_MAP =
  process.env.TWEAKCC_RENAME_MAP || '/tmp/removed-id-renames.json';

if (!cliPath || !prevPath || !curPath) {
  console.error(
    'usage: checkRemovedIdCoverage.mjs <cli.js> <prev.json> <cur.json> [--update-allowlist]'
  );
  process.exit(2);
}
for (const f of [cliPath, prevPath, curPath]) {
  if (!fs.existsSync(f)) {
    console.error(`checkRemovedIdCoverage: missing input ${f} — cannot run`);
    process.exit(2);
  }
}

const readPrompts = f => JSON.parse(fs.readFileSync(f, 'utf8')).prompts || [];

// The `${` and `}` are already in the pieces, so the BARE label goes between
// them, keyed by `identifiers[i]` as a string. Mirrors
// reconstructContentFromPieces in src/systemPromptSync.ts — never re-derive it
// inline differently, a hand-rolled version makes prompts un-matchable.
const reconstruct = p => {
  const pieces = p.pieces || [];
  const identifiers = p.identifiers || [];
  const map = p.identifierMap || {};
  let out = '';
  for (let i = 0; i < pieces.length; i += 1) {
    out += pieces[i];
    if (i < identifiers.length) {
      out += map[String(identifiers[i])] ?? `UNKNOWN_${identifiers[i]}`;
    }
  }
  return out;
};

// Only ASCII runs are probeable: everything else escapes in the bundle.
const isAscii = s => !/[^\x20-\x7e]/.test(s);

const literalRuns = p => {
  const pieces = p.pieces || [];
  return pieces
    .map((x, i) =>
      typeof x === 'string' ? proseOfPiece(x, i, pieces.length) : ''
    )
    .filter(x => x.length >= WINDOW);
};

// A prompt built almost entirely of slots has no run this long and therefore no
// probe surface at all: every WINDOW pass and `midBodyProbes` come back empty
// and the id falls through to `gone`, which tells the operator to archive a live
// override. CC 2.1.261 had two — `Published ${.path)} at ${.url)}${}…` and the
// computer-use background-element result — both still in the bundle and both
// already sitting in the classify sidecar. Same blind spot the shingle-continuity
// pass has on short prompts, one gate over.
//
// The fallback probes the SHORT pieces, and requires EVERY usable one to be
// present rather than any single one. A 12-character fragment matching by
// coincidence is ordinary; all of a prompt's fragments matching is not, so the
// stricter form is what keeps this from becoming a gate people ignore.
// A piece carrying a BRACKET KEY holds a minified name that differs per build
// and per platform (`[_.kind]` on one, `[k.kind]` on the next), so its absence
// is evidence about the minifier, not about the prompt. Requiring it is how the
// computer-use background-element result still read as removed after the short
// pass was added. The match engines generalize exactly this shape; here it is
// cheaper to drop such a piece from the required set than to rebuild a matcher.
const MINIFIED_BRACKET_KEY = /\[[$\w]{1,3}[.\]-]/;
const SHORT_PIECE_MIN = 8;
const shortRuns = p =>
  (p.pieces || [])
    .map(x => (typeof x === 'string' ? x.trim() : ''))
    .filter(
      s =>
        s.length >= SHORT_PIECE_MIN &&
        isAscii(s) &&
        /[A-Za-z]{3,}/.test(s) &&
        !MINIFIED_BRACKET_KEY.test(s)
    );

// The share of an old body's distinctive units the catalogue must carry for the
// id to count as renamed or reshuffled. On 2.1.294 the resume-only tail scored
// 0.33 against its sibling and a reworded removal 0.23 against the prompt that
// absorbed it; the four genuine renames scored 0.73-1.00.
const RENAME_SHARE = 0.6;
const UNIT_MIN = 12;

const allPresent = (runs, haystack) =>
  runs.length > 0 && runs.every(s => haystack.includes(s));

const asciiRunsOnLine = line => {
  const runs = [];
  let cur = '';
  const flush = () => {
    const s = cur.trim();
    if (s.length >= BUNDLE_PROBE_MIN) runs.push(s);
    cur = '';
  };
  // A backtick is a template boundary, so a run across one carries code.
  for (const ch of line) {
    if (ch >= ' ' && ch <= '~' && ch !== '`') cur += ch;
    else flush();
  }
  flush();
  return runs;
};

// Longest single-line ASCII runs from mid-body. One generic 32-char SDK
// snippet matching the bundle is not evidence the prompt survived; the
// distinctive sentences are.
// `pieces` carry the interpolation SYNTAX, not just the prose: every piece but
// the last ends with the opening `${`, and every piece but the first opens with
// the slot's expression source up to its closing `}`. Probing that text against
// the bundle can only ever fail, and because a failing probe RETURNS `gone`
// before the window scan below runs, a prompt whose distinctive sentence happens
// to abut a slot is reported as removed while it is still shipping to the model.
// CC 2.1.273 had one: the /update transcript-path-drift refusal, whose only
// prose run ended `…on the latest version${` after Anthropic dropped its
// trailing auto-replies clause. Strip the syntax before building probes.
const proseOfPiece = (piece, i, n) => {
  let out = piece;
  if (i > 0) {
    const close = out.indexOf('}');
    out = close >= 0 ? out.slice(close + 1) : out;
  }
  if (i < n - 1) out = out.replace(/\$\{$/, '');
  return out;
};

const midBodyProbes = p => {
  const lines = [];
  const pieces = p.pieces || [];
  for (let i = 0; i < pieces.length; i++) {
    if (typeof pieces[i] !== 'string') continue;
    for (const line of proseOfPiece(pieces[i], i, pieces.length).split('\n')) {
      lines.push(...asciiRunsOnLine(line));
    }
  }
  if (lines.length === 0) return [];
  const uniq = [...new Set(lines)];
  if (uniq.length <= BUNDLE_PROBE_COUNT) return uniq;
  const lo = Math.floor(uniq.length * 0.2);
  const hi = Math.max(lo + 1, Math.ceil(uniq.length * 0.8));
  const mid = uniq.slice(lo, hi);
  mid.sort((a, b) => b.length - a.length);
  return mid.slice(0, BUNDLE_PROBE_COUNT);
};

// A body's prose: each piece with its slot syntax stripped, one entry per line.
// The slot expressions are not evidence of identity — sibling arms of one
// ternary share `${x.length===1?"Agent":"Agents"}` and differ only in prose.
const proseLines = p => {
  const pieces = p.pieces || [];
  const lines = [];
  for (let i = 0; i < pieces.length; i++) {
    if (typeof pieces[i] !== 'string') continue;
    for (const raw of proseOfPiece(pieces[i], i, pieces.length).split('\n')) {
      const line = raw.trim();
      if (/[A-Za-z]{3,}/.test(line)) lines.push(line);
    }
  }
  return lines;
};

// What "most of the old body" is measured in: word trigrams of its prose. A
// literal Anthropic turned into a slot (`with SendMessage` -> `with ${…}`)
// costs only the trigrams that touch it, where a 25-char window loses every
// window spanning it; on 2.1.294 that alone took a real rename from 0.73 to
// 0.36. A line too short for a trigram counts whole.
const shareUnits = p => {
  const units = new Set();
  for (const line of proseLines(p)) {
    const words = line.split(/\s+/);
    if (words.length < 3) {
      if (line.length >= UNIT_MIN) units.add(line);
      continue;
    }
    for (let i = 0; i + 3 <= words.length; i++) {
      units.add(words.slice(i, i + 3).join(' '));
    }
  }
  return [...units];
};

// What is counted in the bundle: 25-char windows of the prose, long enough that
// a surplus is a site and not a common phrase.
const strayProbes = p => {
  const units = new Set();
  for (const line of proseLines(p)) {
    if (line.length < WINDOW) continue;
    for (let off = 0; off + WINDOW <= line.length; off += STRIDE) {
      units.add(line.slice(off, off + WINDOW));
    }
    units.add(line.slice(line.length - WINDOW));
  }
  return [...units];
};

const countOf = (haystack, needle) => {
  let n = 0;
  for (
    let i = haystack.indexOf(needle);
    i >= 0;
    i = haystack.indexOf(needle, i + 1)
  )
    n++;
  return n;
};

const cli = fs.readFileSync(cliPath, 'utf8');
const prev = readPrompts(prevPath);
const cur = readPrompts(curPath);
const core = await loadMatcherCore();
const slotSpans = body => {
  const spans = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '$' || body[i + 1] !== '{') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && body[j] === '\\'; j--) backslashes++;
    if (backslashes % 2) continue;
    try {
      const expression = parseExpressionAt(body, i + 2, {
        ecmaVersion: 'latest',
        preserveParens: true,
        allowAwaitOutsideFunction: true,
        allowSuperOutsideMethod: true,
        checkPrivateFields: false,
      });
      const close = tokenizer(body.slice(expression.end), {
        ecmaVersion: 'latest',
      }).getToken();
      if (close.type !== tokTypes.braceR) continue;
      const end = expression.end + close.end;
      spans.push([i, end]);
      i = end - 1;
    } catch {
      continue;
    }
  }
  return spans;
};
const coverageBody = body => {
  let out = '';
  let cursor = 0;
  for (const [i, end] of slotSpans(body)) {
    out += body.slice(cursor, i);
    out += core
      .generalizeExpressionIdentifiers(['${', body.slice(i + 2, end)])
      .join('');
    cursor = end;
  }
  return out + body.slice(cursor);
};

const cookEscapes = body =>
  body.replace(/\\([nrt"'`\\])/g, (_m, c) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c
  );
const curIds = new Set(cur.map(p => p.id).filter(Boolean));
const curBlob = cur.map(reconstruct).join('\n');
// Which CURRENT id carries the surviving text. `in-catalogue` alone tells the
// operator a rename happened but not what to rename TO, and re-deriving that
// with an ad-hoc fuzzy matcher is exactly the reimplementation that gets the
// answer wrong. Report the successor.
const curBodies = cur
  .filter(p => p.id)
  .map(p => ({
    id: p.id,
    labels: [
      ...new Set(
        (p.identifiers || []).map(
          i => (p.identifierMap || {})[String(i)] ?? `UNKNOWN_${i}`
        )
      ),
    ],
    body: reconstruct(p),
    coverageBody: coverageBody(reconstruct(p)),
    cooked: cookEscapes(reconstruct(p)),
  }));
// A parent can carry a fragment as an escaped string literal inside a slot
// (`${"\\nThe result…"}`), so nesting is also checked on unescaped bodies.
const nestedIn = (b, o) =>
  (o.coverageBody.length > b.coverageBody.length &&
    o.coverageBody.includes(b.coverageBody)) ||
  (o.cooked.length > b.cooked.length && o.cooked.includes(b.cooked));
const { splitModuleBundle } = createRequire(import.meta.url)(
  './lib/moduleBundle.cjs'
);
const bundleSegments = splitModuleBundle(cli) || [{ start: 0, source: cli }];
const literalIndex = new Map();
const literalsOfSegment = si => {
  if (literalIndex.has(si)) return literalIndex.get(si);
  const { start, source } = bundleSegments[si];
  const lits = [];
  const stack = [];
  try {
    for (const tok of tokenizer(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
    })) {
      const t = tok.type;
      const top = stack.at(-1);
      const s0 = start + tok.start;
      const s1 = start + tok.end;
      if (t === tokTypes.backQuote) {
        if (top && top.depth === null) {
          stack.pop();
          lits.push(top.lit);
        } else {
          const lit = { chunks: [], parent: top?.lit ?? null };
          stack.push({ lit, depth: null });
        }
      } else if (t === tokTypes.template || t === tokTypes.invalidTemplate) {
        top?.lit.chunks.push([s0, s1]);
      } else if (t === tokTypes.dollarBraceL) {
        if (top) top.depth = 0;
      } else if (t === tokTypes.string) {
        lits.push({ chunks: [[s0 + 1, s1 - 1]], parent: top?.lit ?? null });
      } else if (top && top.depth !== null) {
        if (t === tokTypes.braceL) top.depth++;
        else if (t === tokTypes.braceR)
          top.depth = top.depth === 0 ? null : top.depth - 1;
      }
    }
  } catch {
    literalIndex.set(si, []);
    return [];
  }
  const index = lits
    .flatMap(lit => lit.chunks.map(([s0, s1]) => [s0, s1, lit]))
    .sort((x, y) => x[0] - y[0]);
  literalIndex.set(si, index);
  return index;
};
const segmentAt = at => {
  let lo = 0;
  let hi = bundleSegments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bundleSegments[mid].start <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};
const literalsAround = (at, len) => {
  const index = literalsOfSegment(segmentAt(at));
  let lo = 0;
  let hi = index.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid][0] <= at) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0 || at + len > index[best][1]) return [];
  const out = [];
  for (let lit = index[best][2]; lit; lit = lit.parent) out.push(lit);
  return out;
};
const shapeOf = b => {
  if (b.shape) return b.shape;
  const chunks = [];
  const exprs = [];
  let cursor = 0;
  for (const [i, end] of slotSpans(b.body)) {
    chunks.push([cursor, i]);
    exprs.push([i, end]);
    cursor = end;
  }
  chunks.push([cursor, b.body.length]);
  const texts = chunks.map(([s0, s1]) => cookEscapes(b.body.slice(s0, s1)));
  b.shape = { chunks, exprs, texts, fills: new Map() };
  return b.shape;
};
const fillsLiteral = (shape, lit) => {
  if (shape.fills.has(lit)) return shape.fills.get(lit);
  const ok =
    lit.chunks.length === shape.chunks.length &&
    shape.texts.every((text, k) => {
      const w = walkForward(cli, lit.chunks[k][0], text, 0);
      return w.n === text.length && w.j === lit.chunks[k][1];
    });
  shape.fills.set(lit, ok);
  return ok;
};
const claimsSite = (b, q, len, lit, at) => {
  const shape = shapeOf(b);
  if (!fillsLiteral(shape, lit)) return false;
  const k = shape.chunks.findIndex(([s0, s1]) => s0 <= q && q + len <= s1);
  if (k >= 0) {
    const text = cookEscapes(b.body.slice(shape.chunks[k][0], q));
    const w = walkForward(cli, lit.chunks[k][0], text, 0);
    return w.n === text.length && w.j === at;
  }
  const e = shape.exprs.findIndex(([s0, s1]) => s0 <= q && q + len <= s1);
  if (e < 0) return false;
  const [s0, s1] = shape.exprs[e];
  const parts = exprParts(b, b.body.slice(s0, q));
  const tail = exprParts(b, b.body.slice(q + len, s1));
  const j = walkExpr(lit.chunks[e][1], parts);
  if (j !== at) return false;
  return walkExpr(at + len, tail) === lit.chunks[e + 1][0];
};
const IDENT = /[$\w]+/y;
const exprParts = (b, src) => {
  if (!b.labels.length) return [src];
  const escaped = b.labels.map(l => l.replace(/[$]/g, '\\$'));
  return src.split(new RegExp(`(?<![$\\w])(?:${escaped.join('|')})(?![$\\w])`));
};
const walkExpr = (j, parts) => {
  for (let k = 0; k < parts.length; k++) {
    if (k > 0) {
      IDENT.lastIndex = j;
      if (!IDENT.test(cli)) return -1;
      j = IDENT.lastIndex;
    }
    const w = walkForward(cli, j, parts[k], 0);
    if (w.n !== parts[k].length) return -1;
    j = w.j;
  }
  return j;
};
const maxMatching = choices => {
  const owner = new Map();
  const assign = (c, seen) => {
    for (const s of choices[c]) {
      if (seen.has(s)) continue;
      seen.add(s);
      if (!owner.has(s) || assign(owner.get(s), seen)) {
        owner.set(s, c);
        return true;
      }
    }
    return false;
  };
  let n = 0;
  for (let c = 0; c < choices.length; c++) if (assign(c, new Set())) n++;
  return n;
};
const namedSites = (run, lines) => {
  const holders = curBodies.filter(b => b.body.includes(run));
  if (!holders.length) return 0;
  const sites = [];
  for (let i = cli.indexOf(run); i >= 0; i = cli.indexOf(run, i + 1))
    sites.push({ at: i, lits: literalsAround(i, run.length) });
  const placed = [];
  const unplaced = [];
  for (const b of holders) {
    const choices = [];
    for (let q = b.body.indexOf(run); q >= 0; q = b.body.indexOf(run, q + 1)) {
      choices.push(
        sites
          .filter(({ at, lits }) =>
            lits.some(lit => claimsSite(b, q, run.length, lit, at))
          )
          .map(({ at }) => at)
      );
    }
    if (choices.some(c => c.length)) placed.push({ b, choices });
    else unplaced.push(b);
  }
  const counted = lines ? new Set(siteOffsets(cli, run, lines)) : null;
  const choices = placed.flatMap(({ choices }) =>
    choices.map(c => (counted ? c.filter(s => counted.has(s)) : c))
  );
  return (
    maxMatching(choices) +
    unplaced
      .filter(
        b =>
          !holders.some(o => o !== b && nestedIn(b, o)) &&
          !placed.some(({ b: o }) => nestedIn(o, b))
      )
      .reduce(
        (n, b) =>
          n + (lines ? countSites(b.body, run, lines) : countOf(b.body, run)),
        0
      )
  );
};
// The current id carrying the largest share of `units`, and that share.
// Testing every unit against every body made this the gate's hot loop (85 s of
// 285 s on CC 2.1.312). A unit can only sit in a body that holds its first
// word, so candidates come from a word index and only those are scanned. Ties
// keep the earliest body, as the linear scan did.
// Words are maximal runs of letters and digits on both sides, so any letter run
// inside a unit is also a whole run inside every body that contains the unit,
// except at the unit's two ends, where it may be cut mid-word; those are skipped.
const WORD = /[A-Za-z0-9]+/g;
const bodyIdxByWord = new Map();
curBodies.forEach(({ body }, i) => {
  for (const w of new Set(body.match(WORD) || [])) {
    if (!bodyIdxByWord.has(w)) bodyIdxByWord.set(w, []);
    bodyIdxByWord.get(w).push(i);
  }
});
const bodiesHolding = u => {
  const all = [...u.matchAll(WORD)];
  const words = all
    .filter(
      m => m.index > 0 && m.index + m[0].length < u.length && m[0].length >= 3
    )
    .map(m => m[0]);
  if (!words.length) return null;
  let best = null;
  for (const w of words) {
    const list = bodyIdxByWord.get(w);
    if (!list) return [];
    if (!best || list.length < best.length) best = list;
  }
  return best;
};
const bestSuccessor = units => {
  const hits = new Map();
  for (const u of units) {
    const cand = bodiesHolding(u);
    const scan = cand ?? curBodies.map((_, i) => i);
    for (const i of scan)
      if (curBodies[i].body.includes(u)) hits.set(i, (hits.get(i) || 0) + 1);
  }
  let best = null;
  let bestHit = 0;
  for (const [i, n] of [...hits].sort((a, b) => a[0] - b[0]))
    if (n > bestHit) {
      bestHit = n;
      best = curBodies[i].id;
    }
  return { id: best, share: units.length ? bestHit / units.length : 0 };
};
const successorOfAll = runs => {
  for (const { id, body } of curBodies) {
    if (runs.every(r => body.includes(r))) return id;
  }
  return null;
};

// The classify sidecar: a candidate awaiting a verdict this run is not a gap.
// The directory is overridable so a test can be hermetic — reading the real
// `/tmp` would let whatever bump is in flight decide the answer.
const sidecarBlob = (() => {
  const dir =
    process.env.TWEAKCC_CLASSIFY_DIR || process.env.SHOWTIME_TMP || '/tmp';
  let blob = '';
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter(f => /^classify-chunk-\d+\.json$/.test(f))
      .map(f => path.join(dir, f));
  } catch {
    return '';
  }
  for (const f of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    const items = Array.isArray(parsed)
      ? parsed
      : parsed.candidates || parsed.items || [];
    for (const c of items) blob += `\n${c.body || ''}`;
  }
  return blob;
})();

const prevById = new Map();
for (const p of prev) {
  if (!p.id) continue;
  if (!prevById.has(p.id)) prevById.set(p.id, []);
  prevById.get(p.id).push(p);
}

const allowlist = fs.existsSync(ALLOWLIST)
  ? JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8'))
  : {};

// A window is 25 chars of the old prose, and 25 chars is short enough to land
// inside unrelated text: ` Claude Code configuratio` ends a removed clause and
// also sits in a desktop admin-policy description, so the bundle held one more
// copy than the catalogue and the id read IN-BUNDLE on CC 2.1.295. A surplus of
// one window is weak evidence on its own; what a coincidence cannot do is keep
// matching the old prose past the window. So each occurrence is extended in both
// directions along the old line it came from, and it counts as a site only when
// the run reaches two windows (a phrase that common is not one clause of ours)
// or the whole old line, whichever is shorter. A genuine survivor keeps its line.
const siteRunMin = line => Math.min(line.length, 2 * WINDOW);

// The bundle stores the old line's characters in JS-literal source form: an em
// dash is `\u2014`, a middle dot `\xB7`, a quote inside a quoted string `\"`.
// Comparing raw source against the decoded line stops the run at the first such
// character, so a genuine survivor with an em dash in it read as a coincidence.
// Every encoding the bundle may use for `ch`: its escapes first, so a source
// backslash is read as the start of an escape, then the character itself.
const SIMPLE_ESCAPES = {
  '\n': ['\\n'],
  '\r': ['\\r'],
  '\t': ['\\t'],
  '"': ['\\"'],
  "'": ["\\'"],
  '`': ['\\`'],
  '\\': ['\\\\'],
  $: ['\\$'],
};
const encodingsCache = new Map();
const encodingsOf = ch => {
  let out = encodingsCache.get(ch);
  if (out) return out;
  const code = ch.charCodeAt(0);
  const hex4 = code.toString(16).padStart(4, '0');
  const hex2 = code.toString(16).padStart(2, '0');
  out = [...(SIMPLE_ESCAPES[ch] || [])];
  for (const h of new Set([hex4.toUpperCase(), hex4.toLowerCase()])) {
    out.push(`\\u${h}`);
  }
  out.push(
    `\\u{${code.toString(16)}}`,
    `\\u{${code.toString(16).toUpperCase()}}`
  );
  if (code < 0x100) {
    for (const h of new Set([hex2.toUpperCase(), hex2.toLowerCase()])) {
      out.push(`\\x${h}`);
    }
  }
  out = [...new Set(out), ch];
  encodingsCache.set(ch, out);
  return out;
};

// How many old-line characters, starting at `off`, the haystack continues from
// `at` (forward) or ends with before `at` (backward), escape-aware.
const walkForward = (hay, at, line, off) => {
  let n = 0;
  let j = at;
  while (off + n < line.length && j < hay.length) {
    const enc = encodingsOf(line[off + n]).find(e => hay.startsWith(e, j));
    if (enc === undefined) break;
    j += enc.length;
    n++;
  }
  return { n, j };
};
const extendForward = (hay, at, line, off) => walkForward(hay, at, line, off).n;
// Walking backward, an escape ending at `j` is real only when the backslash
// that opens it is not itself escaped (an even run of backslashes before it).
const escapeOpensAt = (hay, i) => {
  let k = i;
  while (k > 0 && hay[k - 1] === '\\') k--;
  return (i - k) % 2 === 0;
};
const extendBackward = (hay, at, line, off) => {
  let n = 0;
  let j = at;
  while (off - n > 0 && j > 0) {
    const enc = encodingsOf(line[off - n - 1]).find(
      e =>
        e.length <= j &&
        hay.startsWith(e, j - e.length) &&
        (e.length === 1 || escapeOpensAt(hay, j - e.length))
    );
    if (enc === undefined) break;
    j -= enc.length;
    n++;
  }
  return n;
};

const runAround = (hay, at, line, off) =>
  extendBackward(hay, at, line, off) +
  WINDOW +
  extendForward(hay, at + WINDOW, line, off + WINDOW);

// Occurrences of `u` in `hay` that continue some old line that holds it.
const siteOffsets = (hay, u, lines) => {
  const contexts = [];
  for (const line of lines) {
    for (let o = line.indexOf(u); o >= 0; o = line.indexOf(u, o + 1)) {
      contexts.push({ line, off: o });
    }
  }
  const out = [];
  for (let i = hay.indexOf(u); i >= 0; i = hay.indexOf(u, i + 1)) {
    if (
      contexts.some(
        ({ line, off }) => runAround(hay, i, line, off) >= siteRunMin(line)
      )
    ) {
      out.push(i);
    }
  }
  return out;
};
const countSites = (hay, u, lines) => siteOffsets(hay, u, lines).length;

// Distinctive units the bundle holds more often than the catalogue and the
// classify sidecar together. Each catalogue entry is one bundle site, so a
// surplus is a site carrying the old text that nothing catalogues. Only
// single-line ASCII units are countable in the bundle (see the header).
const strayUnits = (probes, lines) =>
  probes.filter(
    u =>
      isAscii(u) &&
      countSites(cli, u, lines) >
        namedSites(u, lines) + countSites(sidecarBlob, u, lines)
  );

const share = (units, haystack) =>
  units.filter(u => haystack.includes(u)).length / units.length;

// `share(windows, curBlob)` was the gate's hot spot (174 s of 259 s on CC
// 2.1.312): every 25-char window scanned the whole 10 MB catalogue blob. Every
// window of every blob position is precomputed once instead, so the test is a
// set lookup. Exact for fixed-length windows: a window is in the blob iff it is
// one of the blob's own WINDOW-length substrings.
const windowSet = blob => {
  const set = new Set();
  for (let i = 0; i + WINDOW <= blob.length; i++)
    set.add(blob.slice(i, i + WINDOW));
  return set;
};
let curWindows = null;
let curSidecarWindows = null;
// strayProbes only emits WINDOW-length windows.
const shareWindows = (windows, set) =>
  windows.filter(w => set().has(w)).length / windows.length;
const curWindowSet = () => (curWindows ??= windowSet(curBlob));
const curSidecarWindowSet = () =>
  (curSidecarWindows ??= windowSet(`${curBlob}\n${sidecarBlob}`));

const classify = id => {
  const entries = prevById.get(id) || [];
  const units = [...new Set(entries.flatMap(shareUnits))];
  // The closest current id, reported as an advisory when the old id does not
  // clear the bar, so a reword is reviewed against it rather than archived blind.
  const best = units.length ? bestSuccessor(units) : { id: null, share: 0 };
  const near = best.share > 0 ? best : null;
  const windows = [...new Set(entries.flatMap(strayProbes))];
  if (units.length) {
    const to = best.share >= RENAME_SHARE ? best.id : null;
    // A prompt Anthropic split keeps its long runs intact in each half, so the
    // union test uses 25-char windows: union coverage by trigrams is satisfied
    // by any short body of common phrasing ("which is not", "is not what").
    const split =
      !to &&
      windows.length > 0 &&
      shareWindows(windows, curWindowSet) >= RENAME_SHARE;
    const pending =
      !to &&
      !split &&
      (share(units, sidecarBlob) >= RENAME_SHARE ||
        (windows.length > 0 &&
          shareWindows(windows, curSidecarWindowSet) >= RENAME_SHARE));
    if (to || split || pending) {
      const stray = strayUnits(windows, entries.flatMap(proseLines));
      if (stray.length) return { bucket: 'IN-BUNDLE', to, stray, near };
      if (pending) return { bucket: 'in-sidecar' };
      return { bucket: 'in-catalogue', to, share: best.share, split };
    }
  }
  const probes = entries.flatMap(midBodyProbes);
  if (probes.length) {
    // A run that named ids hold as often as the bundle does is text existing
    // ids carry (a body spread over several successors, none of which clears
    // RENAME_SHARE). Plain counts, not strayUnits: its context-site test drops
    // a short line whose surroundings changed, and anonymous captures and the
    // sidecar are pending classification, not coverage.
    // Every live run of the body, not only the probes: the probes skip its
    // head and tail. A fragment id nested in a composite parent's body is the
    // same bundle site, so only the outermost bodies holding a run count.
    const runs = [
      ...new Set([
        ...probes,
        ...entries.flatMap(proseLines).flatMap(asciiRunsOnLine),
      ]),
    ];
    const live = runs.filter(r => cli.includes(r));
    const uncovered = live.filter(r => countOf(cli, r) > namedSites(r));
    return { bucket: uncovered.length ? 'IN-BUNDLE' : 'gone', near };
  }
  for (const p of entries) {
    for (const run of literalRuns(p)) {
      for (let off = 0; off + WINDOW <= run.length; off += STRIDE) {
        const w = run.slice(off, off + WINDOW);
        if (!isAscii(w)) continue;
        // A window a named id already holds at every bundle site is that id's
        // text, not this one surviving (2.1.305: a reworded fence error shared
        // one window with the catalogued verify-inconclusive message).
        if (countOf(cli, w) > namedSites(w))
          return { bucket: 'IN-BUNDLE', near };
      }
    }
  }
  // Nothing above had a run to probe with. Fall back to the short pieces before
  // concluding a removal, and when even those are unusable say so instead of
  // recommending an archive the gate never actually tested.
  const shorts = entries.flatMap(shortRuns);
  if (allPresent(shorts, curBlob)) {
    return { bucket: 'in-catalogue', to: successorOfAll(shorts) };
  }
  if (allPresent(shorts, sidecarBlob)) return { bucket: 'in-sidecar' };
  if (allPresent(shorts, cli)) return { bucket: 'IN-BUNDLE' };
  if (!shorts.length) return { bucket: 'no-probe-surface' };
  return { bucket: 'gone' };
};

const buckets = {
  'in-catalogue': [],
  'in-sidecar': [],
  'IN-BUNDLE': [],
  'no-probe-surface': [],
  gone: [],
};
const renamedTo = {};
const split = [];
const strayOf = {};
const shareOf = {};
const nearOf = {};
for (const id of [...prevById.keys()].filter(i => !curIds.has(i)).sort()) {
  const r = classify(id);
  buckets[r.bucket].push(id);
  if (r.bucket === 'in-catalogue' && r.to) {
    renamedTo[id] = r.to;
    shareOf[id] = r.share ?? 1;
  }
  if (r.bucket === 'in-catalogue' && r.split) split.push(id);
  if (r.stray) strayOf[id] = r;
  if (r.near && (r.bucket === 'IN-BUNDLE' || r.bucket === 'gone'))
    nearOf[id] = r.near;
}
const nearNote = id =>
  nearOf[id]
    ? `  (closest current id: ${nearOf[id].id}, ${nearOf[id].share.toFixed(2)} of its prose — review before archiving)`
    : '';
// A catalogue correction that rules a shipped id NOT model-facing leaves its
// text in the bundle, so it reads as IN-BUNDLE forever. The resolution is the
// classify verdict itself: an `archived` row naming the `facing` it was ruled
// and the cache `hash` it was recorded under settles the id only while the
// classification cache still holds that verdict. A row whose verdict was later
// flipped back to model, or never merged, keeps failing.
const CLASSIFICATION_CACHE =
  process.env.TWEAKCC_CLASSIFICATION_CACHE ||
  path.join(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    'data',
    'prompt-classification.json'
  );
const classificationCache = fs.existsSync(CLASSIFICATION_CACHE)
  ? JSON.parse(fs.readFileSync(CLASSIFICATION_CACHE, 'utf8'))
  : {};
const NON_MODEL = new Set(['ui', 'internal']);
const reclassifiedProblem = id => {
  const row = allowlist[id];
  if (row?.verdict !== 'archived' || !NON_MODEL.has(row.facing)) return null;
  if (!/^[0-9a-f]{40}$/.test(row.hash || '')) return 'no 40-hex cache hash';
  const cached = classificationCache[row.hash]?.facing;
  if (cached !== row.facing) {
    return `cache holds ${cached ?? 'no verdict'} for ${row.hash.slice(0, 10)}, row says ${row.facing}`;
  }
  return '';
};
const reclassified = [];
const reclassifiedMismatch = [];
buckets['IN-BUNDLE'] = buckets['IN-BUNDLE'].filter(id => {
  const problem = reclassifiedProblem(id);
  if (problem === '') {
    reclassified.push(id);
    return false;
  }
  if (problem) reclassifiedMismatch.push(`${id}: ${problem}`);
  return true;
});

// A no-probe id can only be settled by reading its emission site by hand, so an
// `archived` verdict recorded after that read is the resolution. Without this
// the gate had no way to record one and failed every run after the review.
const probeResolved = buckets['no-probe-surface'].filter(
  id => allowlist[id]?.verdict === 'archived'
);
buckets['no-probe-surface'] = buckets['no-probe-surface'].filter(
  id => allowlist[id]?.verdict !== 'archived'
);
// The rename map is what an operator has to act on — an override keyed by the
// old id has to be re-mapped by CONTENT to the successor, and every set that
// has the file has to move with it.
if (Object.keys(renamedTo).length) {
  console.log('\nrenamed (share of the old prose the successor carries):');
  for (const [id, to] of Object.entries(renamedTo)) {
    console.log(`  ${id} -> ${to} (${shareOf[id].toFixed(2)})`);
  }
}
if (split.length) {
  console.log(
    `\nsplit across several current ids (no single successor carries ${RENAME_SHARE * 100}% of the text):`
  );
  for (const id of split) console.log(`  ${id}`);
}
if (buckets['in-catalogue'].length) {
  fs.writeFileSync(RENAME_MAP, `${JSON.stringify(renamedTo, null, 2)}\n`);
}

// `no-probe-surface` needs a decision too: the gate could not test it, and
// leaving it out of this count is what makes an untested id read as settled.
// An archived `gone` id is decided, so it leaves the count; it stays in the
// "truly removed" total.
const removed =
  buckets['IN-BUNDLE'].length +
  buckets.gone.filter(id => allowlist[id]?.verdict !== 'archived').length +
  buckets['no-probe-surface'].length;
console.log(
  `removed-id coverage: ${prevById.size - curIds.size >= 0 ? '' : ''}` +
    `${buckets['in-catalogue'].length} renamed/reshuffled, ` +
    `${buckets['in-sidecar'].length} pending classify, ` +
    `${buckets['IN-BUNDLE'].length} STILL IN BUNDLE, ` +
    `${reclassified.length} ruled non-model, ` +
    `${buckets['no-probe-surface'].length} no probe surface, ` +
    `${buckets.gone.length} truly removed (${removed} need a decision)`
);

if (probeResolved.length) {
  console.log(
    `\nno probe surface, resolved by hand (archived): ${probeResolved.join(', ')}`
  );
}
if (buckets['no-probe-surface'].length) {
  console.log(
    '\nNO PROBE SURFACE — too few literal characters to test either way:'
  );
  for (const id of buckets['no-probe-surface']) console.log(`  ${id}`);
  console.log(
    '\nThe gate could not run on these. Resolve each by hand at the emission\n' +
      'site before archiving anything — a slot-only prompt reads as removed by\n' +
      'default, and archiving one retires an override that is still live.'
  );
}

if (updateAllowlist) {
  for (const id of [...buckets['IN-BUNDLE'], ...buckets.gone]) {
    if (!allowlist[id]) {
      allowlist[id] = { verdict: 'REVIEW', bucket: classify(id), why: '' };
    }
  }
  fs.writeFileSync(ALLOWLIST, `${JSON.stringify(allowlist, null, 2)}\n`);
  console.log(`wrote ${ALLOWLIST} — set each verdict to archived | recovered`);
}

// A recorded verdict silences `gone` only. An IN-BUNDLE finding keeps failing
// until the text is actually catalogued again, exactly like a `model` verdict
// in the detection-coverage allowlist: the whole point of the gate is that the
// prompt is still reaching the model with no id, and writing that down in a
// file does not change it. The one exception is above: text the classification
// cache rules non-model is not reaching the model, and the row must name that
// verdict exactly.
const unreviewedGone = buckets.gone.filter(
  id => allowlist[id]?.verdict !== 'archived'
);

if (reclassifiedMismatch.length) {
  console.log('\nARCHIVED AS NON-MODEL BUT THE CACHE DISAGREES:');
  for (const line of reclassifiedMismatch) console.log(`  ${line}`);
}
if (buckets['IN-BUNDLE'].length) {
  console.log('\nSTILL IN BUNDLE — model-facing text that lost its id:');
  for (const id of buckets['IN-BUNDLE']) {
    const r = strayOf[id];
    if (!r) {
      console.log(`  ${id}${nearNote(id)}`);
      continue;
    }
    console.log(
      `  ${id}  (text also at a site ${r.to ? `${r.to} does not cover` : 'no current id covers'}: "${r.stray[0]}")`
    );
  }
  console.log(
    '\nRead the emission site. If the prompt survived a refactor, record a\n' +
      'classification-cache "model" verdict REUSING this id (probe the exact key\n' +
      'with TWEAKCC_DUMP_CANDIDATES — do not guess it), then re-extract.'
  );
}
if (unreviewedGone.length) {
  console.log('\ntruly removed, no recorded verdict:');
  for (const id of unreviewedGone) console.log(`  ${id}${nearNote(id)}`);
  console.log(
    '\nArchive each override to ~/.tweakcc/orphans-removed-for-<ver>/ and record\n' +
      '{"verdict":"archived"} in data/removed-id-allowlist.json.'
  );
}

if (buckets['IN-BUNDLE'].length) {
  console.log('\nremoved-id coverage: FAIL');
  process.exit(1);
}
console.log(
  `\nremoved-id coverage: PASS (${unreviewedGone.length} removal(s) awaiting archival)`
);
