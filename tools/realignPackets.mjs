#!/usr/bin/env node
// Build one realignment packet per conflicted override id.
//
// `--apply` reports `Conflicts detected for N system prompt file(s)`: the
// pristine an override was trimmed against has moved. Ruling on one needs four
// things side by side — the OLD pristine, the NEW pristine, the exact old->new
// change, and every maintained set's current deployed body — with slots shown by
// NAME in the syntactic form the binary uses (`${NAME}`, `${NAME()}`,
// `${NAME.x}`), because a call slot written as a bare value silently
// interpolates the function object.
//
// `.claude/workflows/realign-conflicts.workflow.js` requires `task.packet`, and
// until now nothing produced one, so every bump hand-rolled the packets and the
// 2026-09-04 run rebuilt the pieces-reconstruction from scratch (a hand-rolled
// version gets the map key and the already-present `${`/`}` wrong, which makes a
// faithful trim read as "grew"). This is that builder, kept.
//
//   node tools/realignPackets.mjs <prev.json> <cur.json> \
//        --ids=a,b,c            (or --ids=@<file with one id per line>)
//        --sets=<abs dir>[,<abs dir>…] --out=<dir> [--allow-moved=<id,…>]
//
// Writes <out>/<id>.md per id and <out>/tasks.json — the `tasks` array the
// workflow takes verbatim.
//
// Refuses (writes nothing, exit 1) when any requested id's content moved
// (tools/lib/contentSwap.mjs): its old pristine now lives at another id, or it
// now holds another id's old pristine. A realign keyed by id then grafts the
// new occupant's pristine over a trim of something else — CC 2.1.291 lost the
// system-prompt-resume-continue-prompt-3 trim that way. Re-map those overrides
// by content first, then pass their ids in --allow-moved.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { contentSwapSweep, realignHazard } from './lib/contentSwap.mjs';

const require = createRequire(import.meta.url);
const {
  parseOverrideArgs,
  resolveOverrideSets,
  printAuditedSets,
} = require('./lib/overrideSets.cjs');

