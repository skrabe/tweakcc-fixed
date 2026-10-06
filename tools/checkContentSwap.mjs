#!/usr/bin/env node
// Content-swap gate: ids whose content moved between two catalogues while the
// id stayed put, and ids whose body changed under an unchanged version.
//
//   node tools/checkContentSwap.mjs <prev.json> <cur.json> [--sets=<dir,…>] [--allow=<id,…>]
//
// Every finding is an override keyed to the wrong content until it is
// re-mapped by CONTENT (move the trim to the id its old pristine now lives at)
// — a realign keyed by id overwrites the trim instead (CC 2.1.291:
// system-prompt-resume-continue-prompt-3's trim replaced by the old -2 body).
// --allow acknowledges ids already re-mapped. Exit 1 on any unacknowledged
// finding, 2 on bad input. Last line is the summary the driver parses.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { contentSwapSweep } from './lib/contentSwap.mjs';

const require = createRequire(import.meta.url);
const { parseOverrideArgs, resolveOverrideSets } = require(
  './lib/overrideSets.cjs'
);

const parsed = parseOverrideArgs(process.argv.slice(2));
const allowArg = parsed.rest.find(a => a.startsWith('--allow='));
const allow = new Set(
  (allowArg ? allowArg.slice('--allow='.length) : '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
const [prevPath, curPath] = parsed.rest.filter(a => !a.startsWith('--'));
if (!prevPath || !curPath) {
  console.error(
    'usage: checkContentSwap.mjs <prev.json> <cur.json> [--sets=<dir,…>] [--allow=<id,…>]'
  );
  process.exit(2);
}
const load = p => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).prompts || [];
  } catch (e) {
    console.error(`content swap: cannot read ${p}: ${e.message}`);
    process.exit(2);
  }
};
const sweep = contentSwapSweep(load(prevPath), load(curPath));
const setDirs = parsed.specified
  ? resolveOverrideSets(parsed, { fallback: 'none' }).map(s => s.dir)
  : [];

const ccVersionOf = file => {
  const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
  const end = head.indexOf('-->');
  const m = /^ccVersion:\s*(.*?)\s*$/m.exec(end > 0 ? head.slice(0, end) : head);
  return m ? m[1] : '?';
};
const overridesFor = ids => {
  const out = [];
  for (const dir of setDirs) {
    for (const id of ids) {
      const f = path.join(dir, `${id}.md`);
      if (fs.existsSync(f))
        out.push(`${path.basename(dir)}/${id}.md (ccVersion ${ccVersionOf(f)})`);
    }
  }
  return out;
};

let open = 0;
let acked = 0;
const report = (id, line, ids) => {
  const ok = allow.has(id);
  if (ok) acked += 1;
  else open += 1;
  console.log(`${ok ? 'acknowledged' : 'CONTENT SWAP'}  ${line}`);
  const ov = overridesFor(ids);
  if (setDirs.length)
    console.log(`    overrides: ${ov.length ? ov.join(', ') : 'none (pristine renders)'}`);
};
for (const s of sweep.swaps) {
  report(
    s.id,
    `${s.id} <- ${s.from.join(', ')}'s previous body (${s.moved ? 'moved' : 'shared: still at the old id too'}${s.newId ? ', new id' : ''}, ${s.chars} chars)`,
    [s.id, ...s.from]
  );
}
for (const v of sweep.versionStale) {
  report(
    v.id,
    `${v.id}: body changed, version unchanged (${v.versions.join(', ')})`,
    [v.id]
  );
}
if (open) {
  console.log(
    'Re-map each override by CONTENT before any realign (move the trim to the id its old pristine now lives at, ccVersion to that id\'s version), then acknowledge the ids with --allow.'
  );
}
console.log(
  `content swap: ${sweep.swaps.length} swapped id(s), ${sweep.versionStale.length} body-changed/version-unchanged, ${open} unacknowledged, ${acked} acknowledged — ${open ? 'FAIL' : 'PASS'}`
);
process.exit(open ? 1 : 0);
