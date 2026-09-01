#!/usr/bin/env node
// Builds the per-group evidence packets the audit-new-prompts-stage{1,2,3}
// workflows read. An agent handed only an id has to rediscover the pristine
// body, every site of a repeated id, the four maintained-set paths, and which
// siblings might already carry the claim — so the packet assembles all of it
// once, and the fan-out spends its budget on judgment instead of lookup.
//
//   node tools/buildAuditPacket.mjs <prompts.json> <ids-file> <outDir> [groupSize]
//
// <ids-file> is one prompt id per line. Writes <outDir>/audit-packet-NN.json
// and prints the group descriptors the workflow wants as `groups`.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { packByWeight, packingFloor } from './lib/packByWeight.mjs';

const [jsonPath, idsPath, outDirArg, groupSizeArg] = process.argv.slice(2);
if (!jsonPath || !idsPath) {
  console.error(
    'usage: buildAuditPacket.mjs <prompts.json> <ids-file> [outDir] [groupSize]'
  );
  process.exit(2);
}
const outDir = outDirArg || '/tmp';
// Namespacing the packets per version is what keeps a previous bump's leftovers
// from being harvested as this one's result, so the tool has to be able to
// create the directory it was pointed at rather than failing at the first write.
fs.mkdirSync(outDir, { recursive: true });
// 12 was too small. Every stage-1/stage-3 agent is told to search the whole
// corpus itself — a 6.6 MB prompts JSON plus ~4,400 override files — and that
// cost is FLAT per agent, not per prompt. Measured on 2.1.237: ~26 s marginal
// per extra prompt against a fixed setup measured in minutes, so a bigger group
// amortises the scan and a smaller one just pays it again.
const groupSize = Math.max(1, Number(groupSizeArg || 30));

const LCC = path.join(os.homedir(), '.tweakcc', 'lobotomized-claude-code');
// The active set moves; resolve it, never hardcode it.
const activeSet = fs.realpathSync(
  path.join(os.homedir(), '.tweakcc', 'system-prompts')
);
const activeName = path.basename(activeSet);
// Discover the maintained sets from disk rather than naming them: the roster
// changes (three legacy sets were retired on 2026-09-01), and a hardcoded list
// silently stops covering a set the moment one is added or removed.
const allSets = [
  activeName,
  ...fs
    .readdirSync(LCC, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('system-prompts-'))
    .map(d => d.name)
    .filter(s => s !== activeName)
    .sort(),
];

const prompts = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).prompts;
// The realign workflow's prompt tells the agent to read "the complete old
// pristine -> new pristine change", and the packet never carried the old body:
// the agent had to go find one id inside a 3 MB previous-version JSON, or judge
// the realignment without the diff at all. TWEAKCC_PREV_JSON supplies it.
// Optional, so every existing caller is unaffected.
const prevJsonPath = process.env.TWEAKCC_PREV_JSON || '';
const prevBodies = new Map();
if (prevJsonPath && fs.existsSync(prevJsonPath)) {
  for (const p of JSON.parse(fs.readFileSync(prevJsonPath, 'utf8')).prompts) {
    if (!p.id) continue;
    if (!prevBodies.has(p.id)) prevBodies.set(p.id, []);
    prevBodies.get(p.id).push((p.pieces || []).filter(x => typeof x === 'string').join('') || p.content || '');
  }
}
const bodyOf = p =>
  (p.pieces || []).filter(x => typeof x === 'string').join('') || p.content || '';

const byId = new Map();
for (const p of prompts) {
  if (!p.id) continue;
  if (!byId.has(p.id)) byId.set(p.id, []);
  byId.get(p.id).push(p);
}

// Word-shingle index over the whole catalogue, so a duplication LEAD can be
// computed instead of guessed. Content-keyed, never position-keyed: sampling
// fixed character offsets is not shift-invariant and one inserted character
// rebases every later window.
const shingles = text => {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 4 <= words.length; i++) {
    const gram = words.slice(i, i + 4).join(' ');
    let h = 0;
    for (let j = 0; j < gram.length; j++) h = (h * 31 + gram.charCodeAt(j)) | 0;
    if ((h & 7) === 0 || words.length < 200) out.add(gram);
  }
  return out;
};
const shingleCache = new Map();
const shinglesFor = id => {
  if (!shingleCache.has(id)) shingleCache.set(id, shingles(bodyOf(byId.get(id)[0])));
  return shingleCache.get(id);
};

const ids = fs
  .readFileSync(idsPath, 'utf8')
  .split('\n')
  .map(s => s.trim())
  .filter(Boolean);

const missing = ids.filter(id => !byId.has(id));
if (missing.length) {
  console.error(`ids not in ${jsonPath}: ${missing.join(', ')}`);
  process.exit(2);
}

