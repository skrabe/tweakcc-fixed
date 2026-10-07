// Validation shared by checkClassifyVerdicts (one chunk, run by the agent
// that wrote it) and harvestClassify (every chunk, run by the main loop).
//
// The classify workflow hands agents file paths, not hash lists, so the
// completeness and collision checks that used to run inside the workflow
// script against inline args run here instead, against the evidence
// directory the packets were built into.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeMarkdownParts } from './packetParts.mjs';

export const FACINGS = new Set(['model', 'ui', 'internal']);
export const RESERVED_PREFIXES = ['inline-', 'workflow-script-'];
const NULLISH = new Set(['null', 'undefined', 'none', 'n/a', '']);
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Which drafts get an independent second read. A mistake costs where a
// verdict mints or keeps a catalogue id, where it reverses what the tracer
// proved, or where its author was unsure; that is the scope:
//   - every model verdict (id, name and desc are judged too);
//   - every candidate carrying a continuity or piebald id (reusedFrom,
//     possibleSuccessorOf, piebaldExact), whatever its facing;
//   - hedged evidence;
//   - a non-model draft on a route the tracer proved model-facing.
// A non-model draft on an open route is NOT re-read on that ground alone: the
// classifier had the open branches in its packet with their code and was
// required to follow them. Measured on the CC 2.1.288 replay: re-reading every
// open route put 1,042 of 1,067 drafts in scope; the verifier changed 25 of
// them, and every facing or id change but one (an internal -> ui swap with no
// catalogue effect) fell inside this narrower scope, which holds ~550.
const HEDGE = /uncertain|unclear|assume|likely|probabl|not located|placeholder|unsure|cannot tell|can't tell|guess/i;

export function scopeReasons(v, cand) {
  const why = [];
  if (v.facing === 'model') why.push('model verdict');
  if (cand && (cand.reusedFrom || cand.possibleSuccessorOf)) why.push('continuity id');
  if (cand && cand.piebaldExact) why.push('piebald id');
  if (HEDGE.test(v.evidence || '')) why.push('hedged evidence');
  const r = (cand && cand.route) || {};
  if (r.verdict === 'model' && v.facing !== 'model') why.push('draft contradicts the traced model route');
  return why;
}

export function needsVerify(v, cand) {
  return scopeReasons(v, cand).length > 0;
}

export const pad = (n, width) => String(n).padStart(width, '0');
export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
export const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadManifest(dir) {
  const f = path.join(dir, 'manifest.json');
  if (!fs.existsSync(f)) throw new Error(`no manifest.json in ${dir} — run tools/buildClassifyEvidence.mjs first`);
  return readJson(f);
}

export const chunkFile = (dir, m, nn) => path.join(dir, `chunk-${nn}.json`);
export const verdictsFile = (dir, nn) => path.join(dir, `verdicts-${nn}.json`);
export const verifyFile = (dir, nn) => path.join(dir, `verify-${nn}.json`);
export const scopeFile = (dir, nn) => path.join(dir, `verify-scope-${nn}.json`);

// Accept "3", "03", "chunk-03".
export function normalizeChunk(m, arg) {
  const n = String(arg).replace(/^chunk-/, '').replace(/\.json$/, '');
  const hit = m.chunks.find(c => c.chunk === n || Number(c.chunk) === Number(n));
  if (!hit) throw new Error(`chunk ${arg} is not in the manifest (0..${m.chunkCount - 1})`);
  return hit.chunk;
}

// Bundle and corpus must be the ones the packets were built from; a verdict
// produced against another bundle is not evidence for this one.
export function digestProblems(m, { checkFiles = true } = {}) {
  const out = [];
  if (!checkFiles) return out;
  if (m.bundle && m.bundle.path && fs.existsSync(m.bundle.path)) {
    const now = sha256(fs.readFileSync(m.bundle.path));
    if (now !== m.bundle.sha256) out.push(`bundle ${m.bundle.path} changed since the evidence was built (sha256 ${now.slice(0, 12)} != ${m.bundle.sha256.slice(0, 12)}); rebuild the evidence`);
  }
  if (m.corpus && m.corpus.promptsJson && fs.existsSync(m.corpus.promptsJson)) {
    const now = sha256(fs.readFileSync(m.corpus.promptsJson)).slice(0, 16);
    if (now !== m.corpus.digest) out.push(`catalogue ${m.corpus.promptsJson} changed since the evidence was built (digest ${now} != ${m.corpus.digest}); rebuild the evidence`);
  }
  return out;
}

