// The stage-1 audit packet as one markdown file an agent reads in ONE call.
//
// The 2.1.288 replay measured where a stage-1 agent's turns went: ~7 python
// snippets to page through the JSON packet, ~5 bundle loads to see the code
// around a site (the JSON only said "chunk-x.js@19277712"), a `cat` of the LCC
// CLAUDE.md, a `cat` of every carrier's deployed .md to quote it and check its
// ccVersion, and several more to parse the search output. Each turn re-read a
// context that grew from 43k to 112k. This file answers those up front:
//   - the LCC decision-rule sections, verbatim;
//   - per id: every pristine body, deployed state, previous-version change,
//     slots, externalRefs, the minified code around the first sites;
//   - the corpus-wide search for every claim sentence of every assigned body,
//     run once here with the same index and functions auditCorpusSearch uses;
//   - every carrier those searches, the emitter siblings and the neighbours
//     name, once per packet, as DEPLOYED text with its state and staleness.
// Nothing here is a verdict: co-render relations stay labelled unproven and
// the agent still rules on every body.

import { diffWordsWithSpace } from 'diff';
import {
  phraseSearch,
  termsSearch,
  normalize,
  tokens,
  unescapeDeployed,
  escapeVariants,
  probesForEntry,
  RELATION_RANK,
  bestRelation,
  sameToolFamily,
  CORENDER_NOTE,
} from './auditCorpus.mjs';

// ---------------------------------------------------------------------------
// LCC decision rule

import { TOOL_STATUS_NOTE } from './deferredTools.mjs';

export const LCC_RULES_FROM = '### The decision rule';
export const LCC_RULES_THROUGH = '### Test for every cut';

// From the "The decision rule" heading through the end of the "Test for every
// cut" section, located by heading text so an edit above it moves nothing.
export const extractLccRules = (text, file = 'CLAUDE.md') => {
  const lines = text.split('\n');
  let fence = false;
  const headings = [];
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    else if (!fence && /^#{1,6} /.test(l)) headings.push(i);
  });
  const start = headings.find(i => lines[i].startsWith(LCC_RULES_FROM));
  const last = headings.find(
    i => i > (start ?? -1) && lines[i].startsWith(LCC_RULES_THROUGH)
  );
  if (start === undefined || last === undefined) {
    throw new Error(
      `${file}: the LCC decision-rule sections ("${LCC_RULES_FROM}" … "${LCC_RULES_THROUGH}") were not found — ` +
        'the packet cannot carry the rules the audit applies; fix the headings or tools/lib/auditPacketMd.mjs'
    );
  }
  const end = headings.find(i => i > last && /^#{1,3} /.test(lines[i]));
  return lines
    .slice(start, end ?? lines.length)
    .join('\n')
    .trim();
};

// ---------------------------------------------------------------------------
// Claims and the precomputed search

const LETTERS = s => s.replace(/[^\p{L}]/gu, '').length;

// Every sentence of a body, split at slots too (a slot is not prose), list
// markers dropped so a carrier that words it as plain text still matches.
export const splitClaims = body => {
  const out = [];
  for (const seg of unescapeDeployed(body).split(/\$\{[^}]*\}|\{\{[^}]*\}\}/)) {
    for (const s of seg.split(/(?<=[.!?;:])\s+|\n+/)) {
      const c = s
        .trim()
        .replace(/^(?:[-*•>]|\d+[.)])\s+/, '')
        .trim();
      if (LETTERS(c) >= 10) out.push(c);
    }
  }
  return [...new Set(out)];
};

// A bag-of-words hit below this score that matched fewer than this share of
// the claim's terms is noise (measured on 2.1.288: real rewordings score > 1,
// unrelated prompts 0.2-0.6).
const TERMS_MIN_SCORE = 0.6;
const TERMS_MIN_SHARE = 0.8;