const readIfExists = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const ccVersionOf = text => (text?.match(/^ccVersion:\s*(\S+)\s*$/m) || [])[1] || null;

const packetFor = id => {
  const entries = byId.get(id);
  const mine = shinglesFor(id);
  const leads = [];
  if (mine.size) {
    for (const other of byId.keys()) {
      if (other === id) continue;
      const theirs = shinglesFor(other);
      if (!theirs.size) continue;
      let shared = 0;
      for (const g of mine) if (theirs.has(g)) shared++;
      const score = shared / Math.min(mine.size, theirs.size);
      if (score >= 0.25) leads.push({ id: other, overlap: Number(score.toFixed(2)) });
    }
    leads.sort((a, b) => b.overlap - a.overlap);
  }
  return {
    id,
    version: entries[0].version,
    name: entries[0].name || null,
    description: entries[0].description || null,
    siteCount: entries.length,
    // Every site, because a repeated id is several distinct binary sites and a
    // verdict taken on the first one can be wrong for the others.
    pristineBodies: entries.map(bodyOf),
    previousPristineBodies: prevBodies.get(id) || null,
    identifiers: entries[0].identifiers || null,
    identifierMap: entries[0].identifierMap || null,
    // All four target paths, with whatever already exists on disk. An empty
    // body means SUPPRESSED and covers nothing; no file means pristine applies.
    setFiles: allSets.map(set => {
      const file = path.join(LCC, set, `${id}.md`);
      const text = readIfExists(file);
      return {
        set,
        path: file,
        exists: text !== null,
        ccVersion: text ? ccVersionOf(text) : null,
        body: text,
        isActiveSet: set === activeName,
      };
    }),
    // Leads only. The workflow prompt already says similarity is never proof —
    // the agent must open the cited sibling's DEPLOYED body.
    duplicationLeads: leads.slice(0, 8),
  };
};

// Balance packets by WORK, not by id count.
//
// Contiguous slicing gave every packet the same number of prompts and wildly
// different amounts of text: measured on the 2.1.237 sets, count was even to
// within 4% while pristine characters ran 6.45x max/mean (29,681 vs 1,876 in
// the same run), and realign packets hit 4.70x. Wall clock is the slowest
// agent, so a fan-out ran at the speed of its unluckiest packet — 27.1 min
// against a 13.8 min median on the stage-1 run this was measured from.
//
// Greedy longest-processing-time: sort by weight descending, drop each id into
// whichever bin is currently lightest. Classic LPT, within 4/3 of optimal, and
// the ordering makes it deterministic so reruns produce identical packets.
const weightOf = id => {
  const entries = byId.get(id) || [];
  let w = 0;
  for (const e of entries) w += bodyOf(e).length;
  // A prompt with an existing override costs the agent that read too.
  for (const set of allSets) {
    const f = path.join(LCC, set, `${id}.md`);
    if (fs.existsSync(f)) w += fs.statSync(f).size;
  }
  // Floor so a tiny prompt still counts as a unit of attention, not zero.
  return w + 512;
};

const binCount = Math.max(1, Math.ceil(ids.length / groupSize));
const bins = packByWeight(ids, binCount, weightOf, id => id);

const groups = [];
for (const bin of bins) {
  // Restore input order inside a packet so a human reading it sees the familiar
  // id sequence rather than a weight ranking.
  const slice = bin.items.slice().sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
  if (!slice.length) continue;
  const n = String(groups.length).padStart(2, '0');
  const file = path.join(outDir, `audit-packet-${n}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ version: JSON.parse(fs.readFileSync(jsonPath, 'utf8')).version, activeSet, sets: allSets, prompts: slice.map(packetFor) }, null, 1)
  );
  groups.push({ name: `g${n}`, packet: file, ids: slice });
}

const ws = bins.map(b => b.weight);
const mean = ws.reduce((a, b) => a + b, 0) / (ws.length || 1);
console.log(
  `audit packets: ${groups.length} group(s), ${ids.length} id(s), groupSize=${groupSize} ` +
    `| weight-balanced: max/mean ${(Math.max(...ws) / mean).toFixed(2)}x, ` +
    `${(Math.max(...ws) / packingFloor(ids, binCount, weightOf)).toFixed(2)}x of the ` +
    `theoretical floor (heaviest ${Math.max(...ws)} ch, lightest ${Math.min(...ws)} ch)`
);
console.log(prevJsonPath ? `previous pristine: ${prevJsonPath}` : 'previous pristine: none (set TWEAKCC_PREV_JSON for realignment diffs)');
console.log(`active set: ${activeSet}`);
console.log(`sets: ${allSets.join(', ')}`);
fs.writeFileSync(path.join(outDir, 'audit-groups.json'), JSON.stringify(groups, null, 1));
console.log(`groups descriptor -> ${path.join(outDir, 'audit-groups.json')}`);