const parsed = parseOverrideArgs(process.argv.slice(2));
const argv = parsed.rest;
const positional = argv.filter(a => !a.startsWith('--'));
const opt = k => {
  const hit = argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : '';
};
const [prevPath, curPath] = positional;
const outDir = opt('out');
let ids = opt('ids');
if (ids.startsWith('@')) {
  ids = fs
    .readFileSync(ids.slice(1), 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .join(',');
}
const idList = ids.split(',').filter(Boolean);
const allowMoved = new Set(opt('allow-moved').split(',').filter(Boolean));

if (!prevPath || !curPath || !idList.length || !parsed.specified || !outDir) {
  console.error(
    'usage: realignPackets.mjs <prev.json> <cur.json> --ids=<a,b|@file> --sets=<dir,…> --out=<dir>'
  );
  process.exit(2);
}
const resolved = resolveOverrideSets(parsed, { fallback: 'none' });
printAuditedSets(resolved);
const setDirs = resolved.map(s => s.dir);

const promptsOf = new Map();
const load = p => {
  const byId = new Map();
  const prompts = JSON.parse(fs.readFileSync(p, 'utf8')).prompts;
  promptsOf.set(p, prompts);
  for (const entry of prompts) {
    if (!entry.id) continue;
    if (!byId.has(entry.id)) byId.set(entry.id, []);
    byId.get(entry.id).push(entry);
  }
  return byId;
};

// The canonical reconstruction (src/systemPromptSync.ts). The `${` and `}` are
// ALREADY in the pieces, so append the BARE label between them, and key the map
// by `identifiers[i]`, never by `i`.
const reconstruct = entry => {
  const pieces = entry.pieces || [];
  if (!pieces.length) return entry.content || '';
  const identifiers = entry.identifiers || [];
  const map = entry.identifierMap || {};
  const out = [];
  for (let i = 0; i < pieces.length; i += 1) {
    out.push(typeof pieces[i] === 'string' ? pieces[i] : '');
    if (i < pieces.length - 1) {
      const key = String(identifiers[i] ?? i);
      out.push(map[key] ?? map[String(i)] ?? `UNKNOWN_${i}`);
    }
  }
  return out.join('');
};

const stripFrontMatter = text => {
  const m = /^<!--[\s\S]*?-->\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
};

const prev = load(prevPath);
const cur = load(curPath);

const sweep = contentSwapSweep(promptsOf.get(prevPath), promptsOf.get(curPath));
const refused = idList
  .map(id => [id, realignHazard(sweep, id)])
  .filter(([id, why]) => why && !allowMoved.has(id));
if (refused.length) {
  for (const [id, why] of refused) {
    console.error(`REFUSED ${id}: ${why}`);
  }
  console.error(
    `\n${refused.length} realign task(s) refused: the override was trimmed against content that moved to another id. ` +
      'Re-map each by CONTENT (move the trim to the id its old pristine now lives at; tools/checkContentSwap.mjs lists them), ' +
      'then rerun with --allow-moved=<id,…>. Nothing was written.'
  );
  // A tasks.json left by an earlier run must not survive to be launched.
  fs.rmSync(path.join(outDir, 'tasks.json'), { force: true });
  process.exit(1);
}
for (const id of idList) {
  const why = realignHazard(sweep, id);
  if (why) console.log(`allowed (content moved, re-mapped): ${id}: ${why}`);
}
fs.mkdirSync(outDir, { recursive: true });

const tasks = [];
for (const id of idList) {
  const prevEntries = prev.get(id) || [];
  const curEntries = cur.get(id) || [];
  if (!curEntries.length) {
    console.error(`skip ${id}: absent from ${path.basename(curPath)}`);
    continue;
  }
  const oldBody = prevEntries.length ? reconstruct(prevEntries[0]) : '';
  const newBody = reconstruct(curEntries[0]);
  const version = curEntries[0].version ?? null;

  const lines = [];
  lines.push(`# Realignment packet — \`${id}\``);
  lines.push('');
  lines.push(`- target \`ccVersion:\` **${version}** (the prompt's own catalogue version,`);
  lines.push('  NOT the CC release; a ccVersion above it is reported as a conflict and the');
  lines.push('  site is left pristine)');
  lines.push(`- sites in the new catalogue: ${curEntries.length}`);
  lines.push(`- pristine ${oldBody.length} -> ${newBody.length} chars`);
  lines.push('');
  lines.push('## OLD pristine (what each override was trimmed against)');
  lines.push('');
  lines.push('```');
  lines.push(oldBody);
  lines.push('```');
  lines.push('');
  lines.push('## NEW pristine (what the override must now convey)');
  lines.push('');
  lines.push('```');
  lines.push(newBody);
  lines.push('```');
  lines.push('');

  const paths = [];
  for (const dir of setDirs) {
    const file = path.join(dir, `${id}.md`);
    const setName = path.basename(dir);
    lines.push(`## Current deployed body — ${setName}`);
    lines.push('');
    if (!fs.existsSync(file)) {
      lines.push('_No file: this set applies PRISTINE for this id. Nothing to write._');
      lines.push('');
      continue;
    }
    paths.push(file);
    const body = stripFrontMatter(fs.readFileSync(file, 'utf8'));
    const kind =
      body.trim() === ''
        ? 'EMPTY BODY = DELIBERATE SUPPRESSION. Bump ccVersion only; write nothing else.'
        : `${body.length} chars against ${newBody.length} of pristine` +
          (body.length * 2 < newBody.length
            ? ' — a DELIBERATE DEEP TRIM. Realign in place; never regrow toward pristine.'
            : '');
    lines.push(`\`${file}\``);
    lines.push('');
    lines.push(kind);
    lines.push('');
    lines.push('```');
    lines.push(body);
    lines.push('```');
    lines.push('');
  }

  const packet = path.join(outDir, `${id}.md`);
  fs.writeFileSync(packet, `${lines.join('\n')}\n`);
  tasks.push({ id, packet, version: version === null ? undefined : String(version), paths });
  console.log(`${id}  ->  ${packet}  (${paths.length} path(s), ccVersion ${version})`);
}

const tasksPath = path.join(outDir, 'tasks.json');
fs.writeFileSync(tasksPath, `${JSON.stringify(tasks, null, 1)}\n`);
console.log(`\n${tasks.length} task(s) -> ${tasksPath}`);
