#!/usr/bin/env node
// Build the cut-hunt packets: every stage-1 keep gets a second read.
//
//   node tools/selectCutHunt.mjs <stage1 packetDir> <huntDir> [--ids-per-agent N]
//
// Reads <packetDir>/stage1-result.json (harvestAudit's output) and the stage-1
// packets. Every pristine-keep is hunted. Its cut leads (tools/lib/cutLeads.mjs:
// a claim restated by a carrier that may co-render, the tool's own
// description/schema, a same-tool emitter sibling, a near body) travel with it
// as evidence; they no longer decide who is hunted (CC 2.1.288 replay: 367 of
// 450 keeps had a lead, a quarter-share cap hunted 112 of them).
//
// Writes into <huntDir>: hunt-packet-NN.json (the stage-1 packet entries of
// those ids, same shape, so writeAuditVerdicts/checkAuditVerdicts work
// unchanged), hunt-packet-NN.md (the stage-1 markdown of those ids with their
// stage-1 verdict and leads, the LCC sections, and every carrier and lead
// body once; split into hunt-packet-NN.partK.md when larger than one Read
// call), hunt-selection.json (every keep with its score and leads) and
// hunt-manifest.json. Last line: the workflow args.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openIndex, resolveCarrier } from './lib/auditCorpus.mjs';
import { cutLeads, leadScore } from './lib/cutLeads.mjs';
import { partitionContiguous, agentsFor } from './lib/packByWeight.mjs';
import { writeMarkdownParts, partByteCap } from './lib/packetParts.mjs';
import { capturedTools, makeToolStatus, TOOL_STATUS_NOTE } from './lib/deferredTools.mjs';

// Keeps one hunter re-reads. Set from the 2.1.288 batching replay (see memory
// showtime-token-cost): per-agent cost there was dominated by the fixed
// context every agent pays, not by the ids it ruled.
export const IDS_PER_AGENT = 29;

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

