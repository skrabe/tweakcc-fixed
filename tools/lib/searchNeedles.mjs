// String literals the bundle SEARCHES text for, as opposed to text it emits.
//
// A needle is a literal handed to a string matcher (`.indexOf`, `.startsWith`,
// `.split`, `.replace`, …) or compared with `===`, either inline or through a
// const. The const case is the one the older detectors missed: CC 2.1.281
// hoists `". If you have other tasks"` into `var J4o=` and cuts the auto-mode
// denial reason out of a tool_result with `n.indexOf(J4o)`, so no matcher call
// ever carries the text itself.
//
// Minified names repeat across the ~2,000 modules of a code-split bundle (`Gle`
// is that module's denial prefix and another module's React component), so a
// const resolves only against a single assignment in the module that uses it,
// or in the module it imports the name from. A name assigned twice resolves to
// nothing: a bundle-wide `o=` is not evidence.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { splitModuleBundle } = require('./moduleBundle.cjs');

export const MATCHERS = [
  'indexOf',
  'lastIndexOf',
  'includes',
  'startsWith',
  'endsWith',
  'split',
  'replace',
  'replaceAll',
];

const STR =
  '"(?:[^"\\\\\\n]|\\\\[\\s\\S])*"|\'(?:[^\'\\\\\\n]|\\\\[\\s\\S])*\'|`(?:[^`\\\\$]|\\\\[\\s\\S]|\\$(?!\\{))*`';
const IDENT = '[$A-Za-z_][$\\w]*';

// First argument only, and only when it IS the literal or the identifier —
// `"a"+x` or `X.slice(1)` searches for something else.
const CALL_RE = new RegExp(
  `\\.(${MATCHERS.join('|')})\\(\\s*(?:(${STR})|(${IDENT}))\\s*(?=[,)])`,
  'g'
);
const EQ_RIGHT_RE = new RegExp(
  `[!=]==\\s*(?:(${STR})|(${IDENT}))(?![$\\w.(\\[])`,
  'g'
);
const EQ_LEFT_RE = new RegExp(
  `(?<![$\\w.])(?:(${STR})|(${IDENT}))\\s*[!=]==(?!=)`,
  'g'
);
const LITERAL_ASSIGN_RE = new RegExp(
  `(?<![$\\w.])(${IDENT})=(${STR})(?=[,;)}\\n])`,
  'g'
);
const ANY_ASSIGN_RE = new RegExp(
  `(?<![$\\w.])(${IDENT})\\s*(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[-+*/%&|^])?=(?![=>])|(?<![$\\w.])(${IDENT})(?:\\+\\+|--)|(?:\\+\\+|--)(${IDENT})`,
  'g'
);
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g;

const SIMPLE_ESC = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  0: '\0',
};

// The runtime value of a JS string or template-literal source token.
export const decodeJsString = tok => {
  const body = tok.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[++i];
    if (n in SIMPLE_ESC && !(n === '0' && /[0-9]/.test(body[i + 1] || ''))) {
      out += SIMPLE_ESC[n];
    } else if (n === 'x') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (n === 'u' && body[i + 1] === '{') {
      const end = body.indexOf('}', i);
      out += String.fromCodePoint(parseInt(body.slice(i + 2, end), 16));
      i = end;
    } else if (n === 'u') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (n === '\r' || n === '\n' || n === '\u2028' || n === '\u2029') {
      if (n === '\r' && body[i + 1] === '\n') i++;
    } else {
      out += n;
    }
  }
  return out;
};

// Pure punctuation, a lone word, or an identifier-like key (`tool_result`,
// `sandbox.filesystem`, `text/plain`) is structure, not prose an override could
// carry: a needle needs two letter runs with whitespace between them.
export const isProseNeedle = s => {
  if (s.length < 8) return false;
  if ((s.match(/[A-Za-z]{2,}/g) || []).length < 2) return false;
  return /\s/.test(s.trim());
};

export const segmentsOf = src => {
  const split = splitModuleBundle(src);
  return split || [{ name: '', start: 0, source: src }];
};

export const moduleAt = (segs, offset) => {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return segs[lo].name;
};