// The same phrase-then-terms search auditCorpusSearch runs in "auto" mode, for
// every claim of one id, aggregated per carrier.
export const precomputeSearch = (index, id, bodies) => {
  const forId = index.byId.has(id) ? id : null;
  const claims = [...new Set(bodies.flatMap(splitClaims))];
  const byCarrier = new Map();
  const touch = (hit, ci, how, score) => {
    const idx = index.byId.get(hit.id);
    if (idx === undefined) return;
    if (!byCarrier.has(hit.id)) {
      byCarrier.set(hit.id, {
        id: hit.id,
        idx,
        rel: hit.rel || 'unresolved',
        exact: new Set(),
        terms: new Map(),
      });
    }
    const c = byCarrier.get(hit.id);
    if (how === 'terms') c.terms.set(ci, Math.max(c.terms.get(ci) || 0, score));
    else c.exact.add(ci);
  };
  const hitCount = claims.map(() => 0);
  claims.forEach((q, ci) => {
    const p = phraseSearch(index, q, { forId, limit: 8 });
    for (const h of [...p.exact.hits, ...p.normalized.hits])
      touch(h, ci, 'phrase');
    hitCount[ci] = p.exact.total + p.normalized.total;
    if (hitCount[ci]) return;
    const t = termsSearch(index, q, { forId, limit: 4 });
    for (const h of t.hits) {
      if (
        h.score >= TERMS_MIN_SCORE ||
        h.matched / t.terms.length >= TERMS_MIN_SHARE
      ) {
        touch(h, ci, 'terms', h.score);
        hitCount[ci] += 1;
      }
    }
  });
  const carriers = [...byCarrier.values()].sort(
    (a, b) =>
      b.exact.size - a.exact.size ||
      RELATION_RANK[a.rel] - RELATION_RANK[b.rel] ||
      Math.max(0, ...b.terms.values()) - Math.max(0, ...a.terms.values()) ||
      a.id.localeCompare(b.id)
  );
  return {
    claims,
    unmatched: claims.map((_, i) => i).filter(i => !hitCount[i]),
    carriers,
  };
};

// ---------------------------------------------------------------------------
// Carrier excerpts

const sentenceSpans = text => {
  const spans = [];
  const re = /[^\n.!?]*(?:[.!?]+(?=\s|$)|\n|$)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      if (re.lastIndex >= text.length) break;
      re.lastIndex++;
      continue;
    }
    if (m[0].trim()) spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
};

// Indices of the carrier sentences a claim lands on: the exact occurrence when
// there is one, else the sentence sharing most of the claim's terms.
const sentencesFor = (text, spans, claim) => {
  const at = text.indexOf(claim);
  if (at >= 0) {
    const end = at + claim.length;
    return spans
      .map((s, i) => (s[0] < end && s[1] > at ? i : -1))
      .filter(i => i >= 0);
  }
  const want = new Set(tokens(claim));
  const nq = normalize(claim);
  let best = -1;
  let bestScore = 0;
  spans.forEach((s, i) => {
    const sent = text.slice(s[0], s[1]);
    if (nq.trim() && normalize(sent).includes(nq)) {
      if (bestScore < Infinity) {
        best = i;
        bestScore = Infinity;
      }
      return;
    }
    let n = 0;
    for (const t of new Set(tokens(sent))) if (want.has(t)) n++;
    if (n >= Math.min(2, want.size) && n > bestScore) {
      best = i;
      bestScore = n;
    }
  });
  return best >= 0 ? [best] : [];
};

export const FULL_BODY_MAX = 600;
const EXCERPT_CORE = 3;
const HEAD_MAX = 300;

// The carrier's deployed text: whole when short; otherwise the sentences the
// claims landed on, one sentence of context either side, gaps marked " … ".
export const carrierExcerpt = (text, claims) => {
  if (text.length <= FULL_BODY_MAX) return { text, full: true };
  const spans = sentenceSpans(text);
  const keep = new Set();
  const core = new Set();
  for (const c of claims) {
    if (core.size >= EXCERPT_CORE) break;
    for (const i of sentencesFor(text, spans, c)) {
      core.add(i);
      for (const k of [i - 1, i, i + 1])
        if (k >= 0 && k < spans.length) keep.add(k);
    }
  }
  if (!keep.size) {
    const cut = text.lastIndexOf(' ', HEAD_MAX);
    return {
      text: text.slice(0, cut > 200 ? cut : HEAD_MAX).trimEnd() + ' …',
      full: false,
    };
  }
  const idx = [...keep].sort((a, b) => a - b);
  let out = idx[0] > 0 ? '… ' : '';
  idx.forEach((k, j) => {
    const adjacent = j > 0 && k === idx[j - 1] + 1;
    if (adjacent) out += text.slice(spans[idx[j - 1]][1], spans[k][1]);
    else {
      if (j > 0) out = out.trimEnd() + ' … ';
      out += text.slice(spans[k][0], spans[k][1]).trimStart();
    }
  });
  if (idx[idx.length - 1] < spans.length - 1) out += ' …';
  return { text: out.trim(), full: false };
};