// Split a stage-1 md into header parts, per-id sections and carrier sections.
export function splitStageMd(md) {
  const idx = md.indexOf('\n# Assigned ids');
  const car = md.indexOf('\n# Carriers');
  const howAt = md.indexOf('\n## How to read it');
  const common = howAt >= 0 && idx > howAt ? md.slice(howAt + 1, idx).trim() : '';
  const idsPart = md.slice(idx + 1, car >= 0 ? car : md.length);
  const sections = new Map();
  const re = /^## \d+\/\d+ `([^`]+)`\n/gm;
  const heads = [...idsPart.matchAll(re)];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : idsPart.length;
    sections.set(h[1], idsPart.slice(h.index + h[0].length, end).trim());
  });
  const carriers = new Map();
  if (car >= 0) {
    const cpart = md.slice(car + 1);
    const ch = [...cpart.matchAll(/^### `([^`]+)`\n/gm)];
    ch.forEach((h, i) => {
      const end = i + 1 < ch.length ? ch[i + 1].index : cpart.length;
      carriers.set(h[1], cpart.slice(h.index + h[0].length, end).trim());
    });
  }
  return { common, sections, carriers };
}

const fence = t => {
  const runs = String(t).match(/~{3,}/g) || [];
  const f = '~'.repeat(Math.max(3, ...runs.map(r => r.length + 1)));
  return `${f}text\n${t}\n${f}`;
};

const STATUS_TAG = { deferred: ' — DEFERRED tool: conditional carrier, co-render NOT proven', unresolved: ' — tool unresolved: check the capture tools[] before citing' };
const leadLine = (l, toolStatus = () => null) =>
  `- ${l.kind} → \`${l.carrier}\` (${l.rel}${l.share != null ? `, restates ${Math.round(l.share * 100)}% of the claims` : ''}${l.similarity != null ? `, similarity ${l.similarity}` : ''})${STATUS_TAG[toolStatus(l.carrier)] || ''}`;

export function renderHuntMd({ group, version, ids, stage1, leadsById, parts, commands, extraCarriers, toolStatus = () => null }) {
  const L = [];
  L.push(`# Cut hunt ${group} — Claude Code ${version} (${ids.length} ids)`);
  L.push('');
  L.push('Every id below was ruled pristine-keep by stage 1. Your job: build the STRONGEST LEGITIMATE cut for each (trim or wipe-merge) under the full rules, then decide honestly whether it holds. Stage 1\'s reasoning and the cut leads the packet evidence names are shown per id; they are evidence, not verdicts, and an id without a lead still gets the full hunt.');
  L.push('');
  L.push('## Commands (each answers many questions in ONE call)');
  L.push(`Bundle queries (every lookup for ALL ids in one call, two at most; never python/grep the bundle):\n~~~sh\n${commands.query} <<'Q'\n[{"fn":123},{"callers":123,"depth":2},{"refs":"Xy","at":123},{"text":"literal"},{"prop":"optionName"}]\nQ\n~~~`);
  L.push(`Follow-up corpus search (one batched call; prints text):\n~~~sh\ncat > ${commands.queries} <<'Q'\n{"queries":[{"forId":"<id>","q":"<phrase>"}],"siblings":[],"neighbours":[]}\nQ\n${commands.search}\n~~~`);
  L.push(`Write + check (all ids; \`--merge\` resends only the failing ones):\n~~~sh\n${commands.write} <<'VERDICTS'\n{"verdicts":[{"id":"…","verdict":"trim","slopCheck":"…","duplicateCheck":"…","why":"…","coveredBy":[{"carrierId":"…","quote":"…"}],"trimPlan":"…"}]}\nVERDICTS\n~~~`);
  L.push('');
  if (parts.common) L.push(parts.common, '');
  L.push(`# Ids to hunt (${ids.length})`);
  ids.forEach((id, i) => {
    const v = stage1.get(id) || {};
    L.push('');
    L.push(`## ${i + 1}/${ids.length} \`${id}\``);
    L.push(parts.sections.get(id) || '(section missing from the stage-1 packet — read the JSON packet entry)');
    L.push('');
    L.push(`**Stage 1 ruled pristine-keep.** why: ${v.why || '—'}`);
    if (v.duplicateCheck) L.push(`duplicateCheck: ${v.duplicateCheck}`);
    if (v.slopCheck) L.push(`slopCheck: ${v.slopCheck}`);
    const leads = leadsById.get(id) || [];
    L.push(leads.length ? '**Cut leads:**' : '**Cut leads:** none in the packet evidence; hunt from the body, the slop check and the corpus search.');
    for (const l of leads) L.push(leadLine(l, toolStatus));
  });
  L.push('');
  const all = new Map([...parts.carriers, ...extraCarriers]);
  L.push(`# Carriers (${all.size}, each once; deployed text as it renders, un-escaped)`);
  for (const [id, body] of all) L.push('', `### \`${id}\``, body);
  return L.join('\n') + '\n';
}

function main() {
  const [packetDirArg, huntDirArg] = pos;
  if (!packetDirArg || !huntDirArg) {
    console.error('usage: selectCutHunt.mjs <stage1 packetDir> <huntDir> [--ids-per-agent N]');
    process.exit(2);
  }
  for (const gone of ['share', 'family-cap', 'group-size', 'md-bytes']) {
    if (argv.includes(`--${gone}`)) {
      console.error(`selectCutHunt: --${gone} is gone — every stage-1 keep is hunted and a packet larger than one Read is split into part files; size the fan-out with --ids-per-agent N (default ${IDS_PER_AGENT}).`);
      process.exit(2);
    }
  }
  const packetDir = path.resolve(packetDirArg);
  const huntDir = path.resolve(huntDirArg);
  const idsPerAgent = Number(opt('ids-per-agent', String(IDS_PER_AGENT)));
  if (!(Number.isInteger(idsPerAgent) && idsPerAgent > 0)) {
    console.error('selectCutHunt: --ids-per-agent must be a positive integer');
    process.exit(2);
  }
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const man = JSON.parse(fs.readFileSync(path.join(packetDir, 'audit-manifest.json'), 'utf8'));
  const resultPath = path.join(packetDir, 'stage1-result.json');
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  if (!result.complete) console.warn('selectCutHunt: stage1-result.json is not complete; hunting over what it holds');
  const stage1 = new Map(result.verdicts.map(v => [v.id, v]));
  const c = man.corpus;
  const { index } = openIndex({ catalogue: c.catalogue, activeSet: c.activeSet, remindersDir: c.remindersDir || null, bundle: c.bundle || null, cachePath: c.index || null });
  // Tool-carrier marks from the capture the stage-1 build used (its carriers
  // already carry them; the extra lead carriers and lead lines get them here).
  let capture = null;
  try { capture = man.capture && man.capture.dir ? capturedTools(man.capture.dir) : null; } catch { capture = null; }
  if (!capture) console.warn('selectCutHunt: the stage-1 manifest names no turnProbe capture — tool carriers are unmarked');
  const names = new Map();
  if (capture) for (const p of JSON.parse(fs.readFileSync(c.catalogue, 'utf8')).prompts || []) if (p.id && !names.has(p.id)) names.set(p.id, p.name || '');
  const toolStatus = makeToolStatus(capture, id => names.get(id) || '', id => { const i = index.byId.get(id); return i === undefined ? [] : [index.docs[i].body || '']; });

  const rows = [];
  const entry = new Map();
  for (const g of man.groups) {
    const p = JSON.parse(fs.readFileSync(g.packet, 'utf8'));
    for (const pr of p.prompts) {
      entry.set(pr.id, { pr, group: g, packet: p });
      if ((stage1.get(pr.id) || {}).verdict !== 'pristine-keep') continue;
      const leads = cutLeads(index, pr);
      rows.push({ id: pr.id, score: leadScore(leads), leads });
    }
  }
  const leadsById = new Map(rows.map(r => [r.id, r.leads]));
  // Packet order keeps an id next to the ids that share its carriers.
  const keepSet = new Set(rows.map(r => r.id));
  const order = [...entry.keys()].filter(id => keepSet.has(id));
  const partBytes = partByteCap();

  fs.mkdirSync(huntDir, { recursive: true });
  for (const f of fs.readdirSync(huntDir)) if (/^(hunt-packet|verdicts|search)-\d+\.(json|md|out\.json)$|^hunt-packet-\d+\.part\d+\.md$|^hunt-(manifest|selection|report)\.json$|^stage1-result\.json$/.test(f)) fs.unlinkSync(path.join(huntDir, f));
  const mdCache = new Map();
  const pathsFor = nn => ({
    packetPath: path.join(huntDir, `hunt-packet-${nn}.json`),
    mdPath: path.join(huntDir, `hunt-packet-${nn}.md`),
    verdictsFile: path.join(huntDir, `verdicts-${nn}.json`),
    queries: path.join(huntDir, `search-${nn}.json`),
  });
  const commandsFor = (nn, P) => ({
    search: `node ${repoDir}/tools/auditCorpusSearch.mjs --packet ${P.packetPath} --in ${P.queries} --out ${path.join(huntDir, `search-${nn}.out.json`)} --text`,
    check: `node ${repoDir}/tools/checkAuditVerdicts.mjs ${P.packetPath} ${P.verdictsFile}`,
    write: `node ${repoDir}/tools/writeAuditVerdicts.mjs ${P.packetPath}`,
    query: `node ${repoDir}/tools/bundleQuery.mjs --cli ${c.bundle} --catalogue ${c.catalogue}`,
  });
  const buildMd = (ids, nn, name) => {
    const P = pathsFor(nn);
    const commands = commandsFor(nn, P);
    const parts = { common: '', sections: new Map(), carriers: new Map() };
    for (const id of ids) {
      const src = entry.get(id).group.md;
      if (!mdCache.has(src)) mdCache.set(src, splitStageMd(fs.readFileSync(src, 'utf8')));
      const s = mdCache.get(src);
      if (!parts.common) parts.common = s.common;
      parts.sections.set(id, s.sections.get(id));
      for (const [k, v] of s.carriers) {
        if (!parts.carriers.has(k) && (s.sections.get(id) || '').includes(`\`${k}\``)) parts.carriers.set(k, v);
      }
    }
    const extraCarriers = new Map();
    for (const id of ids) {
      for (const l of leadsById.get(id) || []) {
        if (parts.carriers.has(l.carrier) || extraCarriers.has(l.carrier)) continue;
        const r = resolveCarrier(index, l.carrier);
        if (!r) continue;
        const d = r.doc;
        const state = d.suppressed ? 'SUPPRESSED (renders nothing)' : d.shadowedBy && d.shadowedBy.length ? `SHADOWED by ${d.shadowedBy.join(', ')}` : 'live';
        const body = d.body.length > 1500 ? `${d.body.slice(0, 1500)}\n… (${d.body.length - 1500} more chars: ${d.path || 'catalogue pristine'})` : d.body;
        const ts = toolStatus(l.carrier);
        extraCarriers.set(l.carrier, `${state} · ${d.path || 'catalogue pristine (no override)'}${ts ? ` · ${TOOL_STATUS_NOTE[ts]}` : ''}\ndeployed text (${d.body.length} chars):\n${fence(body)}`);
      }
    }
    return { P, commands, md: renderHuntMd({ group: name, version: man.version, ids, stage1, leadsById, parts, commands: { ...commands, queries: P.queries }, extraCarriers, toolStatus }) };
  };
  // ceil(keeps / idsPerAgent) groups in packet order, cut where the rendered
  // sizes even out; an id weighs its one-id packet less the shared header.
  const empty = Buffer.byteLength(buildMd([], '00', 'h00').md);
  const weight = new Map(order.map(id => [id, Buffer.byteLength(buildMd([id], '00', 'h00').md) - empty]));
  const groups = order.length ? partitionContiguous(order, agentsFor(order.length, idsPerAgent), id => weight.get(id)) : [];
  const width = Math.max(2, String(groups.length - 1).length);
  const manGroups = [];
  groups.forEach((ids, gi) => {
    const nn = String(gi).padStart(width, '0');
    const name = `h${nn}`;
    const { P, commands, md } = buildMd(ids, nn, name);
    const first = entry.get(ids[0]).packet;
    const { prompts: _p, md: _m, ...head } = first;
    void _p;
    void _m;
    const mdParts = writeMarkdownParts(P.mdPath, md, { maxBytes: partBytes });
    const packet = { ...head, group: name, md: P.mdPath, mdParts, verdictsFile: P.verdictsFile, commands, hunt: { stage1Result: resultPath }, prompts: ids.map(id => entry.get(id).pr) };
    fs.writeFileSync(P.packetPath, JSON.stringify(packet, null, 1));
    manGroups.push({ name, packet: P.packetPath, md: P.mdPath, mdParts, mdBytes: Buffer.byteLength(md), verdicts: P.verdictsFile, queries: P.queries, ids });
  });
  fs.writeFileSync(path.join(huntDir, 'hunt-selection.json'), JSON.stringify({ keeps: rows.length, hunted: order.length, withLead: rows.filter(r => r.score > 0).length, rows: rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)) }, null, 1));
  const manifest = { format: 1, version: man.version, stage1Result: resultPath, stage1PacketDir: packetDir, corpus: c, keeps: rows.length, selected: order.length, packing: { idsPerAgent, agents: groups.length, partBytes }, groupCount: groups.length, groups: manGroups };
  fs.writeFileSync(path.join(huntDir, 'hunt-manifest.json'), JSON.stringify(manifest, null, 1));
  const sizes = manGroups.map(g => g.mdBytes);
  const partCounts = manGroups.map(g => g.mdParts.length);
  const perGroup = groups.map(g => g.length);
  console.log(`cut hunt ${man.version}: all ${order.length} keep(s) hunted (${rows.filter(r => r.score > 0).length} with a cut lead) in ${groups.length} group(s) at ${idsPerAgent} per agent (${groups.length ? `${Math.min(...perGroup)}–${Math.max(...perGroup)}` : 0} ids each); md ${sizes.length ? `${Math.min(...sizes)}–${Math.max(...sizes)}` : 0} bytes, ${partCounts.reduce((a, b) => a + b, 0)} part file(s) of ≤${partBytes} B -> ${huntDir}`);
  // model and effort have no default: the caller adds them.
  console.log(`workflow args: ${JSON.stringify({ version: man.version, huntDir, groupCount: groups.length, mdParts: partCounts, activeSet: c.activeSet, repoDir, ...(c.remindersDir ? { remindersDir: c.remindersDir } : {}) })}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
