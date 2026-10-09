#!/usr/bin/env node
// Matcher/regex differential over a whole prompt catalogue, sharded across
// worker threads and cached by content (see tools/lib/matcherDifferential.mjs).
// The same check as `pnpm test:matcher`, which calls the same runner.
//
//   node tools/runMatcherDifferential.mjs <prompts.json> <bundle.js>[,<bundle2.js>…] [more bundles…]
//        [--workers N] [--no-cache] [--synthetic]
//
// Exit 0 = every prompt agrees on every bundle; 1 = a differential (mismatch,
// error, or too few prompts checked); 2 = usage or infrastructure failure.
// Cache dir: $TWEAKCC_MATCHER_CACHE, default ~/.cache/tweakcc-matcher.
import fs from 'node:fs';
import {
  defaultWorkerCount,
  runMatcherDifferential,
} from './lib/matcherDifferential.mjs';

const usage = () => {
  console.error(
    'usage: runMatcherDifferential.mjs <prompts.json> <bundle.js>[,<bundle2.js>…] [--workers N] [--no-cache] [--synthetic]'
  );
  process.exit(2);
};

const args = process.argv.slice(2);
let workers = defaultWorkerCount();
let cache = true;
let synthetic = false;
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--no-cache') cache = false;
  else if (a === '--synthetic') synthetic = true;
  else if (a === '--workers' || a.startsWith('--workers=')) {
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
    workers = Number(v);
    if (!Number.isInteger(workers) || workers < 1) usage();
  } else if (a.startsWith('--')) usage();
  else positional.push(a);
}
const [promptsFile, ...rest] = positional;
const bundles = rest.flatMap(s => s.split(',')).filter(Boolean);
if (!promptsFile || (bundles.length === 0 && !synthetic)) usage();
for (const f of [promptsFile, ...bundles]) {
  if (!fs.existsSync(f)) {
    console.error(`runMatcherDifferential: no such file: ${f}`);
    process.exit(2);
  }
}

try {
  const { ok } = await runMatcherDifferential({
    promptsFile,
    bundles,
    synthetic,
    workers,
    cache,
  });
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(`runMatcherDifferential: ${err?.stack || err}`);
  process.exit(2);
}