// ---------------------------------------------------------------------------
// Bundle code around a site

const KIND = {
  IfStatement: 'if',
  ConditionalExpression: '?:',
  LogicalExpression: 'logical',
  SwitchStatement: 'switch',
};
const SITE_BEFORE = 200;
const SITE_AFTER = 200;
const FN_HEAD = 100;
const LITERAL_SHOW = 120;

export const literalSpan = (src, offset, entries) => {
  for (const e of entries) {
    for (const probe of probesForEntry(e)) {
      for (const v of escapeVariants(probe)) {
        if (src.startsWith(v, offset)) return [offset, offset + v.length];
      }
    }
  }
  return [offset, offset + 16];
};

// "X=`…" or "X:'…" right before the literal: the binding (refs query) or the
// object property (prop query) the value travels through. A lead only.
export const bindingBefore = (src, offset) => {
  const before = src.slice(Math.max(0, offset - 60), offset);
  const m = before.match(
    /(?:^|[,;{(\s])(?:var |let |const )?([$\w]+)\s*([=:])\s*["'`]$/
  );
  return m ? { name: m[1], kind: m[2] === '=' ? 'binding' : 'property' } : null;
};

export const siteBlock = (src, site, entries) => {
  const [ls, le] = literalSpan(src, site.offset, entries);
  const from = Math.max(0, ls - SITE_BEFORE);
  const to = Math.min(src.length, le + SITE_AFTER);
  const lit = src.slice(ls, le);
  const shown =
    lit.length <= LITERAL_SHOW
      ? lit
      : `${lit.slice(0, 50)}⟪…${lit.length - 80} chars of this prompt…⟫${lit.slice(-30)}`;
  let code = '';
  if (site.fn && site.fn[0] < from) {
    code +=
      src.slice(site.fn[0], Math.min(site.fn[0] + FN_HEAD, from)) + ' …\n… ';
  } else if (from > 0) code += '… ';
  code += src.slice(from, ls) + shown + src.slice(le, to);
  if (to < src.length) code += ' …';
  const path = (site.frames || [])
    .filter(f => f[0] !== 'fn')
    .slice(-3)
    .map(f => `${KIND[f[0]] || f[0]}.${f[3]}`)
    .join(' › ');
  return {
    code: code.replace(/\r?\n/g, '\n'),
    path,
    binding: bindingBefore(src, ls),
    literalEnd: le,
  };
};

// ---------------------------------------------------------------------------
// Previous-version change

const DIFF_CONTEXT = 40;

export const compactDiff = (prev, cur) => {
  const parts = diffWordsWithSpace(prev, cur);
  let changed = 0;
  for (const p of parts) if (p.added || p.removed) changed += p.value.length;
  if (changed > 0.6 * Math.max(prev.length, cur.length)) return null;
  return parts
    .map((p, i) => {
      if (p.added) return `{+${p.value}+}`;
      if (p.removed) return `[-${p.value}-]`;
      const v = p.value;
      if (v.length <= 2 * DIFF_CONTEXT + 5) return v;
      const head = i > 0 ? v.slice(0, DIFF_CONTEXT) : '';
      const tail = i < parts.length - 1 ? v.slice(-DIFF_CONTEXT) : '';
      return `${head}…${tail}`;
    })
    .join('');
};

// ---------------------------------------------------------------------------
// Rendering helpers

export const fence = (text, lang = 'text') => {
  let f = '~~~';
  while (text.includes(f)) f += '~';
  return `${f}${lang}\n${text}\n${f}`;
};

export const WRAP_AT = 1600;

// The Read tool shortens very long lines; break them at a space. Quotes are
// checked ignoring whitespace, so a wrapped line still quotes verbatim.
export const wrapLong = (text, max = WRAP_AT) =>
  text
    .split('\n')
    .flatMap(line => {
      const out = [];
      let rest = line;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut < max / 2) cut = max;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^ /, '');
      }
      out.push(rest);
      return out;
    })
    .join('\n');