export function fieldProblems(v, cand, where) {
  const out = [];
  const h = v.hash;
  if (!FACINGS.has(v.facing)) out.push(`${where} ${h}: facing must be model|ui|internal, got ${JSON.stringify(v.facing)}`);
  if (typeof v.evidence !== 'string' || v.evidence.trim().length < 20) out.push(`${where} ${h}: evidence must cite the emission site (offset, enclosing expression or route sink), got ${JSON.stringify(v.evidence)}`);
  if (v.facing === 'model') {
    for (const f of ['id', 'name', 'desc']) {
      if (typeof v[f] !== 'string' || NULLISH.has(v[f].trim().toLowerCase())) out.push(`${where} ${h}: facing:model needs a non-empty ${f} (a reused id needs name and desc too)`);
    }
    if (typeof v.id === 'string') {
      // Older catalogue ids keep underscores from tool/parameter names; reusing
      // one verbatim is required, so only a newly minted id must be kebab-case.
      const reused = ((cand && cand.allowedIds) || []).includes(v.id);
      if (!reused && !ID_RE.test(v.id)) out.push(`${where} ${h}: id ${JSON.stringify(v.id)} is not kebab-case [a-z0-9-]`);
      const pre = RESERVED_PREFIXES.find(p => v.id.startsWith(p));
      if (pre) out.push(`${where} ${h}: id ${v.id} uses the reserved ${pre} prefix — mint a catalogue id instead`);
    }
  } else if (v.facing === 'ui' || v.facing === 'internal') {
    for (const f of ['id', 'name', 'desc']) {
      if (v[f] !== null) out.push(`${where} ${h}: facing:${v.facing} must set ${f} to JSON null (not ${JSON.stringify(v[f])})`);
    }
  }
  return out;
}

// Verdict-file envelope and per-hash checks for one stage.
//   expected: hashes the file must cover exactly
//   cands: Map(hash -> packet candidate)
export function checkVerdictSet(file, { m, nn, expected, cands, label }) {
  const problems = [];
  if (!fs.existsSync(file)) return { problems: [`${label}: ${file} does not exist`], verdicts: null };
  let doc;
  try {
    doc = readJson(file);
  } catch (e) {
    return { problems: [`${label}: ${file} is not valid JSON (${e.message})`], verdicts: null };
  }
  const verdicts = Array.isArray(doc) ? null : doc && Array.isArray(doc.verdicts) ? doc.verdicts : null;
  if (!verdicts) return { problems: [`${label}: ${file} must be {"chunk","bundleSha","corpusDigest","verdicts":[…]}`], verdicts: null };
  if (String(doc.chunk) !== nn) problems.push(`${label}: "chunk" is ${JSON.stringify(doc.chunk)}, expected "${nn}"`);
  if (doc.bundleSha !== m.bundle.sha256) problems.push(`${label}: "bundleSha" must be ${m.bundle.sha256} (copy it from the packet header)`);
  if (doc.corpusDigest !== m.corpus.digest) problems.push(`${label}: "corpusDigest" must be ${m.corpus.digest} (copy it from the packet header)`);
  const want = new Set(expected);
  const seen = new Map();
  for (const v of verdicts) {
    if (!v || typeof v.hash !== 'string') { problems.push(`${label}: a verdict has no hash`); continue; }
    if (seen.has(v.hash)) problems.push(`${label}: hash ${v.hash} appears more than once`);
    seen.set(v.hash, v);
    if (!want.has(v.hash)) {
      const near = expected.filter(h => h.startsWith(v.hash.slice(0, 8)));
      problems.push(`${label}: ${v.hash} is not ${label === 'verify' ? 'in this chunk\'s verify scope' : 'a candidate of this chunk'}${near.length === 1 ? ` (did you mean ${near[0]}? copy hashes verbatim)` : ''}`);
      continue;
    }
    problems.push(...fieldProblems(v, cands.get(v.hash), label));
  }
  const missing = expected.filter(h => !seen.has(h));
  if (missing.length) problems.push(`${label}: missing ${missing.length} of ${expected.length} hash(es): ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}`);
  return { problems, verdicts };
}

