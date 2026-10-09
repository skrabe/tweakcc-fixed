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
//
// The per-bundle harness runs are independent (each applies into its own temp
// HOME), so they run concurrently: `--jobs=N` (or TWEAKCC_TAG_JOBS), default
// one per bundle up to what memory allows at ~3.5 GB peak each.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseOverrideArgs, appliedPromptsDir } = require('./lib/overrideSets.cjs');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS_PEAK_BYTES = 3.5 * 1024 ** 3;
let jobsArg = process.env.TWEAKCC_TAG_JOBS;
const argv = process.argv.slice(2).filter(a => {
  if (!a.startsWith('--jobs=')) return true;
  jobsArg = a.slice('--jobs='.length);
  return false;
});
const parsed = parseOverrideArgs(argv);
const [jsonPath, ...specs] = parsed.rest;
if (!jsonPath || specs.length === 0) {
  console.error('usage: tagPlatforms.mjs <prompts.json> <platform>=<cli.js> … [--jobs=N]');
  process.exit(2);
}
if (jobsArg !== undefined && !(Number.isInteger(Number(jobsArg)) && Number(jobsArg) >= 1)) {
  console.error(`bad --jobs ${jobsArg}: want a positive integer`);
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

let appliedSet = null;
try {
  appliedSet = fs.realpathSync(appliedPromptsDir());
} catch {
  appliedSet = null;
}

// Resolves to the harness stdout on success; on a non-zero exit (a bundle
// that misses prompts FAILs the harness) to stdout + stderr, as before.
const runHarness = b =>
  new Promise(resolve => {
    const harnessArgs = [path.join(REPO, 'tools', 'applySafetyHarness.mjs')];
    if (appliedSet) harnessArgs.push(`--set=${appliedSet}`);
    harnessArgs.push(b.file);
    execFile(
      'node',
      harnessArgs,
      { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) resolve(String(stdout ?? '') + String(stderr ?? ''));
        else {
          if (stderr) process.stderr.write(stderr);
          resolve(stdout);
        }
      }
    );
  });

const jobs = Math.min(
  bundles.length,
  jobsArg !== undefined
    ? Number(jobsArg)
    : Math.max(1, Math.floor(os.totalmem() / HARNESS_PEAK_BYTES) - 1)
);
// A harness whose apply did not run to completion lists only the prompts it
// reached, and reading that as "the rest were found" drops tags silently.
// Trust an output only with the completed-apply marker and a full listing.
const incompleteReason = out => {
  const ran = (out.match(/^apply ran:\s+(\S+)/m) || [])[1];
  const listed = (out.match(/^\s+.*Could not find/gm) || []).length;
  const reported = Number((out.match(/^Could not find:\s+(\d+)/m) || [])[1]);
  if (ran === 'true' && listed === reported) return null;
  return `apply ran: ${ran ?? 'missing'}, ${listed} listed vs ${Number.isNaN(reported) ? 'no' : reported} reported "Could not find"`;
};

const outputs = new Array(bundles.length);
let nextBundle = 0;
await Promise.all(
  Array.from({ length: jobs }, async () => {
    while (nextBundle < bundles.length) {
      const i = nextBundle++;
      outputs[i] = await runHarness(bundles[i]);
    }
  })
);

// An incomplete run gets one retry on its own, after the concurrent pass, so
// a transient failure under memory pressure costs a rerun rather than a tag.
for (const [i, b] of bundles.entries()) {
  const reason = incompleteReason(outputs[i]);
  if (!reason) continue;
  console.error(`tagPlatforms: harness on ${b.file} incomplete (${reason}); retrying alone`);
  outputs[i] = await runHarness(b);
  const again = incompleteReason(outputs[i]);
  if (again) {
    console.error(
      `tagPlatforms: harness on ${b.file} incomplete again (${again}); not writing tags.\n` +
        outputs[i].split('\n').slice(-40).join('\n')
    );
    process.exit(2);
  }
}

// name -> set of platforms that could not find it
const missing = new Map();
for (const [i, b] of bundles.entries()) {
  const out = outputs[i];
  const names = new Set();
  for (const m of out.matchAll(/Could not find system prompt "([^"]+)" in cli\.js/g)) names.add(m[1]);
  console.log(`${b.platform} (${path.basename(b.file)}): ${names.size} prompt name(s) not found`);
  for (const n of names) {
    if (!missing.has(n)) missing.set(n, new Set());
    missing.get(n).add(b.platform);
  }
}

// `applySafetyHarness` applies through the ACTIVE override set, so the name it
// prints is the OVERRIDE's front-matter `name:` — which drifts from the
// catalogue name, because `syncPrompt` never rewrites an existing file's header.
// Keying the lookup on `p.name` alone therefore silently skips those prompts:
// on CC 2.1.261 two darwin-only computer-use results stayed untagged that way and
// only the cross-platform gate caught them, one step before publishing. Map every
// override's front-matter name to its id as a second key.
const overrideNameToId = new Map();
try {
  const activeSet = appliedSet || fs.realpathSync(appliedPromptsDir());
  for (const f of fs.readdirSync(activeSet)) {
    if (!f.endsWith('.md')) continue;
    const head = fs.readFileSync(path.join(activeSet, f), 'utf8').slice(0, 4000);
    const m = /^name:\s*'?"?(.*?)'?"?\s*$/m.exec(head);
    if (m) overrideNameToId.set(m[1], f.slice(0, -3));
  }
} catch {
  /* no active set: the catalogue name is the only key we have */
}
const missingById = new Map();
for (const [n, plats] of missing) {
  const id = overrideNameToId.get(n);
  if (!id) continue;
  if (!missingById.has(id)) missingById.set(id, new Set());
  for (const pl of plats) missingById.get(id).add(pl);
}

let tagged = 0;
let cleared = 0;
for (const p of data.prompts) {
  const miss = missing.get(p.name) ?? missingById.get(p.id);
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