export const cmpVersion = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

const short = (s, n = 70) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

// ---------------------------------------------------------------------------
// Per-id model

const PLAUSIBLE = new Set([
  'same-tool',
  'same-branch',
  'carrier-outside-target-branch',
  'carrier-conditional',
  'condition-relation',
]);
export const CARRIERS_PER_ID = 6;
const TOOL_LEADS = 4;
const TOOL_BODY = 0.15;
const TOOL_BODIES = 2;
const STRONG_TERMS = 0.9;
const NEIGHBOUR_BODY = 0.45;
export const SITES_WITH_CODE = 2;

// Everything the md renders for one id, computed once so grouping can re-render
// cheaply. `prompt` is the JSON packet entry buildAuditPacket wrote.
export const mdModel = ({
  index,
  src,
  prompt,
  entries,
  toolStatus = () => null,
}) => {
  const self = index ? index.byId.get(prompt.id) : undefined;
  const search = index
    ? precomputeSearch(index, prompt.id, prompt.pristineBodies)
    : { claims: [], unmatched: [], carriers: [] };
  const shownCarriers = search.carriers.slice(0, CARRIERS_PER_ID);
  const rawSites =
    index && self !== undefined ? index.sitesByIdx.get(self) || [] : [];
  const fnSeen = new Set();
  const sites = rawSites.map(st => {
    const key = st.fn
      ? `${st.module}:${st.fn[0]}`
      : `${st.module}:@${st.offset}`;
    const withCode = src && fnSeen.size < SITES_WITH_CODE && !fnSeen.has(key);
    if (withCode) fnSeen.add(key);
    return {
      offset: st.offset,
      module: st.module,
      fn: st.fn,
      branches: st.frames.filter(f => f[0] !== 'fn').length,
      ...(withCode ? siteBlock(src, st, entries) : {}),
    };
  });
  const leads = { siblings: [], siblingsMore: 0, neighbours: [] };
  if (index) {
    const sib = [];
    const self2 = prompt.id;
    const seenSib = new Set();
    for (const st of rawSites) {
      if (!st.fn) continue;
      for (const i of index.fnMembers.get(`${st.module}:${st.fn[0]}`) || []) {
        if (i === self || seenSib.has(i)) continue;
        seenSib.add(i);
        const rel = bestRelation(index, self2, i);
        sib.push({
          id: index.docs[i].id,
          rel: rel ? rel.relation : 'unresolved',
        });
      }
    }
    sib.sort(
      (a, b) =>
        RELATION_RANK[a.rel] - RELATION_RANK[b.rel] || a.id.localeCompare(b.id)
    );
    leads.siblings = sib.filter(s => PLAUSIBLE.has(s.rel)).slice(0, 3);
    leads.siblingsMore = sib.length - leads.siblings.length;
    leads.neighbours = (prompt.neighbours || []).map(line => {
      const [id, rel, sim] = line.split(' ');
      return {
        id,
        rel,
        similarity: sim && sim.startsWith('~') ? sim.slice(1) : null,
      };
    });
  }
  // The tool's own description/schema docs (same-tool: provable co-render),
  // most relevant to this body first.
  if (index && /^tool-result-/.test(prompt.id)) {
    const fam = index.docs.filter(
      d => !d.suppressed && sameToolFamily(prompt.id, d.id)
    );
    // tf-idf cosine against the family only, as neighbours() scores it.
    const q = new Map();
    for (const t of tokens(prompt.pristineBodies.join('\n\n')))
      q.set(t, (q.get(t) || 0) + 1);
    let qn = 0;
    for (const [t, c] of q) {
      const x = (1 + Math.log(c)) * index.idf(t);
      q.set(t, x);
      qn += x * x;
    }
    qn = Math.sqrt(qn) || 1;
    leads.tool = fam
      .map(d => {
        const v = index.vec[index.byId.get(d.id)];
        let dot = 0;
        for (const [t, x] of q) dot += x * (v.w.get(t) || 0);
        return { id: d.id, similarity: Number((dot / (qn * v.n)).toFixed(3)) };
      })
      .filter(h => h.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
      .slice(0, TOOL_LEADS);
    leads.toolMore = fam.length - leads.tool.length;
    leads.toolKey = fam.length ? sameToolFamily(prompt.id, fam[0].id) : null;
  }
  const carrierClaims = new Map();
  const addCarrier = (id, claims) => {
    if (!carrierClaims.has(id)) carrierClaims.set(id, new Set());
    for (const c of claims) carrierClaims.get(id).add(c);
  };
  // A weak bag-of-words hit in an unrelated function is listed by id only; its
  // body would cost more than it tells.
  for (const c of shownCarriers) {
    c.withBody =
      c.exact.size > 0 ||
      Math.max(0, ...c.terms.values()) >= STRONG_TERMS ||
      PLAUSIBLE.has(c.rel);
    if (c.withBody)
      addCarrier(
        c.id,
        [...c.exact, ...c.terms.keys()].map(i => search.claims[i])
      );
  }
  for (const s of leads.siblings) addCarrier(s.id, []);
  for (const [i, t] of (leads.tool || []).entries()) {
    t.withBody = i < TOOL_BODIES && t.similarity >= TOOL_BODY;
    if (t.withBody) addCarrier(t.id, search.claims);
  }
  for (const n of leads.neighbours) {
    n.withBody = PLAUSIBLE.has(n.rel) || Number(n.similarity) >= NEIGHBOUR_BODY;
    if (n.withBody) addCarrier(n.id, []);
  }
  return {
    prompt,
    search,
    shownCarriers,
    sites,
    leads,
    carrierClaims,
    toolStatus,
  };
};

const DEPLOYED_LABEL = {
  absent: 'absent (no file; pristine applies)',
  pristine: 'pristine (file body is exactly the pristine body)',
  suppressed: 'SUPPRESSED (empty body; renders nothing)',
  override: 'override (deployed body below)',
};

// Everything below the id's heading; cached per id (renderGroupMd numbers it).
export const renderId = m => {
  if (m.rendered) return m.rendered;
  const p = m.prompt;
  const L = [];
  if (p.description) L.push(p.description);
  L.push('');
  const prev =
    p.previousPristineBodies === null
      ? 'no previous body (new id)'
      : p.previousPristineBodies === 'unchanged'
        ? 'unchanged'
        : 'CHANGED (see below)';
  L.push(
    `- catalogue ${p.version} · ${p.siteCount} site(s) · previous version: ${prev}`
  );
  for (const f of p.setFiles) {
    L.push(
      `- deployed in ${f.set}: ${DEPLOYED_LABEL[f.deployed] || f.deployed}` +
        (f.ccVersion ? ` · ccVersion ${f.ccVersion}` : '')
    );
  }
  const slots = Object.entries(p.identifierMap || {});
  if (slots.length || p.identifiers) {
    L.push(
      `- slots: ${slots.map(([k, v]) => `${k}=${v}`).join(', ') || 'none named'}` +
        (p.identifiers
          ? ` · positional order ${JSON.stringify(p.identifiers)}`
          : '')
    );
  }
  const refs = Object.entries(p.externalRefs || {}).filter(
    ([k]) => k !== 'bundleChecked'
  );
  L.push(
    `- externalRefs: ${refs.length ? refs.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('; ') : 'none found'}` +
      (p.externalRefs && p.externalRefs.bundleChecked
        ? ''
        : ' (bundle NOT scanned)')
  );
  L.push('');
  p.pristineBodies.forEach((b, i) => {
    const which =
      p.pristineBodies.length > 1
        ? ` ${i + 1}/${p.pristineBodies.length}` +
          (p.siteBody
            ? ` (sites ${p.siteBody
                .map((x, s) => (x === i ? s + 1 : null))
                .filter(Boolean)
                .join(',')})`
            : '')
        : '';
    L.push(`**Pristine body${which}** (${b.length} chars)`);
    L.push(fence(b));
  });
  for (const f of p.setFiles) {
    if (f.deployed !== 'override') continue;
    L.push(
      `**Deployed body in ${f.set}** (override, ccVersion ${f.ccVersion || '?'})`
    );
    L.push(fence(f.body));
  }
  if (Array.isArray(p.previousPristineBodies)) {
    const d =
      p.previousPristineBodies.length === 1 && p.pristineBodies.length === 1
        ? compactDiff(p.previousPristineBodies[0], p.pristineBodies[0])
        : null;
    if (d !== null) {
      L.push('**Previous version → this one** (`[-removed-]{+added+}`)');
      L.push(fence(d));
    } else {
      p.previousPristineBodies.forEach((b, i) => {
        L.push(
          `**Previous-version body ${i + 1}/${p.previousPristineBodies.length}**`
        );
        L.push(fence(b));
      });
    }
  }
  if (m.sites.length) {
    L.push('**Bundle sites** (relations below are UNPROVEN hints)');
    for (const [i, s] of m.sites.entries()) {
      const where =
        `s${i + 1} ${s.module || '?'}@${s.offset}` +
        (s.fn
          ? ` · fn ${s.fn[0]}-${s.fn[1]} (${s.fn[1] - s.fn[0]} chars)`
          : ' · module scope') +
        ` · ${s.branches} enclosing branch(es)` +
        (s.path ? ` · ${s.path}` : '') +
        (s.binding
          ? s.binding.kind === 'binding'
            ? ` · bound to \`${s.binding.name}\` (query {"refs":"${s.binding.name}","at":${s.offset}})`
            : ` · value of property \`${s.binding.name}\` (query {"prop":"${s.binding.name}"})`
          : '');
      L.push(`- ${where}`);
      if (s.code) L.push(fence(s.code, 'js'));
    }
  } else {
    L.push('**Bundle sites**: not located (query the bundle by text)');
  }
  const s = m.search;
  const uniq = s.unmatched.length;
  L.push(
    `**Corpus search (precomputed: ${s.claims.length} claim sentence(s); ${uniq} with no hit outside this id)**`
  );
  if (!m.shownCarriers.length) L.push('- no carrier matched any claim');
  const weak = [];
  for (const c of m.shownCarriers) {
    if (!c.withBody) {
      weak.push(`\`${c.id}\` ${Math.max(...c.terms.values()).toFixed(2)}`);
      continue;
    }
    const ex = [...c.exact].map(i => `"${short(s.claims[i])}"`);
    const te = [...c.terms].map(
      ([i, sc]) => `"${short(s.claims[i])}" (terms ${sc.toFixed(2)})`
    );
    L.push(`- \`${c.id}\` · ${c.rel} · ${[...ex, ...te].join('; ')}`);
  }
  if (weak.length) {
    L.push(
      `- weak bag-of-words only, unrelated code (no body below): ${weak.join(', ')}`
    );
  }
  if (s.carriers.length > m.shownCarriers.length) {
    L.push(
      `- +${s.carriers.length - m.shownCarriers.length} weaker carrier(s) (re-run the search with a higher limit to list them)`
    );
  }
  const cn = p.concatNeighbours || [];
  if (cn.length) {
    L.push(
      '**Concatenated with** (one text in the bundle; a sentence crossing a boundary is cut whole across both ids or not at all):'
    );
    for (const n of cn) {
      const cross =
        n.crossesSentence === true
          ? 'a sentence CROSSES this boundary'
          : n.crossesSentence === false
            ? 'clean sentence boundary'
            : 'boundary unknown';
      const via =
        n.how === 'array'
          ? `array element${n.join != null ? `, joined with ${JSON.stringify(n.join)}` : ''}`
          : '+ concat';
      const who = n.id
        ? `\`${n.id}\``
        : n.text != null
          ? 'uncatalogued literal'
          : `expression \`${short(n.expr || '', 60)}\``;
      const txt = n.pristine ?? n.text;
      const shown =
        txt == null
          ? ''
          : ` · ${n.pristine != null ? 'pristine' : 'text'}: «${
              txt.length <= 240
                ? txt
                : n.side === 'before'
                  ? `…${txt.slice(-200)}`
                  : `${txt.slice(0, 200)}…`
            }»`;
      L.push(`- ${n.side}: ${who} · ${via} · ${cross}${shown}`);
    }
  }
  const lead = [];
  const listed = new Set(m.shownCarriers.map(c => c.id));
  if (m.leads.tool && m.leads.tool.length) {
    lead.push(
      `this tool's own description/schema (same-tool: PROVABLE co-render only for an ALWAYS-ON tool — confirm it is this tool's): ${
        m.leads.tool
          .filter(x => !listed.has(x.id))
          .map(
            x =>
              `\`${x.id}\` ~${x.similarity}${x.withBody ? '' : ' (no body below)'}${
                (m.toolStatus || (() => null))(x.id) === 'deferred'
                  ? ' (DEFERRED tool: co-render with this result NOT proven)'
                  : (m.toolStatus || (() => null))(x.id) === 'unresolved'
                    ? ' (tool unresolved: check tools[])'
                    : ''
              }`
          )
          .join(', ') || 'as listed above'
      }${m.leads.toolMore > 0 ? ` (+${m.leads.toolMore} more ids of the "${m.leads.toolKey}" family)` : ''}`
    );
  }
  const sibs = m.leads.siblings.filter(x => !listed.has(x.id));
  const near = m.leads.neighbours.filter(x => !listed.has(x.id));
  if (m.leads.siblings.length || m.leads.siblingsMore) {
    lead.push(
      `emitter siblings (unproven): ${sibs.map(x => `\`${x.id}\` ${x.rel}`).join(', ') || (m.leads.siblings.length ? 'as listed above' : 'none that could co-render')}` +
        (m.leads.siblingsMore
          ? ` (+${m.leads.siblingsMore} in other branches/functions: search "siblings")`
          : '')
    );
  }
  const nearBody = near.filter(x => x.withBody);
  if (near.length) {
    lead.push(
      `nearest bodies (similarity, unproven): ${nearBody.map(x => `\`${x.id}\` ${x.rel} ~${x.similarity}`).join(', ') || 'none close'}` +
        (near.length > nearBody.length
          ? ` (+${near.length - nearBody.length} below ${NEIGHBOUR_BODY})`
          : '')
    );
  }
  if (lead.length) L.push(`**Leads**: ${lead.join(' · ')}`);
  L.push('');
  m.rendered = L.join('\n');
  return m.rendered;
};

// One carrier, once per packet: state, staleness, and the deployed text.
export const renderCarrier = ({
  index,
  catalogueVersion,
  id,
  claims,
  inGroup,
  toolStatus = () => null,
}) => {
  const idx = index.byId.get(id);
  if (idx === undefined) return `### \`${id}\`\nnot in the corpus\n`;
  const d = index.docs[idx];
  const L = [`### \`${id}\``];
  const facts = [];
  if (d.kind === 'reminder') facts.push(`system reminder · ${d.path}`);
  else if (d.kind === 'inline') facts.push(`inline blob · ${d.path}`);
  else if (d.source === 'pristine')
    facts.push('no override: catalogue pristine renders');
  else facts.push(`override · ${d.path}`);
  const cv = catalogueVersion(id);
  if (d.ccVersion && cv) {
    facts.push(
      cmpVersion(d.ccVersion, cv) < 0
        ? `ccVersion ${d.ccVersion} < catalogue ${cv}: STALE`
        : `ccVersion ${d.ccVersion} (current)`
    );
  } else if (d.ccVersion) facts.push(`ccVersion ${d.ccVersion}`);
  if (d.source === 'override' && d.kind === 'prompt') {
    facts.push(
      d.matchesPristine
        ? 'deployed = pristine'
        : 'deployed differs from pristine'
    );
  }
  if (d.suppressed) facts.push('SUPPRESSED: renders nothing, never coverage');
  if (d.shadowedBy.length) {
    facts.push(
      `SHADOWED by ${d.shadowedBy.join(', ')}: its body never renders, never coverage`
    );
  }
  if (inGroup) facts.push('also assigned in this packet');
  const ts = toolStatus(id);
  if (ts) facts.push(TOOL_STATUS_NOTE[ts]);
  L.push(facts.join(' · '));
  if (d.suppressed) {
    L.push('');
    return L.join('\n');
  }
  const ex = carrierExcerpt(d.body, [...claims]);
  const stale = cv && d.ccVersion && cmpVersion(d.ccVersion, cv) < 0;
  if (stale && d.pristineBody && !ex.full) {
    const np = normalize(d.pristineBody);
    const only = [...claims].filter(c => {
      const k = normalize(c);
      return k.trim() && normalize(d.body).includes(k) && !np.includes(k);
    });
    if (only.length) {
      L.push(
        `stale-only text (absent from its current pristine): ${only.map(c => `"${short(c, 60)}"`).join('; ')}`
      );
    }
  } else if (stale && d.pristineBody) {
    L.push(
      'stale override: check the quoted text also exists in its current pristine'
    );
  }
  L.push(
    ex.full
      ? `deployed text (${d.body.length} chars, complete):`
      : `deployed text (${d.body.length} chars; matching sentences ±1, full file at ${d.path || 'the catalogue'}):`
  );
  L.push(fence(ex.text));
  L.push('');
  return L.join('\n');
};

export const renderGroupMd = ({
  header,
  lccRules,
  lccPath,
  models,
  carrierBlocks,
}) => {
  const parts = [
    header,
    `## LCC decision rule (verbatim from ${lccPath})`,
    '',
    lccRules,
    '',
  ];
  parts.push(`# Assigned ids (${models.length})`, '');
  models.forEach((m, i) =>
    parts.push(`## ${i + 1}/${models.length} \`${m.prompt.id}\``, renderId(m))
  );
  const ids = [...carrierBlocks.keys()];
  parts.push(
    `# Carriers (${ids.length}, each once; deployed text as it renders, un-escaped)`,
    ''
  );
  for (const id of ids) parts.push(carrierBlocks.get(id));
  return wrapLong(parts.join('\n'));
};

export const renderHeader = ({
  group,
  version,
  count,
  paths,
  commands,
  captureNote = '',
}) =>
  [
    `# Stage-1 audit packet ${group} — Claude Code ${version} (${count} ids)`,
    '',
    'This file IS the packet: read it once, whole (the JSON twin is for the tools). ' +
      Object.entries(paths)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · '),
    '',
    '## Commands (each answers many questions in ONE call)',
    'Follow-up corpus search (one batched call; prints text):',
    fence(commands.search, 'sh'),
    'Bundle queries (every lookup for ALL ids in one call, two at most; never python/grep the bundle). Kinds: {"slice":N,"before":600,"after":600} {"fn":N} {"callers":N,"depth":2} {"refs":"name","at":N} {"prop":"name"} {"text":"literal","max":20} {"regex":"src","max":20} {"trace":N} {"catalogue":"text"}',
    fence(commands.query, 'sh'),
    'Write + check (writes the verdicts file, prints the checker: PASS/FAIL line, then every problem; `--merge` replaces only the ids sent):',
    fence(commands.write, 'sh'),
    '',
    '## How to read it',
    '- Per id: pristine body (`${LABEL}` slots), deployed state, previous-version change, slots, externalRefs, bundle sites (code for the first two functions: head, ~200 chars either side, literal shortened in ⟪…⟫), concatenated fragments, the precomputed search, leads.',
    '- "Corpus search (precomputed)" IS auditCorpusSearch\'s output for every claim sentence of every assigned body (same index: active set incl. inline-*.md, system-reminders, catalogue pristine). Search again only for other phrasings or terms.',
    `- ${CORENDER_NOTE}`,
    ...(captureNote ? [`- ${captureNote}`] : []),
    '- "# Carriers" holds every carrier named once: state (SUPPRESSED/SHADOWED/STALE vs catalogue) and deployed text, complete or the matching sentences ±1. Quote from it.',
    `- Lines over ${WRAP_AT} chars are wrapped at a space (quotes are checked ignoring whitespace).`,
    '',
  ].join('\n');
