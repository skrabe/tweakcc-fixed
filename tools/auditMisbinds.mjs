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

// Default to the newest committed prompts JSON. A hardcoded old version silently
// audits the wrong release (or skips entirely) long after that version is gone.
const latestCommittedVer = () => {
  const dir = 'data/prompts';
  const vers = fs
    .readdirSync(dir)
    .map((f) => /^prompts-(\d+\.\d+\.\d+)\.json$/.exec(f)?.[1])
    .filter(Boolean)
    .sort((a, b) => {
      const [x, y] = [a, b].map((v) => v.split('.').map(Number));
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
  return vers[vers.length - 1];
};

const VER = process.env.CC_VER || latestCommittedVer();
const ourJson = process.argv[2] || `data/prompts/prompts-${VER}.json`;
const upstreamJson = process.argv[3] || `/tmp/pieb-${VER}.json`;
const overridesDir =
  process.argv[4] ||
  `${process.env.HOME}/.tweakcc/lobotomized-claude-code/system-prompts-opus-4-8`;

const OURS = JSON.parse(fs.readFileSync(ourJson, 'utf8'));
// Upstream reference is required. On a box without the `upstream` remote (e.g. a
// VPS mirror) the dump is empty — skip loudly rather than crash with a raw
// JSON.parse stack. The audit runs during showtime on the Mac, which has upstream.
// A skip exits NON-ZERO: this is a showtime gate, and "did nothing" must never be
// mistaken for "found nothing" (exit 0 on skip read as a pass for three releases).
// Set TWEAKCC_ALLOW_MISBIND_SKIP=1 on boxes that legitimately have no upstream.
let PIEB;
try {
  const raw = fs.readFileSync(upstreamJson, 'utf8');
  if (!raw.trim()) throw new Error('file is empty');
  PIEB = JSON.parse(raw);
} catch (e) {
  const allowSkip = process.env.TWEAKCC_ALLOW_MISBIND_SKIP === '1';
  console.error(
    `mis-bind audit: SKIPPED — upstream reference '${upstreamJson}' missing/empty (${e.message}). ` +
      `Dump it first: git show upstream/prompts/${VER}:data/prompts/prompts-${VER}.json > ${upstreamJson}` +
      (allowSkip ? '' : ' (set TWEAKCC_ALLOW_MISBIND_SKIP=1 to treat a skip as non-fatal)')
  );
  process.exit(allowSkip ? 0 : 2);
}
// Upstream is the reference, not scripture. Where its map is verifiably wrong
// against the binary, tools/promptExtractor.js CURATED_IDENTIFIER_MAPS corrects
// ours on purpose, and this audit must not "restore" the bug. Every entry here
// needs the evidence recorded next to the correction in the extractor.
//
// tool-description-bash-git-commit-and-pr-creation-instructions: upstream rotates
// slots 7/8/9, so the LCC override's ${PR_GENERATED_WITH_CLAUDE_CODE} bound to a
// FUNCTION and the patcher rendered its source text into the Bash tool
// description. Verified against the pristine 2.1.206 cli.js.
const CURATED_DIVERGENCES = new Set([
  'tool-description-bash-git-commit-and-pr-creation-instructions',
]);

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
  if (CURATED_DIVERGENCES.has(id)) {
    console.log(`mis-bind audit: curated divergence from upstream — ${id}`);
    continue;
  }
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