const moduleIndex = seg => {
  const counts = new Map();
  for (const m of seg.source.matchAll(ANY_ASSIGN_RE)) {
    const name = m[1] || m[2] || m[3];
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const literals = new Map();
  for (const m of seg.source.matchAll(LITERAL_ASSIGN_RE)) {
    if (counts.get(m[1]) === 1) literals.set(m[1], m[2]);
  }
  const imports = new Map();
  for (const m of seg.source.matchAll(IMPORT_RE)) {
    for (const spec of m[1].split(',')) {
      const parts = spec.trim().split(/\s+as\s+/);
      const local = (parts[1] || parts[0]).trim();
      if (local) imports.set(local, { from: m[2], name: parts[0].trim() });
    }
  }
  return { counts, literals, imports };
};

// Every search needle in the bundle, deduplicated by (needle, how).
// `site` is a short slice of the matching call for a human to read.
export const collectSearchNeedles = (
  src,
  { minLength = 8, segs = segmentsOf(src) } = {}
) => {
  const byName = new Map(segs.map(s => [s.name, s]));
  const idx = new Map();
  const indexOf = seg => {
    if (!idx.has(seg)) idx.set(seg, moduleIndex(seg));
    return idx.get(seg);
  };
  const resolve = (seg, name) => {
    const own = indexOf(seg);
    const count = own.counts.get(name) || 0;
    if (count === 1) return own.literals.get(name) ?? null;
    if (count > 1) return null;
    const imp = own.imports.get(name);
    if (!imp) return null;
    const from = byName.get(imp.from);
    if (!from) return null;
    const theirs = indexOf(from);
    if ((theirs.counts.get(imp.name) || 0) !== 1) return null;
    return theirs.literals.get(imp.name) ?? null;
  };

  const out = new Map();
  const add = (seg, at, tok, name, how) => {
    if (tok && tok.startsWith('`') && tok.includes('${')) return;
    const raw = tok ?? resolve(seg, name);
    if (!raw) return;
    const needle = decodeJsString(raw);
    if (needle.length < minLength) return;
    const via = name ? `${name} -> ${how}` : `inline ${how}`;
    const key = `${needle}\u0000${via}`;
    if (out.has(key)) return;
    const abs = seg.start + at;
    out.set(key, {
      needle,
      how,
      via,
      module: seg.name,
      offset: abs,
      site: src.slice(Math.max(0, abs - 90), abs + 60),
    });
  };

  for (const seg of segs) {
    const s = seg.source;
    for (const m of s.matchAll(CALL_RE)) {
      add(seg, m.index, m[2], m[3], `.${m[1]}()`);
    }
    if (!s.includes('==')) continue;
    for (const m of s.matchAll(EQ_RIGHT_RE))
      add(seg, m.index, m[1], m[2], '===');
    for (const m of s.matchAll(EQ_LEFT_RE))
      add(seg, m.index, m[1], m[2], '===');
  }
  return [...out.values()];
};

// One row per distinct prose needle, carrying every way the bundle searches it.
export const proseNeedles = (src, segs = segmentsOf(src)) => {
  const rows = new Map();
  for (const r of collectSearchNeedles(src, { segs })) {
    if (!isProseNeedle(r.needle)) continue;
    if (!rows.has(r.needle)) rows.set(r.needle, { needle: r.needle, uses: [] });
    rows.get(r.needle).uses.push(r);
  }
  return [...rows.values()];
};

// Pieces are raw template-literal source; overrides are written the same way.
// The three escapes the patcher itself adds are always undone; a second form
// with every escape decoded catches `\uXXXX` text the pieces carry verbatim.
export const unescapeOverride = s => s.replace(/\\([`$\\])/g, '$1');

export const cookedForms = s => {
  const a = unescapeOverride(s);
  let b = a;
  try {
    b = decodeJsString('`' + s.replace(/`/g, '\\`') + '`');
  } catch {
    /* malformed escape: the plain form stands */
  }
  return a === b ? [a] : [a, b];
};

// The prose runs of a catalogued entry, with slot boundaries kept apart so a
// needle can never match across an interpolation.
export const proseOf = p => {
  const pieces = (p.pieces || []).filter(x => typeof x === 'string');
  const n = pieces.length;
  const hasSlots = (p.identifiers || []).length > 0;
  return pieces
    .map((x, i) => {
      let t = x;
      if (hasSlots && i > 0 && t.startsWith('}')) t = t.slice(1);
      if (hasSlots && i < n - 1 && t.endsWith('${')) t = t.slice(0, -2);
      return t;
    })
    .join('\u0000');
};

export const containsNeedle = (text, needle) =>
  cookedForms(text).some(f => f.includes(needle));

// Where a catalogued entry is emitted: the module holding its longest prose
// lines. Pieces are raw source, so each probe is tried as written, as a
// double-quoted string would spell it, and with non-ASCII as `\uXXXX`.
const uEsc = (w, upper) =>
  w.replace(/[\u0080-￿]/g, c => {
    const h = c.charCodeAt(0).toString(16).padStart(4, '0');
    return '\\u' + (upper ? h.toUpperCase() : h);
  });

export const probesOf = p => {
  const lines = proseOf(p)
    .split('\u0000')
    .flatMap(cookedForms)
    .flatMap(t => t.split('\n'))
    .map(t => t.trim())
    .filter(t => t.length >= 10)
    .sort((a, b) => b.length - a.length);
  const out = new Set();
  for (const line of lines.slice(0, 4)) {
    const w = line.slice(0, 48);
    for (const form of [w, JSON.stringify(w).slice(1, -1)]) {
      out.add(form);
      out.add(uEsc(form, false));
      out.add(uEsc(form, true));
    }
    out.add(w.replace(/`/g, '\\`'));
  }
  return [...out];
};

export const siteOffsets = (src, entries) => {
  const at = [];
  for (const p of entries) {
    for (const probe of probesOf(p)) {
      const before = at.length;
      for (let i = src.indexOf(probe); i !== -1; i = src.indexOf(probe, i + 1))
        at.push(i);
      if (at.length > before) break;
    }
  }
  return at;
};

// Does the search, run against this prose, depend on where the needle sits?
// `startsWith` needs it to open a line or a slot-delimited run, `endsWith` to
// close one, `===` to be one; the rest match anywhere. A prompt that merely
// QUOTES a marker mid-sentence ("messages starting with [SYSTEM NOTIFICATION
// …]") is describing text the binary stamps elsewhere, not producing it.
export const placedFor = (how, forms, needle) => {
  const pieces = forms
    .flatMap(f => f.split('\u0000'))
    .flatMap(f => f.split('\n'));
  if (how === '.startsWith()')
    return pieces.some(t => t.trimStart().startsWith(needle.trimStart()));
  if (how === '.endsWith()')
    return pieces.some(t => t.trimEnd().endsWith(needle.trimEnd()));
  if (how === '===') return pieces.some(t => t.trim() === needle.trim());
  return forms.some(f => f.includes(needle));
};

// A reader and a writer of the same text are written together. Measured on CC
// 2.1.281, every search that reads text a prompt produced sits within 66 KB of
// that prompt's site (the denial-reason cut is 126 bytes from the builder, the
// insights-session detector 50-66 KB from the insights prompts), while generic
// phrases matched in the same 4 MB module ("timed out", "context window",
// "not support" in API-error classifiers) sit 105 KB to 3.2 MB away.
export const NEAR = 96 * 1024;

// Every (id, needle) where a catalogued entry's pristine prose carries a needle
// that a search NEAR the entry's own site looks for, placed where that search
// looks. Before the proximity rule the live set produced 48 findings, all but
// three of them a generic phrase ("write to", "not found", "git push") an
// unrelated module looks for in an error message or a shell command.
//
// A prompt whose whole text IS the needle is that const's own site: the
// override rewrites both sides at once and the search still holds. A prompt
// whose site cannot be located keeps every placed search, so an unlocatable
// site fails loud instead of hiding a finding.
export const needleCarriers = (
  src,
  prompts,
  { segs = segmentsOf(src), needles = proseNeedles(src, segs) } = {}
) => {
  const byId = new Map();
  for (const p of prompts) {
    if (!p.id) continue;
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id).push(p);
  }
  const rows = [];
  const crossModule = [];
  for (const [id, entries] of byId) {
    const proses = entries.map(proseOf);
    const forms = proses.flatMap(cookedForms);
    let sites = null;
    for (const n of needles) {
      if (!forms.some(t => t.includes(n.needle))) continue;
      if (proses.every(t => unescapeOverride(t).trim() === n.needle.trim()))
        continue;
      const placed = n.uses.filter(u => placedFor(u.how, forms, n.needle));
      if (!placed.length) continue;
      sites ??= siteOffsets(src, entries).map(o => ({
        o,
        module: moduleAt(segs, o),
      }));
      const local = sites.length
        ? placed.filter(u =>
            sites.some(
              x => x.module === u.module && Math.abs(x.o - u.offset) <= NEAR
            )
          )
        : placed;
      if (local.length) rows.push({ id, needle: n.needle, uses: local });
      else crossModule.push({ id, needle: n.needle, uses: placed });
    }
  }
  return { rows, crossModule };
};
