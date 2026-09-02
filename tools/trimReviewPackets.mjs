#!/usr/bin/env node
// Build one review packet per checkTrimSlots / checkFactCoverage finding.
//
// A finding names an id and the runtime tokens (or API facts) its override
// lost. Ruling on it needs three things side by side: the pristine body with
// every slot shown by NAME in the exact syntactic form the binary uses
// (`${NAME}`, `${NAME()}`, `${NAME>1?…}`), and the deployed body of every
// maintained set. The 2026-09-02 review built these by hand and the ad-hoc
// script wrapped slot names twice (`${${NAME}}`) because the catalogue's
// pieces already carry the `${` and `}` — reviewers saw through it, but a
// reviewer should never have to. Fixed here, kept here.
//
//   node tools/trimReviewPackets.mjs <prompts.json> --findings=<checkTrimSlots --json output> \
//        --sets=<abs dir>[,<abs dir>…] --out=<dir> [--facts=<checkFactCoverage --json output>]
//
// Writes <out>/<id>.md per finding and <out>/BRIEF.md (the reviewer brief).
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const jsonPath = argv.find(a => !a.startsWith('--'));
const opt = k => (argv.find(a => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const findingsPath = opt('findings');
const factsPath = opt('facts');
const sets = opt('sets').split(',').filter(Boolean);
const out = opt('out');
if (!jsonPath || (!findingsPath && !factsPath) || !sets.length || !out) {
  console.error('usage: trimReviewPackets.mjs <prompts.json> (--findings=<json> | --facts=<json>) --sets=<dir,…> --out=<dir>');
  process.exit(2);
}

const prompts = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).prompts;
const byId = new Map();
for (const p of prompts) {
  if (!byId.has(p.id)) byId.set(p.id, []);
  byId.get(p.id).push(p);
}
// pieces[i] ends with `${`, pieces[i+1] begins with `}` (or with the rest of
// the expression: `()`, `>1?…`). Insert the bare NAME between them.
const reconstruct = p => {
  const m = p.identifierMap || {};
  let s = '';
  p.pieces.forEach((pc, i) => {
    s += pc;
    if (i < p.identifiers.length) s += m[String(p.identifiers[i])] ?? `UNKNOWN_${p.identifiers[i]}`;
  });
  return s;
};

const items = new Map(); // id -> [labels]
if (findingsPath)
  for (const f of JSON.parse(fs.readFileSync(findingsPath, 'utf8')))
    items.set(f.id, [...(items.get(f.id) || []), ...f.lost]);
if (factsPath)
  for (const f of JSON.parse(fs.readFileSync(factsPath, 'utf8')))
    items.set(f.id, [...(items.get(f.id) || []), ...f.uncovered.map(x => `API-FACT:${x}`)]);

fs.mkdirSync(out, { recursive: true });
for (const [id, lost] of items) {
  const sites = byId.get(id);
  if (!sites) { console.error(`trimReviewPackets: ${id} is not in the catalogue — skipped`); continue; }
  const lines = [`# REVIEW PACKET: ${id}\n`, `## Lost tokens (present in pristine, zero occurrences in the deployed body)\n${lost.map(t => `- ${t}`).join('\n')}\n`];
  sites.forEach((p, k) => {
    lines.push(`## PRISTINE site ${k + 1}/${sites.length} (name: ${p.name}; identifiers: ${JSON.stringify(p.identifiers)}; identifierMap: ${JSON.stringify(p.identifierMap || {})})\n\n\`\`\`\n${reconstruct(p)}\n\`\`\`\n`);
  });
  for (const dir of sets) {
    const f = path.join(dir, `${id}.md`);
    lines.push(`## DEPLOYED ${path.basename(dir)} override (${f})\n\n\`\`\`\n${fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '<NO FILE — applies as pristine>'}\n\`\`\`\n`);
  }
  fs.writeFileSync(path.join(out, `${id}.md`), lines.join('\n'));
}
fs.copyFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'trimReviewBrief.md'), path.join(out, 'BRIEF.md'));
console.log(`trimReviewPackets: ${items.size} packet(s) in ${out}`);
