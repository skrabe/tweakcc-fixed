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
//   node tools/tagPlatforms.mjs <prompts.json> darwin=/tmp/cli-X.Y.Z.js linux=/tmp/cli-remote-X.Y.Z.js …
//
// Node `process.platform` values are the keys (darwin, linux, win32). Two
// bundles of the same platform (linux-x64 and linux-arm64) both map to `linux`;
// a prompt missing from either is treated as missing from the platform.
//
import fs from 'node:fs';
import { readBundle, scanInWorkers } from './checkBakedIdentifiers.mjs';

const usage = msg => {
  if (msg) console.error(`tagPlatforms: ${msg}`);
  console.error('usage: tagPlatforms.mjs <prompts.json> <platform>=<cli.js> …');
  process.exit(2);
};

let workerLimit = process.env.TWEAKCC_TAG_JOBS;
const args = process.argv.slice(2).filter(a => {
  if (!a.startsWith('--jobs=')) return !a.startsWith('--set=');
  workerLimit = a.slice('--jobs='.length);
  return false;
});
if (workerLimit !== undefined) {
  workerLimit = Number(workerLimit);
  if (!Number.isInteger(workerLimit) || workerLimit < 1)
    usage('bad --jobs: want a positive integer');
}
const [jsonPath, ...specArgs] = args;
if (!jsonPath || specArgs.length === 0) usage();
const specs = specArgs.map(s => {
  const i = s.indexOf('=');
  if (i <= 0) usage(`bad spec ${s}: want <platform>=<path>`);
  if (!['darwin', 'linux', 'win32'].includes(s.slice(0, i)))
    usage(`unknown platform ${s.slice(0, i)}`);
  return { platform: s.slice(0, i), file: s.slice(i + 1) };
});

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
for (const s of specs) {
  try {
    readBundle(s.file, s.platform);
  } catch (err) {
    usage(err.message);
  }
}

const perFile = await scanInWorkers(
  data.prompts,
  specs,
  workerLimit,
  'presence'
);
const SHORT_ENTRY_CHARS = 40;
const isShort = p =>
  Array.isArray(p.pieces) &&
  p.pieces.every(x => typeof x === 'string') &&
  p.pieces.join('').length < SHORT_ENTRY_CHARS;
const shortIdx = data.prompts.flatMap((p, i) => (isShort(p) ? [i] : []));
const bounded = await scanInWorkers(
  shortIdx.map(i => data.prompts[i]),
  specs,
  workerLimit,
  'bounded'
);
shortIdx.forEach((i, j) => {
  for (const s of specs) {
    const r = perFile.get(s.file)[i];
    if (r.error || !(r.count > 0)) continue;
    const b = bounded.get(s.file)[j];
    if (b.error) r.error = b.error;
    else r.count = b.count;
  }
});

const errors = [];
const missing = data.prompts.map((p, i) => {
  const miss = new Set();
  for (const s of specs) {
    const r = perFile.get(s.file)[i];
    if (r.error) errors.push(`${p.id || p.name || i} in ${s.file}: ${r.error}`);
    else if (r.count === 0) miss.add(s.platform);
  }
  return miss;
});
if (errors.length) {
  for (const e of errors) console.error(`tagPlatforms: ${e}`);
  console.error(
    `tagPlatforms: ${errors.length} entr(ies) could not be matched; not writing tags`
  );
  process.exit(2);
}

const platforms = [...new Set(specs.map(s => s.platform))];
for (const s of specs) {
  const n = missing.filter(m => m.has(s.platform)).length;
  console.log(`${s.platform} (${s.file}): ${n} entr(ies) not carried`);
}

let tagged = 0;
let cleared = 0;
data.prompts.forEach((p, i) => {
  const carried = platforms.filter(pl => !missing[i].has(pl)).sort();
  if (carried.length === 0) return;
  if (carried.length < platforms.length) {
    if (JSON.stringify(p.platforms ?? null) !== JSON.stringify(carried))
      tagged++;
    p.platforms = carried;
  } else if (p.platforms) {
    delete p.platforms;
    cleared++;
  }
});
fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');
const total = data.prompts.filter(p => p.platforms).length;
console.log(
  `platforms: ${total} prompt(s) tagged as platform-specific (${tagged} changed, ${cleared} cleared)`
);
