// Inline-blob drift gate: `inline-*` overrides are not in the prompts JSON, so
// no bump realigns them, and an upstream edit to the literal one replaces is
// silently reverted (2026-11-05: 11 of 38 had drifted, some since 2.1.138).
//
// For each inline override in the active set, resolve the literal it replaces
// in the previous and the current pristine bundle through the real apply path
// and compare the two with minified names normalized away. A difference means
// Claude Code changed text the override replaces: realign that override.
//
//   pnpm exec tsx tools/checkInlineBlobDrift.mts <prev-cli.js> <cli.js> [--diff]
//
// Exit 0 = no drift, 1 = drifted or unresolvable blobs, 2 = usage error.
import fs from 'node:fs';
import { diffWords } from 'diff';
import { applyInlineBlobOverrides } from '../src/patches/inlineBlobOverrides';
import { SYSTEM_PROMPTS_DIR } from '../src/config';
import { normalizeLiteralNames } from './lib/normalizeLiteralNames.mjs';

const args = process.argv.slice(2);
const [prevPath, curPath] = args.filter(a => !a.startsWith('--'));
if (!prevPath || !curPath) {
  console.error(
    'usage: tsx tools/checkInlineBlobDrift.mts <prev-cli.js> <cli.js> [--diff]'
  );
  process.exit(2);
}
const showDiff = args.includes('--diff');
const log = console.log;

// Minified names differ between versions and platforms; prose must not.
const normalize = (text: string): string => normalizeLiteralNames(text);

const resolve = async (content: string, file: string) => {
  console.log = () => {};
  try {
    const { results } = await applyInlineBlobOverrides(content, {
      only: file,
    });
    const r = results[0];
    return r?.applied
      ? r.replaced!
      : `UNRESOLVED: ${r?.details ?? 'no result'}`;
  } finally {
    console.log = log;
  }
};

const prev = fs.readFileSync(prevPath, 'utf8');
const cur = fs.readFileSync(curPath, 'utf8');
const files = fs
  .readdirSync(SYSTEM_PROMPTS_DIR)
  .filter(n => n.startsWith('inline-') && n.endsWith('.md'))
  .sort();

const findings: string[] = [];
for (const file of files) {
  const before = await resolve(prev, file);
  const after = await resolve(cur, file);
  if (after.startsWith('UNRESOLVED')) {
    findings.push(`UNRESOLVED ${file}: ${after.slice(12)}`);
  } else if (before.startsWith('UNRESOLVED')) {
    findings.push(`NEW-SITE ${file}: does not resolve in the previous bundle`);
  } else if (normalize(before) !== normalize(after)) {
    findings.push(`DRIFT ${file}`);
    if (showDiff)
      for (const p of diffWords(normalize(before), normalize(after)))
        if (p.added || p.removed)
          findings.push(
            `    ${p.added ? '+' : '-'} ${p.value.trim().slice(0, 200)}`
          );
  }
}
for (const f of findings) log(f);
const bad = findings.filter(f => !f.startsWith(' ')).length;
log(
  `inline-blob drift: ${bad} of ${files.length} override(s) need a realign` +
    (bad ? ' (pristine text under them changed)' : '')
);
process.exit(bad ? 1 : 0);
