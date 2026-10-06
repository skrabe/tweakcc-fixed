// The corpus a stage-1 audit searches, built once and shared by the packet
// builder, the batched search tool and the verdict checker.
//
// Stage 1 on CC 2.1.288 spent 19% of the run's tokens: 32 agents each ran ~21
// separate corpus greps, and every grep re-read a growing context. The search
// itself is cheap; the turns around it are not. So the corpus is indexed once
// per corpus digest and an agent asks for every claim of every id in one call.
//
// What the corpus is — the same four surfaces the stage-1 prompt names:
//   - every override in the ACTIVE set, as DEPLOYED (frontmatter stripped,
//     template escapes undone; an empty body is a suppression and covers
//     nothing);
//   - the inline-*.md blobs in that set;
//   - the system-reminders bodies;
//   - catalogue pristine for every catalogued id with no override file, since
//     that is what renders for it.
//
// Co-render information is a HINT and is labelled unproven everywhere it
// appears. Two strings in one function do not prove they render together:
// ternary arms are mutually exclusive, and a value computed beside the target
// can still be dropped before it reaches the model. The relation below is
// computed from syntax only, so the agent must still prove "whenever the
// target renders, the carrier renders".

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import v8 from 'node:v8';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const matter = require('gray-matter');

export const INDEX_FORMAT = 7;
export const MODEL_DEFAULT = 'MODEL_DEFAULT';
export const REMINDER_PREFIX = 'system-reminders/';
export const CORENDER_NOTE =
  'coRender is an UNPROVEN syntactic hint. Coverage needs proof that whenever the target renders, the carrier renders too: ternary/if arms are alternatives, a suppressed or shadowed carrier renders nothing, and a value computed beside the target can still be dropped. Exception, "same-tool": an ALWAYS-ON tool\'s own description and input schema render with every result of that tool, so that co-render is PROVABLE — confirm the carrier is that tool\'s description/schema (the id family match is a lead) and that the tool is in the turnProbe capture\'s tools[], and it is proven. A DEFERRED tool (absent from tools[]) reaches the model only through a ToolSearch result compaction can drop: its description is a conditional carrier and the same-tool exception does not hold for it, except between two pieces of its own tool object.';

// A tool's description and parameter schema are sent with every request that
// can carry that tool's result, so a tool-result text and its own tool's
// description/schema co-render by construction. Matched on the id family,
// hyphen-insensitive ("send-message" = "sendmessagetool"): a lead the agent
// confirms, after which no further tracing is needed.
const TOOL_ID = /^tool-(result|description|parameter)-/;
const toolKeys = id => {
  const t = id.replace(TOOL_ID, '').split('-');
  const out = [];
  for (let i = 1; i <= Math.min(3, t.length); i++)
    out.push(t.slice(0, i).join('').replace(/tool$/, ''));
  return out;
};
// Two pieces of ONE tool's own description/schema (a description fragment and
// the tool's main description, or one of its parameters) render together
// whenever the tool is offered — the description-side twin of sameToolFamily.
export const sameToolSchema = (targetId, carrierId) => {
  if (!/^tool-(description|parameter)-/.test(targetId)) return null;
  if (!/^tool-(description|parameter)-/.test(carrierId)) return null;
  if (targetId === carrierId) return null;
  const a = toolKeys(targetId);
  const b = new Set(toolKeys(carrierId));
  return a[0] && a[0].length >= 4 && b.has(a[0]) ? a[0] : null;
};
export const sameToolFamily = (targetId, carrierId) => {
  if (!/^tool-result-/.test(targetId)) return null;
  if (!/^tool-(description|parameter)-/.test(carrierId)) return null;
  const b = new Set(toolKeys(carrierId));
  for (const k of toolKeys(targetId)) if (k.length >= 4 && b.has(k)) return k;
  return null;
};

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// Text helpers