// One id = one body. An id already in the catalogue may be kept only by the
// candidate whose own body carries it, or the one licensed to reuse it
// (reusedFrom / possibleSuccessorOf / piebaldExact).
export function collisionProblems(merged, { cands, catalogue, label }) {
  const out = [];
  const byId = new Map();
  for (const v of merged) {
    if (v.facing !== 'model' || typeof v.id !== 'string') continue;
    const prev = byId.get(v.id);
    if (prev && prev !== v.hash) out.push(`${label}: id ${v.id} is given to two different hashes (${prev.slice(0, 10)}, ${v.hash.slice(0, 10)}) — keep it on the body the previous one opens with and name the other for what distinguishes it`);
    else byId.set(v.id, v.hash);
    const live = catalogue[v.id];
    if (live && !live.includes(v.hash)) {
      const cand = cands.get(v.hash) || {};
      if (!(cand.allowedIds || []).includes(v.id)) {
        out.push(`${label}: ${v.hash.slice(0, 10)} reuses catalogue id ${v.id}, which is live on a different body and is not this candidate's reusedFrom/possibleSuccessorOf/piebaldExact id — text that reads like an existing prompt but interpolates different expressions is a DIFFERENT prompt; mint a sibling id`);
      }
    }
  }
  return out;
}

export function loadChunk(dir, m, nn) {
  const packet = readJson(chunkFile(dir, m, nn));
  const cands = new Map(packet.candidates.map(c => [c.hash, c]));
  return { packet, cands };
}

export function loadCatalogue(dir, m) {
  const f = path.join(dir, m.catalogueIndex || 'catalogue-index.json');
  return fs.existsSync(f) ? readJson(f) : {};
}

// Full per-chunk evaluation. stage: 'classify' | 'verify'.
export function evaluateChunk(dir, m, nn, { stage = 'classify', checkFiles = true, otherChunks = true } = {}) {
  const { packet, cands } = loadChunk(dir, m, nn);
  const catalogue = loadCatalogue(dir, m);
  const problems = [...digestProblems(m, { checkFiles })];
  if (packet.bundle?.sha256 !== m.bundle.sha256 || packet.corpus?.digest !== m.corpus.digest) problems.push(`packet chunk-${nn}.json is from another build of the evidence; rebuild it`);
  const expected = packet.candidates.map(c => c.hash);
  const cls = checkVerdictSet(verdictsFile(dir, nn), { m, nn, expected, cands, label: 'classify' });
  problems.push(...cls.problems);
  const result = { chunk: nn, stage, candidates: expected.length, classified: false, verified: false, scope: null, problems };
  if (!cls.verdicts) return result;
  const draft = new Map(cls.verdicts.filter(v => v && cands.has(v.hash)).map(v => [v.hash, v]));
  const scope = expected.filter(h => draft.has(h) && needsVerify(draft.get(h), cands.get(h)));
  result.scope = scope;
  let merged = [...draft.values()];
  if (stage === 'verify' && !(scope.length === 0 && !fs.existsSync(verifyFile(dir, nn)))) {
    const ver = checkVerdictSet(verifyFile(dir, nn), { m, nn, expected: scope, cands, label: 'verify' });
    problems.push(...ver.problems);
    if (ver.verdicts) {
      const audited = new Map(ver.verdicts.filter(v => v && scope.includes(v.hash)).map(v => [v.hash, v]));
      merged = merged.map(v => audited.get(v.hash) || v);
    }
  }
  problems.push(...collisionProblems(merged, { cands, catalogue, label: stage }));
  problems.push(...identityProblems(merged, { cands, label: stage, fragmentVerdicts: fragmentVerdictsFor(dir, m, nn, cands, merged) }));
  if (otherChunks) problems.push(...crossChunkProblems(dir, m, nn, merged));
  result.merged = merged;
  result.classified = cls.problems.length === 0;
  result.verified = stage === 'verify' && problems.length === 0;
  return result;
}

