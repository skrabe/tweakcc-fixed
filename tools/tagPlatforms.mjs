#!/usr/bin/env node
// Tag catalogue prompts that only some platform builds carry.
//
// The catalogue is extracted from the darwin binary. Anthropic ships the macOS
// computer-use tool family in that binary ONLY — on CC 2.1.258 that was 566
// prompts the Linux boxes could never find, and every `--apply` there printed
// 566 "Could not find" warnings that read exactly like regex drift. A Mac can
// not see this: the darwin bundle matches every darwin-extracted regex by
// construction (memory: platform-specific-catalogue-entries).
//
// For each `<platform>=<pristine cli.js>` given, this runs the real apply
// (tools/applySafetyHarness.mjs, sandboxed, the active set) against that
// bundle, reads the names it could not find, and records on each such prompt
// the list of platforms whose build DOES carry it. The apply then skips a
// prompt quietly on a platform outside that list. A prompt every bundle
// carries gets no tag.
//
//   node tools/tagPlatforms.mjs <prompts.json> darwin=/tmp/cli-X.Y.Z.js linux=/tmp/cli-remote-X.Y.Z.js …
//
// Node `process.platform` values are the keys (darwin, linux, win32). Two
// bundles of the same platform (linux-x64 and linux-arm64) both map to `linux`;
// a prompt missing from either is treated as missing from the platform.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [jsonPath, ...specs] = process.argv.slice(2);
if (!jsonPath || specs.length === 0) {
  console.error('usage: tagPlatforms.mjs <prompts.json> <platform>=<cli.js> …');
  process.exit(2);
}
const bundles = specs.map(s => {
  const i = s.indexOf('=');
  if (i === -1) {
    console.error(`bad spec ${s}: want <platform>=<path>`);
    process.exit(2);
  }
  return { platform: s.slice(0, i), file: s.slice(i + 1) };
});
for (const b of bundles) {
  if (!fs.existsSync(b.file)) {
    console.error(`missing bundle ${b.file}`);
    process.exit(2);
  }
}

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const platforms = [...new Set(bundles.map(b => b.platform))];

// name -> set of platforms that could not find it
const missing = new Map();
for (const b of bundles) {
  let out = '';
  try {
    out = execFileSync('node', [path.join(REPO, 'tools', 'applySafetyHarness.mjs'), b.file], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  const names = new Set();
  for (const m of out.matchAll(/Could not find system prompt "([^"]+)" in cli\.js/g)) names.add(m[1]);
  console.log(`${b.platform} (${path.basename(b.file)}): ${names.size} prompt name(s) not found`);
  for (const n of names) {
    if (!missing.has(n)) missing.set(n, new Set());
    missing.get(n).add(b.platform);
  }
}

let tagged = 0;
let cleared = 0;
for (const p of data.prompts) {
  const miss = missing.get(p.name);
  const carried = platforms.filter(pl => !miss || !miss.has(pl));
  if (miss && carried.length < platforms.length) {
    if (carried.length === 0) {
      // Not found anywhere we looked — genuine drift, not a platform split.
      // Leave untagged so the apply keeps warning about it.
      continue;
    }
    const next = carried.sort();
    if (JSON.stringify(p.platforms ?? null) !== JSON.stringify(next)) tagged++;
    p.platforms = next;
  } else if (p.platforms) {
    delete p.platforms;
    cleared++;
  }
}
fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');
const total = data.prompts.filter(p => p.platforms).length;
console.log(`platforms: ${total} prompt(s) tagged as platform-specific (${tagged} changed, ${cleared} cleared)`);