export const unescapeDeployed = s => s.replace(/\\([`$\\])/g, '$1');

// Override files and catalogue pieces carry the same template-source escaping
// (a stub is the pieces verbatim), so equality is decided on BOTH sides
// un-escaped; comparing an un-escaped file to raw pieces calls every pristine
// stub with a \` an override.
export const samePristine = (pristine, deployed) =>
  unescapeDeployed(pristine).trim() === unescapeDeployed(deployed).trim();

// The canonical pristine reconstruction (src/systemPromptSync.ts
// reconstructContentFromPieces): the `${` and `}` are already in the pieces,
// so the BARE label is appended, keyed by identifiers[i].
export const reconstructPristine = entry => {
  const pieces = entry.pieces || [];
  const ids = entry.identifiers || [];
  const map = entry.identifierMap || {};
  if (!pieces.length) return entry.content || '';
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    out += typeof pieces[i] === 'string' ? pieces[i] : '';
    if (i < ids.length) {
      const k = String(ids[i]);
      out += map[k] || `UNKNOWN_${k}`;
    }
  }
  return out;
};

// gray-matter caches parses keyed by input; a corpus of ~10k files does not
// need that memory held after the build.
export const parseOverrideFile = text => {
  let parsed;
  try {
    parsed = matter(text, { delimiters: ['<!--', '-->'] });
  } catch {
    const m = text.match(/^<!--\n[\s\S]*?\n-->\n?/);
    parsed = { data: {}, content: m ? text.slice(m[0].length) : text };
    if (m) parsed.matter = m[0];
  }
  const raw = parsed.content ?? '';
  const body = raw.replace(/^\n+/, '').replace(/\s+$/, '');
  const fmEnd = text.length - raw.length;
  return {
    data: parsed.data || {},
    frontmatter: text.slice(0, fmEnd),
    body,
    suppressed: body.trim().length === 0,
  };
};

const STOP = new Set(
  (
    'a an and are as at be by for from has have if in into is it its of on or ' +
    'that the their then there these this to was were will with you your not ' +
    'do does can may should would when which what who how all any each only'
  ).split(' ')
);

// Placeholders are slot NAMES, not prose: `${TOOL_X_VAR_0}` would otherwise
// make every prompt look like its own siblings.
const stripSlots = s =>
  s.replace(/\$\{[^}]*\}/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ');

export const normalize = s =>
  ' ' +
  stripSlots(s)
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() +
  ' ';

export const tokens = s =>
  normalize(s)
    .split(' ')
    .filter(w => w.length > 1 && !STOP.has(w));

export const collapseWs = s => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Corpus loading

const listMd = dir =>
  dir && fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .sort()
    : [];

const statManifest = ({ catalogue, activeSet, remindersDir, bundle }) => {
  const rows = [];
  const add = p => {
    try {
      const st = fs.statSync(p);
      rows.push(`${p}\t${st.size}\t${st.mtimeMs}`);
    } catch {
      rows.push(`${p}\tmissing`);
    }
  };
  add(catalogue);
  if (bundle) add(bundle);
  for (const f of listMd(activeSet)) add(path.join(activeSet, f));
  for (const f of listMd(remindersDir)) add(path.join(remindersDir, f));
  return sha256(rows.join('\n'));
};

export const loadCorpus = ({ catalogue, activeSet, remindersDir }) => {
  const catText = fs.readFileSync(catalogue, 'utf8');
  const cat = JSON.parse(catText);
  const entriesById = new Map();
  for (const p of cat.prompts) {
    if (!p.id) continue;
    if (!entriesById.has(p.id)) entriesById.set(p.id, []);
    entriesById.get(p.id).push(p);
  }
  const digest = crypto.createHash('sha256');
  digest.update(`catalogue\0${sha256(catText)}\n`);

  const files = new Map();
  for (const f of listMd(activeSet)) {
    const p = path.join(activeSet, f);
    const text = fs.readFileSync(p, 'utf8');
    digest.update(`set\0${f}\0${sha256(text)}\n`);
    files.set(f.slice(0, -3), { path: p, ...parseOverrideFile(text) });
  }
  const shadowedBy = new Map();
  for (const [id, f] of files) {
    const sh = f.data.shadows;
    if (!Array.isArray(sh) || f.suppressed) continue;
    for (const s of sh) {
      if (!shadowedBy.has(s)) shadowedBy.set(s, []);
      shadowedBy.get(s).push(id);
    }
  }

  const docs = [];
  const push = d => {
    d.shadowedBy = shadowedBy.get(d.id) || [];
    docs.push(d);
  };
  for (const [id, entries] of entriesById) {
    // Corpus text is un-escaped throughout, pristine included, so a search or
    // quote check reads every document in the same form.
    const pristine = [
      ...new Set(entries.map(e => unescapeDeployed(reconstructPristine(e)))),
    ];
    const f = files.get(id);
    if (f) {
      const body = unescapeDeployed(f.body);
      push({
        id,
        kind: id.startsWith('inline-') ? 'inline' : 'prompt',
        source: 'override',
        path: f.path,
        body,
        suppressed: f.suppressed,
        matchesPristine: pristine.some(b => b.trim() === body.trim()),
        // What the audit judges is the pristine text; a target that is
        // already suppressed still needs its neighbours found from it.
        pristineBody: pristine.some(b => b.trim() === body.trim())
          ? null
          : pristine.join('\n\n'),
        ccVersion: f.data.ccVersion != null ? String(f.data.ccVersion) : null,
        description: entries[0].description || null,
      });
    } else {
      push({
        id,
        kind: 'prompt',
        source: 'pristine',
        path: null,
        body: pristine.join('\n\n'),
        suppressed: false,
        matchesPristine: true,
        ccVersion: null,
        description: entries[0].description || null,
      });
    }
  }
  for (const [id, f] of files) {
    if (entriesById.has(id)) continue;
    push({
      id,
      kind: id.startsWith('inline-') ? 'inline' : 'orphan',
      source: 'override',
      path: f.path,
      body: unescapeDeployed(f.body),
      suppressed: f.suppressed,
      matchesPristine: false,
      ccVersion: f.data.ccVersion != null ? String(f.data.ccVersion) : null,
      description:
        typeof f.data.description === 'string' ? f.data.description : null,
      inlineBlobAnchor:
        typeof f.data.inlineBlobAnchor === 'string'
          ? f.data.inlineBlobAnchor
          : null,
    });
  }
  for (const f of listMd(remindersDir)) {
    const p = path.join(remindersDir, f);
    const text = fs.readFileSync(p, 'utf8');
    digest.update(`reminder\0${f}\0${sha256(text)}\n`);
    const r = parseOverrideFile(text);
    push({
      id: REMINDER_PREFIX + f.slice(0, -3),
      kind: 'reminder',
      source: 'override',
      path: p,
      body: r.body,
      suppressed: r.suppressed,
      matchesPristine: false,
      ccVersion: r.data.ccVersion != null ? String(r.data.ccVersion) : null,
      description:
        typeof r.data.description === 'string' ? r.data.description : null,
    });
  }
  return {
    docs,
    entriesById,
    files,
    digest: digest.digest('hex'),
    version: cat.version,
  };
};

// ---------------------------------------------------------------------------
// Bundle sites: where each catalogued prompt sits, and the chain of functions
// and branches enclosing it. Located by a rolling hash over fixed 16-char
// anchors, then confirmed against the whole piece, so one pass over the 40 MB
// bundle covers all ~10k entries.

const ANCHOR = 16;

export const escapeVariants = piece => {
  const out = new Set([piece]);
  const dq = JSON.stringify(piece).slice(1, -1);
  out.add(dq);
  out.add(
    dq.replace(
      /[\u007f-￿]/g,
      c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
    )
  );
  out.add(
    piece.replace(
      /[\u007f-￿]/g,
      c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
    )
  );
  // Bun prints \u escapes with UPPERCASE hex ("\u201C"); JSON.stringify
  // and the variants above use lowercase.
  for (const v of [...out]) {
    const up = v.replace(
      /\\u([0-9a-f]{4})/g,
      (_, h) => `\\u${h.toUpperCase()}`
    );
    if (up !== v) out.add(up);
  }
  out.add(piece.replace(/\n/g, '\\n'));
  out.add(piece.replace(/'/g, "\\'").replace(/\n/g, '\\n'));
  return [...out];
};

export const probesForEntry = entry => {
  const pieces = (entry.pieces || []).filter(p => typeof p === 'string');
  return pieces
    .map(p => p.replace(/^\}/, '').replace(/\$\{$/, ''))
    .filter(p => p.length >= ANCHOR)
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
};

const hashStr = (s, from, len) => {
  let h = 0;
  for (let i = 0; i < len; i++)
    h = (Math.imul(h, 31) + s.charCodeAt(from + i)) | 0;
  return h;
};

export const locateSites = (src, probeLists) => {
  // probeLists: Array<Array<string>> (per key, ordered best-first)
  const table = new Map();
  const want = [];
  probeLists.forEach((probes, key) => {
    for (const probe of probes) {
      for (const v of escapeVariants(probe)) {
        if (v.length < ANCHOR) continue;
        const h = hashStr(v, 0, ANCHOR);
        const anchor = v.slice(0, ANCHOR);
        const rec = { key, v, anchor, probe };
        want.push(rec);
        if (!table.has(h)) table.set(h, []);
        table.get(h).push(rec);
      }
    }
  });
  const found = probeLists.map(() => new Map()); // key -> probe -> Set(offsets)
  let pow = 1;
  for (let i = 0; i < ANCHOR - 1; i++) pow = Math.imul(pow, 31);
  let h = src.length >= ANCHOR ? hashStr(src, 0, ANCHOR) : 0;
  for (let i = 0; i + ANCHOR <= src.length; i++) {
    if (i > 0) {
      h =
        (Math.imul(h - Math.imul(src.charCodeAt(i - 1), pow), 31) +
          src.charCodeAt(i + ANCHOR - 1)) |
        0;
    }
    const recs = table.get(h);
    if (!recs) continue;
    for (const r of recs) {
      if (!src.startsWith(r.v, i)) continue;
      const m = found[r.key];
      if (!m.has(r.probe)) m.set(r.probe, new Set());
      m.get(r.probe).add(i);
    }
  }
  return probeLists.map((probes, key) => {
    for (const probe of probes) {
      const s = found[key].get(probe);
      if (s && s.size) return [...s].sort((a, b) => a - b);
    }
    return [];
  });
};

const FN_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);
const BRANCH_TYPES = new Set([
  'IfStatement',
  'ConditionalExpression',
  'LogicalExpression',
  'SwitchStatement',
]);
const SKIP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'range',
  'type',
]);

// For every offset, the outer→inner chain of function and branch frames:
// [kind, start, end, key], key being which child of a branch node the offset
// sits under ('consequent', 'alternate', 'test', 'left', 'right', 'case:N').
export const frameOffsets = (src, offsets, splitModuleBundle, parser) => {
  const segs = splitModuleBundle(src) || [
    { name: '<bundle>', start: 0, source: src },
  ];
  const out = new Map();
  const sorted = [...new Set(offsets)].sort((a, b) => a - b);
  let si = 0;
  let parsed = 0;
  let failed = 0;
  for (const seg of segs) {
    const end = seg.start + seg.source.length;
    const mine = [];
    while (si < sorted.length && sorted[si] < seg.start) {
      out.set(sorted[si], { module: null, fn: null, frames: [] });
      si++;
    }
    while (si < sorted.length && sorted[si] < end) mine.push(sorted[si++]);
    if (!mine.length) continue;
    let ast;
    try {
      ast = parser.parse(seg.source, {
        sourceType: 'module',
        plugins: ['jsx'],
        errorRecovery: true,
      });
      parsed++;
    } catch {
      failed++;
      for (const o of mine)
        out.set(o, { module: seg.name, fn: null, frames: [], unparsed: true });
      continue;
    }
    const base = seg.start;
    const descend = (node, offs, frames) => {
      let kids = [];
      for (const key of Object.keys(node)) {
        if (SKIP_KEYS.has(key)) continue;
        const v = node[key];
        if (!v || typeof v !== 'object') continue;
        if (Array.isArray(v)) {
          v.forEach((c, idx) => {
            if (c && typeof c.start === 'number') kids.push([key, c, idx]);
          });
        } else if (typeof v.start === 'number') kids.push([key, v, -1]);
      }
      const rest = new Set(offs);
      for (const [key, child, idx] of kids) {
        const inside = offs.filter(o => o >= child.start && o < child.end);
        if (!inside.length) continue;
        for (const o of inside) rest.delete(o);
        let next = frames;
        if (FN_TYPES.has(child.type)) {
          next = [...frames, ['fn', child.start + base, child.end + base, '']];
        }
        if (BRANCH_TYPES.has(node.type)) {
          const k =
            node.type === 'SwitchStatement'
              ? key === 'cases'
                ? `case:${idx}`
                : key
              : node.type === 'LogicalExpression'
                ? `${key}:${node.operator}`
                : key;
          next = [
            ...next.slice(0, frames.length),
            [node.type, node.start + base, node.end + base, k],
            ...next.slice(frames.length),
          ];
        }
        descend(child, inside, next);
      }
      for (const o of rest) {
        const fnFrame = [...frames].reverse().find(f => f[0] === 'fn') || null;
        out.set(o + base, {
          module: seg.name,
          fn: fnFrame ? [fnFrame[1], fnFrame[2]] : null,
          frames,
        });
      }
    };
    descend(
      ast.program,
      mine.map(o => o - base),
      []
    );
  }
  for (; si < sorted.length; si++)
    out.set(sorted[si], { module: null, fn: null, frames: [] });
  return { frames: out, parsed, failed };
};

// The syntactic relation of a carrier site to a target site. Labels, from the
// strongest hint to none:
//   same-branch          — same function, no branch separates them
//   carrier-outside-target-branch — same function; the target sits under a
//                          condition the carrier does not (the carrier's value
//                          exists whenever the target's does; whether it is
//                          EMITTED still needs proof)
//   carrier-conditional  — the carrier sits under a condition the target does not
//   exclusive-arms       — opposite arms of one if/ternary/switch: alternatives,
//                          never co-rendering
//   condition-relation   — one sits in the other's test or a && / || operand
//   nested-function      — one is inside a callback/closure of the other's function
//   different-function / different-module / unresolved
export const coRenderRelation = (target, carrier) => {
  if (!target || !carrier) return 'unresolved';
  if (!target.module || !carrier.module) return 'unresolved';
  if (target.module !== carrier.module) return 'different-module';
  const a = target.frames;
  const b = carrier.frames;
  let i = 0;
  while (i < a.length && i < b.length) {
    const fa = a[i];
    const fb = b[i];
    if (fa[0] !== fb[0] || fa[1] !== fb[1] || fa[2] !== fb[2]) break;
    if (fa[3] !== fb[3]) {
      const ka = fa[3].split(':')[0];
      const kb = fb[3].split(':')[0];
      if (
        fa[0] === 'LogicalExpression' ||
        ka === 'test' ||
        kb === 'test' ||
        ka === 'discriminant' ||
        kb === 'discriminant'
      ) {
        return 'condition-relation';
      }
      return 'exclusive-arms';
    }
    i++;
  }
  const restA = a.slice(i);
  const restB = b.slice(i);
  const sharedFn = a.slice(0, i).some(f => f[0] === 'fn');
  if (!sharedFn && !(target.fn === null && carrier.fn === null)) {
    return restA.some(f => f[0] === 'fn') && restB.some(f => f[0] === 'fn')
      ? 'different-function'
      : 'nested-function';
  }
  if (restA.some(f => f[0] === 'fn') || restB.some(f => f[0] === 'fn'))
    return 'nested-function';
  if (
    target.fn === null &&
    carrier.fn === null &&
    !restA.length &&
    !restB.length
  )
    return 'module-scope';
  if (restB.length) return 'carrier-conditional';
  if (restA.length) return 'carrier-outside-target-branch';
  return 'same-branch';
};

export const RELATION_RANK = {
  'same-tool': -1,
  'same-branch': 0,
  'carrier-outside-target-branch': 1,
  'carrier-conditional': 2,
  'condition-relation': 3,
  'nested-function': 4,
  'module-scope': 5,
  'exclusive-arms': 6,
  'different-function': 7,
  'different-module': 8,
  unresolved: 9,
};

// ---------------------------------------------------------------------------
// The index

export const buildIndex = ({ catalogue, activeSet, remindersDir, bundle }) => {
  const t0 = Date.now();
  const corpus = loadCorpus({ catalogue, activeSet, remindersDir });
  let bundleSha = null;
  const sites = new Map(); // docIdx -> [siteInfo]
  let siteStats = null;
  if (bundle && fs.existsSync(bundle)) {
    const src = fs.readFileSync(bundle, 'utf8');
    bundleSha = sha256(src);
    const keys = [];
    const probeLists = [];
    corpus.docs.forEach((d, idx) => {
      if (d.kind === 'reminder') return;
      const entries = corpus.entriesById.get(d.id);
      if (entries) {
        entries.forEach(e => {
          const probes = probesForEntry(e);
          if (probes.length) {
            keys.push(idx);
            probeLists.push(probes);
          }
        });
      } else if (d.body && !d.suppressed) {
        const runs = stripSlots(d.body)
          .split('\n')
          .map(s => s.trim())
          .filter(s => s.length >= ANCHOR)
          .sort((x, y) => y.length - x.length)
          .slice(0, 2);
        if (runs.length) {
          keys.push(idx);
          probeLists.push(runs);
        }
      }
    });
    const located = locateSites(src, probeLists);
    const { splitModuleBundle } = require('./moduleBundle.cjs');
    const parser = require('@babel/parser');
    const all = located.flat();
    const { frames, parsed, failed } = frameOffsets(
      src,
      all,
      splitModuleBundle,
      parser
    );
    located.forEach((offs, k) => {
      const idx = keys[k];
      if (!sites.has(idx)) sites.set(idx, []);
      for (const o of offs)
        sites.get(idx).push({ offset: o, ...frames.get(o) });
    });
    for (const [idx, list] of sites) {
      const seen = new Set();
      sites.set(
        idx,
        list.filter(s =>
          seen.has(s.offset) ? false : (seen.add(s.offset), true)
        )
      );
    }
    siteStats = {
      probed: probeLists.length,
      located: located.filter(l => l.length).length,
      modulesParsed: parsed,
      modulesFailed: failed,
    };
  }
  const digest = sha256(
    `${corpus.digest}\n${bundleSha || 'no-bundle'}\n${INDEX_FORMAT}`
  );
  return {
    format: INDEX_FORMAT,
    digest,
    corpusDigest: corpus.digest,
    bundleSha,
    version: corpus.version,
    inputs: { catalogue, activeSet, remindersDir, bundle: bundle || null },
    statDigest: statManifest({ catalogue, activeSet, remindersDir, bundle }),
    docs: corpus.docs,
    sites: [...sites],
    siteStats,
    buildMs: Date.now() - t0,
  };
};

// Derived structures are rebuilt in memory on every open (fast) rather than
// serialized, so the cache holds only what is expensive to compute.
const hydrate = raw => {
  const docs = raw.docs;
  const byId = new Map(docs.map((d, i) => [d.id, i]));
  const sites = new Map(raw.sites);
  // A suppressed carrier is searched by its PRISTINE text and every hit on it
  // says suppressed: the agent must learn the text exists and covers nothing,
  // not conclude the claim is unique.
  const text = docs.map(d =>
    d.suppressed && d.pristineBody ? d.pristineBody : d.body
  );
  const norm = text.map(normalize);
  const df = new Map();
  const tf = text.map(t0 => {
    const m = new Map();
    for (const t of tokens(t0)) m.set(t, (m.get(t) || 0) + 1);
    for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);
    return m;
  });
  const N = docs.length;
  const idf = t => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
  const vec = tf.map(m => {
    let n = 0;
    const w = new Map();
    for (const [t, c] of m) {
      const x = (1 + Math.log(c)) * idf(t);
      w.set(t, x);
      n += x * x;
    }
    return { w, n: Math.sqrt(n) || 1 };
  });
  const postings = new Map();
  vec.forEach((v, i) => {
    for (const t of v.w.keys()) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push(i);
    }
  });
  const fnMembers = new Map();
  for (const [idx, list] of sites) {
    for (const st of list) {
      if (!st.fn) continue;
      const k = `${st.module}:${st.fn[0]}`;
      if (!fnMembers.has(k)) fnMembers.set(k, new Set());
      fnMembers.get(k).add(idx);
    }
  }
  return {
    ...raw,
    byId,
    sitesByIdx: sites,
    text,
    norm,
    vec,
    postings,
    idf,
    fnMembers,
  };
};

export const openIndex = ({
  catalogue,
  activeSet,
  remindersDir,
  bundle,
  cachePath,
  rebuild = false,
  log = () => {},
}) => {
  const inputs = { catalogue, activeSet, remindersDir, bundle };
  if (!rebuild && cachePath && fs.existsSync(cachePath)) {
    try {
      const raw = v8.deserialize(fs.readFileSync(cachePath));
      const sameInputs =
        raw.format === INDEX_FORMAT &&
        raw.inputs.catalogue === catalogue &&
        raw.inputs.activeSet === activeSet &&
        raw.inputs.remindersDir === remindersDir &&
        (raw.inputs.bundle || null) === (bundle || null);
      if (sameInputs && raw.statDigest === statManifest(inputs)) {
        return { index: hydrate(raw), cached: true };
      }
      if (sameInputs) {
        // stat changed: recompute the CONTENT digest before throwing away the
        // expensive bundle analysis (a touch or checkout changes mtimes only).
        const corpus = loadCorpus(inputs);
        const bundleSha =
          bundle && fs.existsSync(bundle)
            ? sha256(fs.readFileSync(bundle))
            : null;
        if (corpus.digest === raw.corpusDigest && bundleSha === raw.bundleSha) {
          raw.statDigest = statManifest(inputs);
          fs.writeFileSync(cachePath, v8.serialize(raw));
          return { index: hydrate(raw), cached: true };
        }
        log('corpus changed since the index was built — rebuilding');
      }
    } catch (e) {
      log(`index cache unreadable (${e.message}) — rebuilding`);
    }
  }
  const raw = buildIndex(inputs);
  if (cachePath) fs.writeFileSync(cachePath, v8.serialize(raw));
  return { index: hydrate(raw), cached: false };
};

// Digest of what is on disk NOW, for the freeze check in harvest.
export const currentCorpusDigest = inputs => loadCorpus(inputs).digest;

// ---------------------------------------------------------------------------
// Queries

const snippetAt = (body, at, len, pad = 90) => {
  const s = Math.max(0, at - pad);
  const e = Math.min(body.length, at + len + pad);
  return (s > 0 ? '…' : '') + body.slice(s, e) + (e < body.length ? '…' : '');
};

export const bestRelation = (index, targetId, carrierIdx) => {
  const ti = index.byId.get(targetId);
  if (ti === undefined) return null;
  const tool = sameToolFamily(targetId, index.docs[carrierIdx].id);
  if (tool)
    return { relation: 'same-tool', tool, proven: false, provable: true };
  const ts = index.sitesByIdx.get(ti) || [];
  const cs = index.sitesByIdx.get(carrierIdx) || [];
  if (!ts.length || !cs.length) {
    return {
      relation: 'unresolved',
      proven: false,
      reason: !ts.length
        ? 'target site not located in bundle'
        : 'carrier site not located in bundle',
    };
  }
  let best = null;
  for (const t of ts) {
    for (const c of cs) {
      const r = coRenderRelation(t, c);
      if (!best || RELATION_RANK[r] < RELATION_RANK[best.relation]) {
        best = {
          relation: r,
          targetOffset: t.offset,
          carrierOffset: c.offset,
          fn: c.fn && t.fn && c.fn[0] === t.fn[0] ? c.fn : null,
        };
      }
    }
  }
  return { ...best, proven: false, pairs: ts.length * cs.length };
};

// One compact hit. Flags appear only when set; `rel` is the UNPROVEN
// syntactic co-render relation to forId.
const hitFor = (index, idx, forId, at, len, opts = {}) => {
  const d = index.docs[idx];
  const h = { id: d.id };
  if (forId) h.rel = bestRelation(index, forId, idx).relation;
  if (d.kind !== 'prompt') h.kind = d.kind;
  if (d.source === 'pristine') h.pristine = true;
  if (d.suppressed) h.suppressed = true;
  if (d.shadowedBy.length) h.shadowedBy = d.shadowedBy;
  if (opts.score != null) h.score = Number(opts.score.toFixed(3));
  const t = index.text[idx];
  if (d.suppressed && t) h.snippetFrom = 'pristine (deployed body is empty)';
  h.snippet = at >= 0 ? snippetAt(t, at, len, 50) : t.slice(0, 120);
  return h;
};

// "<id> <relation>[ ~similarity][ (kind)][ PRISTINE][ SUPPRESSED][ shadowed-by X]"
export const hintLine = h =>
  [
    h.id,
    h.coRender ? h.coRender.relation : 'unresolved',
    h.similarity != null ? `~${h.similarity}` : null,
    h.kind && h.kind !== 'prompt' ? `(${h.kind})` : null,
    h.source === 'pristine' ? 'PRISTINE' : null,
    h.suppressed ? 'SUPPRESSED' : null,
    h.shadowedBy && h.shadowedBy.length
      ? `shadowed-by ${h.shadowedBy.join(',')}`
      : null,
  ]
    .filter(Boolean)
    .join(' ');

export const phraseSearch = (index, q, { forId = null, limit = 12 } = {}) => {
  const exact = [];
  const normalized = [];
  const nq = normalize(q);
  const qu = unescapeDeployed(q);
  let selfExact = false;
  let selfNorm = false;
  index.docs.forEach((d, i) => {
    const isSelf = d.id === forId;
    const at = index.text[i].indexOf(qu);
    if (at >= 0) {
      if (isSelf) selfExact = true;
      else exact.push([i, at]);
      return;
    }
    if (nq.trim() && index.norm[i].includes(nq)) {
      if (isSelf) selfNorm = true;
      else normalized.push([i, -1]);
    }
  });
  // Likely co-renderers first, so a capped list keeps the hits that matter.
  const relRank = i => {
    if (!forId) return 0;
    const r = bestRelation(index, forId, i);
    return r ? RELATION_RANK[r.relation] : 9;
  };
  const rank = arr =>
    arr
      .map(x => [...x, relRank(x[0])])
      .sort((x, y) => {
        const a = index.docs[x[0]];
        const b = index.docs[y[0]];
        return (
          x[2] - y[2] ||
          Number(a.suppressed) - Number(b.suppressed) ||
          a.id.localeCompare(b.id)
        );
      });
  const pack = arr => ({
    total: arr.length,
    truncated: arr.length > limit,
    hits: rank(arr)
      .slice(0, limit)
      .map(([i, at]) => {
        if (at < 0) {
          const words = nq.trim().split(' ');
          const first = words.find(w => w.length > 3) || words[0];
          at = index.text[i].toLowerCase().indexOf(first);
        }
        return hitFor(index, i, forId, at, q.length);
      }),
  });
  return {
    exact: pack(exact),
    normalized: pack(normalized),
    selfMatch: selfExact || selfNorm,
  };
};

// Bag-of-words search. Up to three terms must ALL occur; a longer list needs
// 60% of them, so a whole claim sentence still finds a reworded carrier.
export const termsSearch = (
  index,
  q,
  { forId = null, limit = 12, need = null } = {}
) => {
  const terms = [...new Set(Array.isArray(q) ? q.flatMap(tokens) : tokens(q))];
  if (!terms.length)
    return { terms, need: 0, total: 0, truncated: false, hits: [] };
  const min =
    need ?? (terms.length <= 3 ? terms.length : Math.ceil(terms.length * 0.6));
  const fi = forId != null ? index.byId.get(forId) : undefined;
  const count = new Map();
  for (const t of terms) {
    for (const i of index.postings.get(t) || [])
      count.set(i, (count.get(i) || 0) + 1);
  }
  const scored = [...count]
    .filter(([i, c]) => c >= min && i !== fi)
    .map(([i, c]) => {
      let s = 0;
      for (const t of terms) s += index.vec[i].w.get(t) || 0;
      return [i, s / index.vec[i].n, c];
    })
    .sort((a, b) => b[1] * b[2] - a[1] * a[2]);
  const byIdf = [...terms].sort((a, b) => index.idf(b) - index.idf(a));
  return {
    terms,
    need: min,
    total: scored.length,
    truncated: scored.length > limit,
    hits: scored.slice(0, limit).map(([i, sc, c]) => {
      const body = index.text[i].toLowerCase();
      const rare = byIdf.find(t => index.vec[i].w.has(t)) || byIdf[0];
      const h = hitFor(index, i, forId, body.indexOf(rare), rare.length, {
        score: sc,
      });
      h.matched = c;
      return h;
    }),
  };
};

// Nearest deployed bodies by tf-idf cosine. Content-keyed, so an inserted
// character shifts nothing. Leads only: similarity is never coverage.
export const neighbours = (
  index,
  id,
  { limit = 8, min = 0.12, body = null } = {}
) => {
  const self = index.byId.get(id);
  let qv;
  if (body != null) {
    const m = new Map();
    for (const t of tokens(body)) m.set(t, (m.get(t) || 0) + 1);
    let n = 0;
    const w = new Map();
    for (const [t, c] of m) {
      const x = (1 + Math.log(c)) * index.idf(t);
      w.set(t, x);
      n += x * x;
    }
    qv = { w, n: Math.sqrt(n) || 1 };
  } else if (self !== undefined && index.docs[self].pristineBody) {
    return neighbours(index, id, {
      limit,
      min,
      body: index.docs[self].pristineBody,
    });
  } else if (self !== undefined) qv = index.vec[self];
  else return [];
  const acc = new Map();
  for (const [t, x] of qv.w) {
    for (const i of index.postings.get(t) || []) {
      if (i === self) continue;
      acc.set(i, (acc.get(i) || 0) + x * index.vec[i].w.get(t));
    }
  }
  return [...acc]
    .map(([i, dot]) => [i, dot / (qv.n * index.vec[i].n)])
    .filter(([, s]) => s >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([i, s]) => {
      const d = index.docs[i];
      const h = {
        id: d.id,
        kind: d.kind,
        similarity: Number(s.toFixed(3)),
        suppressed: d.suppressed,
        source: d.source,
      };
      if (d.shadowedBy.length) h.shadowedBy = d.shadowedBy;
      h.coRender = bestRelation(index, id, i);
      return h;
    });
};

// Every catalogued text emitted from the same innermost function as one of
// the target's sites. A structural lead the text-similarity list cannot give:
// a short target ("Use jq to make structured queries") shares few words with
// the note that renders beside it.
export const emitterSiblings = (index, id, { limit = 30 } = {}) => {
  const self = index.byId.get(id);
  if (self === undefined) return { total: 0, truncated: false, siblings: [] };
  const members = new Set();
  for (const st of index.sitesByIdx.get(self) || []) {
    if (!st.fn) continue;
    for (const i of index.fnMembers.get(`${st.module}:${st.fn[0]}`) || []) {
      if (i !== self) members.add(i);
    }
  }
  const rows = [...members]
    .map(i => {
      const d = index.docs[i];
      const h = {
        id: d.id,
        kind: d.kind,
        suppressed: d.suppressed,
        source: d.source,
      };
      if (d.shadowedBy.length) h.shadowedBy = d.shadowedBy;
      h.coRender = bestRelation(index, id, i);
      return h;
    })
    .sort(
      (a, b) =>
        RELATION_RANK[a.coRender.relation] -
          RELATION_RANK[b.coRender.relation] || a.id.localeCompare(b.id)
    );
  return {
    total: rows.length,
    truncated: rows.length > limit,
    siblings: rows.slice(0, limit),
  };
};

export const sitesOf = (index, id) => {
  const i = index.byId.get(id);
  if (i === undefined) return [];
  return (index.sitesByIdx.get(i) || []).map(s => ({
    offset: s.offset,
    module: s.module,
    fn: s.fn,
    branches: s.frames.filter(f => f[0] !== 'fn').length,
  }));
};

// ---------------------------------------------------------------------------
// Carrier lookup for the verdict checker.

export const resolveCarrier = (index, carrierId) => {
  let i = index.byId.get(carrierId);
  if (i === undefined && carrierId.startsWith('system-reminders/')) {
    i = index.byId.get(carrierId.replace(/\.md$/, ''));
  }
  if (i === undefined && carrierId.endsWith('.md'))
    i = index.byId.get(carrierId.slice(0, -3));
  return i === undefined ? null : { idx: i, doc: index.docs[i] };
};

export const quoteIn = (body, quote) => {
  const q = unescapeDeployed(quote);
  if (body.includes(q) || body.includes(quote)) return 'exact';
  if (collapseWs(body).includes(collapseWs(q))) return 'whitespace';
  const nq = normalize(q);
  if (nq.trim() && normalize(body).includes(nq)) return 'normalized-only';
  return null;
};