// The final verdicts another chunk currently holds on disk (its verify file
// over its draft), used to catch one id minted in two chunks.
export function currentVerdicts(dir, m, nn) {
  const vf = verdictsFile(dir, nn);
  if (!fs.existsSync(vf)) return [];
  let draft;
  try {
    draft = readJson(vf).verdicts || [];
  } catch {
    return [];
  }
  const map = new Map(draft.filter(v => v && v.hash).map(v => [v.hash, v]));
  const xf = verifyFile(dir, nn);
  if (fs.existsSync(xf)) {
    try {
      for (const v of readJson(xf).verdicts || []) if (v && map.has(v.hash)) map.set(v.hash, v);
    } catch {
      /* an unreadable verify file is that chunk's own failure */
    }
  }
  return [...map.values()];
}

export function crossChunkProblems(dir, m, nn, merged) {
  const out = [];
  const mine = new Map(merged.filter(v => v.facing === 'model' && typeof v.id === 'string').map(v => [v.id, v.hash]));
  if (!mine.size) return out;
  for (const c of m.chunks) {
    if (c.chunk === nn) continue;
    for (const v of currentVerdicts(dir, m, c.chunk)) {
      if (v.facing !== 'model' || typeof v.id !== 'string') continue;
      const h = mine.get(v.id);
      if (h && h !== v.hash) out.push(`id ${v.id} is also used by chunk ${c.chunk} for ${v.hash.slice(0, 10)} — one id names one body; pick a distinguishing id for this chunk's string`);
    }
  }
  return out;
}

// ---- reporting shared by checkClassifyVerdicts and writeClassifyVerdicts ----

// Problems name candidates by packet key as well as hash prefix, so an agent
// that wrote by key can find the entry to fix.
export function keyedProblems(problems, cands) {
  const byPrefix = new Map();
  for (const c of cands.values()) if (c.key) byPrefix.set(c.hash.slice(0, 10), c.key);
  return problems.map(p => p.replace(/\b([0-9a-f]{10})[0-9a-f]{0,30}\b/g, (all, pre) => (byPrefix.has(pre) ? `${byPrefix.get(pre)} (${all})` : all)));
}

export const verifyMdFile = (dir, nn) => path.join(dir, `verify-${nn}.md`);

// After a classify PASS: the verify scope (hashes) and the verifier's packet,
// verify-NN.md — only the in-scope candidates, each with why it is in scope
// and the draft it must confirm or correct, under its family block.
export async function writeScopeArtifacts(dir, m, nn, r) {
  const { packet, cands } = loadChunk(dir, m, nn);
  const draft = new Map((r.merged || []).map(v => [v.hash, v]));
  fs.writeFileSync(scopeFile(dir, nn), JSON.stringify({ chunk: nn, bundleSha: m.bundle.sha256, scope: r.scope }, null, 1));
  const { renderVerifyMd } = await import('./classifyPacketMd.mjs');
  const families = new Map((packet.families || []).map(f => [f.key, f.md]));
  const items = r.scope.map(h => {
    const c = cands.get(h);
    return { family: c.family, md: c.md || `### ${c.key || h.slice(0, 12)}\n> ${c.body}`, draft: draft.get(h), why: scopeReasons(draft.get(h), c) };
  });
  const cmd = packet.commands || {};
  const header = [
    `# Verify chunk ${nn} — Claude Code ${packet.version}: ${items.length} of ${packet.candidates.length} draft verdict(s) in scope`,
    `Only these are yours; the rest of the chunk is settled. Each entry: the evidence block the classifier had, then its draft and why it is in scope.`,
    '',
    `- write + check, one step: \`${cmd.writeVerify} <<'V'\` then a JSON array with one entry per in-scope key, \`[{"k":"k03","facing":"model","id":"…","name":"…","desc":"…","evidence":"…"}, …]\`, then \`V\` (the draft when it holds, your correction when it does not; merges with what is on disk).`,
    `- bundle lookups, MANY per call: \`${cmd.query} <<'Q'\` then a JSON array of queries then \`Q\` (kinds: slice, fn, callers, refs, prop, guards, text, regex, trace, siblings, aliases, catalogue).`,
  ].join('\n');
  // Larger than one Read: part files beside verify-NN.md, read in one message.
  return writeMarkdownParts(verifyMdFile(dir, nn), renderVerifyMd({ header, families, items }));
}

