#!/usr/bin/env node
// Mis-bind audit — the prevention gate for the "override resolves to a wrong-but-
// valid var" bug class (silent sibling of the ReferenceError / slot-shift classes;
// see AGENTS.md bug-classes). For every override, every placeholder it USES must
// sit at the same identifierMap slot as upstream's authoritative complete map. A
// name at a different slot => the patcher captures the wrong var at apply time =>
// wrong content, no crash, invisible to four-zeros + smoke. Run during showtime
// after extracting the prompts JSON; exits non-zero if any mis-bind is found.
//
// Usage:
//   git show upstream/main:data/prompts/prompts-<ver>.json > /tmp/pieb-<ver>.json
//   node tools/auditMisbinds.mjs [ourJson] [upstreamJson] [overridesDir]
// Defaults target the local showtime layout.
import fs from 'node:fs';
import path from 'node:path';

const VER = process.env.CC_VER || '2.1.168';
const ourJson = process.argv[2] || `data/prompts/prompts-${VER}.json`;
const upstreamJson = process.argv[3] || `/tmp/pieb-${VER}.json`;
const overridesDir =
  process.argv[4] ||
  `${process.env.HOME}/.tweakcc/lobotomized-claude-code/system-prompts-opus-4-8`;

const OURS = JSON.parse(fs.readFileSync(ourJson, 'utf8'));
const PIEB = JSON.parse(fs.readFileSync(upstreamJson, 'utf8'));
const invert = m => {
  const r = {};
  if (m) for (const [s, n] of Object.entries(m)) r[n] = s;
  return r;
};
const byId = d => {
  const m = {};
  for (const p of d.prompts) if (p.id) m[p.id] = p;
  return m;
};
const O = byId(OURS),
  P = byId(PIEB);

const misbinds = [];
for (const f of fs.readdirSync(overridesDir)) {
  if (!f.endsWith('.md')) continue;
  const id = f.slice(0, -3);
  // inline-* overrides remap minified idents positionally, not by identifierMap.
  if (id.startsWith('inline-')) continue;
  const raw = fs.readFileSync(path.join(overridesDir, f), 'utf8');
  const body = (raw.match(/^<!--[\s\S]*?-->\n?([\s\S]*)$/) || [, raw])[1];
  const used = new Set(
    [...body.matchAll(/(?<!\\)\$\{([A-Z][A-Z0-9_]+)/g)].map(m => m[1])
  );
  if (!used.size || !P[id]) continue; // can only audit prompts upstream also has
  const our = invert(O[id]?.identifierMap);
  const pieb = invert(P[id]?.identifierMap);
  for (const name of used) {
    const so = our[name],
      sp = pieb[name];
    if (so === undefined || sp === undefined) continue; // leak/uncomparable: other gates cover it
    if (so !== sp)
      misbinds.push(`${id}: \${${name}} ours=slot${so} upstream=slot${sp}`);
  }
}

if (misbinds.length) {
  console.error(`MIS-BINDS: ${misbinds.length} (override placeholder at wrong slot)`);
  for (const m of misbinds) console.error('  ' + m);
  console.error(
    '\nFix: adopt upstream’s identifierMap for the prompt (identifiers array must match first), or hand-name the slot. See AGENTS.md bug-classes.'
  );
  process.exit(1);
}
console.log('mis-bind audit: 0 (every used placeholder sits at the upstream slot)');
