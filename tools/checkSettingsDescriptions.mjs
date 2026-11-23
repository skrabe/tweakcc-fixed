#!/usr/bin/env node
// Gate: every description in Claude Code's settings JSON schema is found by
// the structural finder and catalogued under a name.
//
// The model reads the whole schema (/update-config, settings validation
// errors), so its descriptions are model-facing. Three checks:
//   1. finder vs oracle, both directions. The oracle is what a pristine CC
//      actually sent (tools/captureSettingsOracle.mjs). A description only
//      behind an env-gated spread is reported, not failed.
//   2. every fragment the finder marks safe is a NAMED catalogue entry.
//   3. fragments that are not safe to override (their text also matches
//      elsewhere in the bundle) are listed; they stay uncatalogued.
//
//   node tools/checkSettingsDescriptions.mjs <cli.js> <prompts.json> [--oracle <file>]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findSettingsDescriptions,
  buildSettingsIndex,
  matchesRendered,
  decodeEscapes,
} = require('./lib/settingsSchema.cjs');

const args = process.argv.slice(2);
const oracleIdx = args.indexOf('--oracle');
const oracleArg = oracleIdx >= 0 ? args[oracleIdx + 1] : null;
const [cliPath, jsonPath] = args.filter(
  (a, i) => !a.startsWith('--') && (oracleIdx < 0 || i !== oracleIdx + 1)
);
if (!cliPath || !jsonPath) {
  console.error(
    'usage: checkSettingsDescriptions.mjs <cli.js> <prompts.json> [--oracle <file>]'
  );
  process.exit(2);
}

const catalogue = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const version =
  catalogue.version ||
  (path.basename(jsonPath).match(/(\d+\.\d+\.\d+)/) || [])[1];
const oraclePath =
  oracleArg ||
  path.join(
    import.meta.dirname,
    '..',
    'data',
    'settings-descriptions',
    `oracle-${version}.json`
  );
if (!fs.existsSync(oraclePath)) {
  console.error(
    `settings descriptions: no oracle at ${oraclePath}; capture one with tools/captureSettingsOracle.mjs`
  );
  process.exit(2);
}
const oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8')).descriptions;

const code = fs.readFileSync(cliPath, 'utf8');
const found = findSettingsDescriptions(code);
if (!found.root) {
  console.error('settings descriptions: settings schema root not found');
  process.exit(1);
}
const index = buildSettingsIndex(code, found);

let failures = 0;
const missing = oracle.filter(
  s => !found.descriptions.some(d => matchesRendered(d, s))
);
const extra = found.descriptions.filter(
  d => !oracle.some(s => matchesRendered(d, s))
);
for (const s of missing) {
  failures++;
  console.log(`  MISSING  ${JSON.stringify(s.slice(0, 100))}`);
}
for (const d of extra) {
  if (d.gated) {
    console.log(`  gated    ${d.keyPath} (env-gated key, not in this oracle)`);
  } else {
    failures++;
    console.log(
      `  EXTRA    ${d.keyPath}: ${JSON.stringify(d.joined.slice(0, 80))}`
    );
  }
}

const bodies = catalogue.prompts
  .filter(p => p.id && p.name)
  .map(p =>
    decodeEscapes((p.pieces || []).filter(x => typeof x === 'string').join(''))
  );
const catalogued = f => {
  if (!f.quasis) return bodies.some(b => b === f.value);
  const probe = f.quasis.reduce((a, b) => (b.length > a.length ? b : a), '');
  return bodies.some(b => b.includes(probe));
};
let safe = 0;
let unsafe = 0;
for (const d of found.descriptions) {
  for (const f of d.fragments) {
    const entry = index.get(f.start);
    if (!entry.safe) {
      unsafe++;
      console.log(
        `  unsafe   ${d.keyPath}: matches ${entry.matches} site(s) for ${entry.sites}; not overridable`
      );
      continue;
    }
    safe++;
    if (!catalogued(f)) {
      failures++;
      console.log(
        `  UNCATALOGUED  ${d.keyPath}: ${JSON.stringify(f.value.slice(0, 80))}`
      );
    }
  }
}

const summary =
  `settings descriptions: ${found.descriptions.length} found, ` +
  `${oracle.length} in oracle, ${missing.length} missing, ` +
  `${extra.length} extra; ${safe} fragment(s) catalogued-safe, ${unsafe} unsafe`;
if (failures) {
  console.log(`${summary} — FAIL (${failures})`);
  process.exitCode = 1;
} else {
  console.log(`${summary} — PASS`);
}