// Print the checker's verdict (first line PASS/FAIL) and, on a classify PASS,
// write the verify scope and verify-NN.md (and its parts). The PASS line names
// the verify packet's part count: the classify agent relays it in its receipt
// and the workflow hands the verifier exactly those files. Returns the exit
// code.
export async function report(dir, m, nn, stage, r) {
  const { cands } = loadChunk(dir, m, nn);
  if (r.problems.length) {
    const ps = keyedProblems(r.problems, cands);
    console.log(`FAIL chunk ${nn} (${stage}): ${ps.length} problem(s)`);
    for (const p of ps.slice(0, 60)) console.log(`  - ${p}`);
    if (ps.length > 60) console.log(`  … ${ps.length - 60} more`);
    return 1;
  }
  if (stage === 'classify') {
    const md = await writeScopeArtifacts(dir, m, nn, r);
    console.log(`PASS chunk ${nn} (classify): ${r.candidates} verdict(s); verify scope ${r.scope.length}; verify parts ${md.length} -> ${path.basename(scopeFile(dir, nn))}, ${md.map(f => path.basename(f)).join(', ')}`);
  } else {
    console.log(`PASS chunk ${nn} (verify): ${r.scope.length} in-scope verdict(s) audited of ${r.candidates}`);
  }
  return 0;
}

// Identity rules the collision check cannot see.
//   Continuity: a candidate whose reusedFrom id left the catalogue keeps that
//   id unless the verdict states, in roleChange, why the PURPOSE changed (a
//   split half, a different message) — wording alone is not a reason. On the
//   CC 2.1.288 replay seven such ids were re-minted silently, orphaning their
//   LCC overrides.
//   Joins: a candidate concatenated from other candidates (joinOf) never takes
//   a fragment's id, nor the continuity id it inherited from a fragment (the
//   replay put a fragment's old id on the "+" join, leaving the fragment that
//   carries the override without it). A join that is model-facing takes its
//   own id, as the shipped catalogue does for its composites.
export function identityProblems(merged, { cands, label, fragmentVerdicts = new Map() }) {
  const out = [];
  for (const v of merged) {
    const c = cands.get(v.hash);
    if (!c) continue;
    const tag = `${label}: ${v.hash.slice(0, 10)}`;
    if (c.joinOf) {
      const frag = new Set(c.joinOf.fragmentIds || []);
      for (const h of c.joinOf.hashes || []) {
        const fv = fragmentVerdicts.get(h);
        if (fv && fv.facing === 'model' && typeof fv.id === 'string') frag.add(fv.id);
      }
      if (v.facing === 'model' && typeof v.id === 'string' && frag.has(v.id)) {
        out.push(`${tag} is a JOIN and was given ${v.id}, which belongs to one of its fragments (${(c.joinOf.keys || []).join(', ')}) — ids belong on fragments, never on the join; the join takes its own id`);
      }
      continue;
    }
    const r = c.reusedFrom;
    if (r && r.id && !(v.facing === 'model' && v.id === r.id)) {
      if (!(typeof v.roleChange === 'string' && v.roleChange.trim().length >= 20)) {
        out.push(`${tag} carries reusedFrom ${r.id} but the verdict ${v.facing === 'model' ? `names ${v.id}` : `is ${v.facing}`}: keep ${r.id}, or add "roleChange" stating why its purpose changed (a split half, a different message) — reworded text is the same prompt`);
      }
    }
  }
  return out;
}

// Current verdicts (draft over verify) of the fragments of every join in this
// chunk, from whichever chunk holds them.
export function fragmentVerdictsFor(dir, m, nn, cands, merged) {
  const want = new Set();
  for (const c of cands.values()) for (const h of (c.joinOf && c.joinOf.hashes) || []) want.add(h);
  const out = new Map();
  if (!want.size) return out;
  for (const v of merged) if (want.has(v.hash)) out.set(v.hash, v);
  for (const ch of m.chunks || []) {
    if (ch.chunk === nn) continue;
    if (!(ch.hashes || []).some(h => want.has(h))) continue;
    for (const v of currentVerdicts(dir, m, ch.chunk)) if (want.has(v.hash)) out.set(v.hash, v);
  }
  return out;
}
