#!/usr/bin/env node
// Build the worklist and review packets for completing a parallel override set.
//
// An override set for a second model is a per-id JUDGMENT, not a mirror: an id
// the active set trims may be trimmed for a reason that holds for every model
// (a dropped few-shot example, a duplicated sentence) or for a reason that is
// about the model the active set targets (narration suppression, anti-laziness
// scaffolding, formatting nudges). The parity gates only compare files that
// exist in BOTH sets, so an id the active set edits and the target set has no
// file for is invisible to them — the target then applies pristine there. On
// CC 2.1.258 that was 1,594 of opus-5's 3,538 edits with no fable-5-1 file at
// all, while the user's model was Fable 5.1.
//
// For every id the active set edits (trim or suppression) that the target set
// has NO file for, this writes one packet per batch carrying, per id, the
// active override file verbatim and the pristine body with its slot names, so
// a reviewer can classify the edit as model-agnostic (MIRROR the active file)
// or model-sensitive (JUDGE against the target model's card).
//
//   node tools/parallelSetPackets.mjs <prompts.json> --active=<abs dir> --target=<abs dir> --out=<dir> [--batch=25]
//
// Writes <out>/missing-ids.txt, <out>/batch-NNN.md and <out>/args.json
// ({ batches: [{ file, ids }] }) for the classify workflow.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const jsonPath = argv.find(a => !a.startsWith('--'));
const opt = k => (argv.find(a => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const active = opt('active');
const target = opt('target');
const out = opt('out');
const batch = Number(opt('batch') || 25);
if (!jsonPath || !active || !target || !out) {
  console.error('usage: parallelSetPackets.mjs <prompts.json> --active=<dir> --target=<dir> --out=<dir> [--batch=N]');
  process.exit(2);
}

const prompts = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).prompts;
const byId = new Map();
for (const p of prompts) {
  if (!byId.has(p.id)) byId.set(p.id, []);
  byId.get(p.id).push(p);
}
const reconstruct = p => {
  const m = p.identifierMap || {};
  let s = '';
  p.pieces.forEach((pc, i) => {
    s += pc;
    if (i < p.identifiers.length) s += m[String(p.identifiers[i])] ?? `UNKNOWN_${p.identifiers[i]}`;
  });
  return s;
};
const stripFm = t => {
  if (!t.startsWith('<!--')) return t;
  const e = t.indexOf('-->');
  return e === -1 ? t : t.slice(e + 3).replace(/^\n/, '');
};

const missing = [];
for (const f of fs.readdirSync(active).sort()) {
  if (!f.endsWith('.md')) continue;
  const id = f.slice(0, -3);
  if (!byId.has(id)) continue;
  if (fs.existsSync(path.join(target, f))) continue;
  const body = stripFm(fs.readFileSync(path.join(active, f), 'utf8')).trim();
  const pristineBodies = byId.get(id).map(p => reconstruct(p).trim());
  if (pristineBodies.includes(body)) continue; // active keeps pristine → nothing to carry
  missing.push(id);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'missing-ids.txt'), missing.join('\n') + '\n');
const batches = [];
for (let i = 0; i < missing.length; i += batch) {
  const ids = missing.slice(i, i + batch);
  const n = String(batches.length).padStart(3, '0');
  const lines = [`# Parallel-set classification packet ${n} — ${ids.length} ids\n`];
  for (const id of ids) {
    const sites = byId.get(id);
    lines.push(`\n---\n\n## ${id}\n`);
    lines.push(`### ACTIVE override (${path.basename(active)}) — full file\n\n\`\`\`\n${fs.readFileSync(path.join(active, `${id}.md`), 'utf8')}\n\`\`\`\n`);
    sites.forEach((p, k) => {
      lines.push(`### PRISTINE${sites.length > 1 ? ` site ${k + 1}/${sites.length}` : ''} (${p.name})\n\n\`\`\`\n${reconstruct(p)}\n\`\`\`\n`);
    });
  }
  const file = path.join(out, `batch-${n}.md`);
  fs.writeFileSync(file, lines.join('\n'));
  batches.push({ file, ids });
}
fs.writeFileSync(path.join(out, 'args.json'), JSON.stringify({ batches }, null, 1));
console.log(`parallelSetPackets: ${missing.length} id(s) edited in ${path.basename(active)} with no file in ${path.basename(target)} → ${batches.length} packet(s) of ≤${batch} in ${out}`);
