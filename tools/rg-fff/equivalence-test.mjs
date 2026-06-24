#!/usr/bin/env node
// Local/manual equivalence harness for the rg-fff wrapper. NOT a unit test (it
// needs the built wrapper + a Claude Code binary with embedded ripgrep), so it
// lives here rather than in vitest. Run after `cargo build --release`:
//
//   node tools/rg-fff/equivalence-test.mjs
//
// It proves: (A) the swap patch transform is parse-neutral on the real cli.js
// backup (if present), and (B) the wrapper's result SET equals ripgrep's across
// every routing case (exact incl. keywords, -l, count->rg, --type->rg, -U->rg,
// single-file->rg, short->rg, regex->rg, glob translation, fuzzy, exit codes).
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SRC = path.join(REPO, 'src');
const ORIG = path.join(os.homedir(), '.tweakcc', 'native-claudejs-orig.js');

let CLAUDE = null;
try {
  CLAUDE = execFileSync('readlink', ['-f', path.join(os.homedir(), '.local/bin/claude')]).toString().trim();
} catch { /* not installed via the native installer */ }
if (!CLAUDE || !existsSync(CLAUDE)) {
  try { CLAUDE = execFileSync('which', ['rg']).toString().trim(); } catch { /* */ }
}
const WRAPPER = existsSync(path.join(HERE, 'target/release/rg-fff'))
  ? path.join(HERE, 'target/release/rg-fff')
  : path.join(HERE, 'target/debug/rg-fff');
if (!existsSync(WRAPPER)) { console.error('build first: cargo build --release'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (n, c) => { console.log(`${c ? '✅' : '❌'} ${n}`); if (c) pass++; else fail++; };
const rgArgv0 = CLAUDE && CLAUDE.endsWith('rg') ? null : 'rg';
function rg(args, cwd) {
  const r = spawnSync(CLAUDE, ['--no-config', ...args], { argv0: rgArgv0 ?? undefined, cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  return { status: r.status, out: r.stdout || '' };
}
function wrap(args, cwd) {
  const r = spawnSync(WRAPPER, [`--fff-claude-bin=${CLAUDE}`, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  return { status: r.status, out: r.stdout || '' };
}
const norm = s => s.split('\n').filter(Boolean).map(l => l.replace(/^\.\//, '')).sort();
const keyset = s => [...new Set(norm(s).map(l => l.split(':').slice(0, 2).join(':')))].sort();
const eqSet = (a, b) => { const A = keyset(a), B = keyset(b); return A.length === B.length && A.every((x, i) => x === B[i]); };

if (existsSync(ORIG)) {
  console.log('=== PART A: patch transform parse-neutrality on real cli.js ===');
  const orig = readFileSync(ORIG, 'utf8');
  const DESC = '{mode:"embedded",command:process.execPath,args:["--no-config"],argv0:"rg"}';
  ok(`embedded descriptor unique (got ${orig.split(DESC).length - 1})`, orig.split(DESC).length - 1 === 1);
  const repl = `{mode:"system",command:${JSON.stringify('/tmp/rg-fff')},args:["--fff-claude-bin="+process.execPath]}`;
  const patched = orig.replace(DESC, repl);
  const tmpO = path.join(os.tmpdir(), 'cli-o.js'), tmpP = path.join(os.tmpdir(), 'cli-p.js');
  writeFileSync(tmpO, orig); writeFileSync(tmpP, patched);
  const err = f => { const r = spawnSync('node', ['--check', f], { encoding: 'utf8', maxBuffer: 1 << 28 }); return r.status === 0 ? 'OK' : (r.stderr.match(/:(\d+)\n/) || [])[1]; };
  ok('patch parse-neutral (orig err line == patched err line)', err(tmpO) === err(tmpP));
} else {
  console.log('(skipping PART A: no ~/.tweakcc/native-claudejs-orig.js backup)');
}

console.log('\n=== PART B: wrapper vs ripgrep set-equivalence ===');
for (const q of ['showDiff', 'PatchGroup', 'export', 'const', 'function', 'writeMaxEffortDefault']) {
  ok(`exact "${q}" set == rg`, eqSet(wrap(['-n', q, '.'], SRC).out, rg(['-n', q, '.'], SRC).out));
}
ok('-l files set == rg', eqSet(wrap(['-l', 'showDiff', '.'], SRC).out, rg(['-l', 'showDiff', '.'], SRC).out));
ok('count -c routed to rg', norm(wrap(['-c', 'showDiff', '.'], SRC).out).join() === norm(rg(['-c', 'showDiff', '.'], SRC).out).join());
ok('--type routed to rg', eqSet(wrap(['-n', '--type', 'ts', 'showDiff', '.'], SRC).out, rg(['-n', '--type', 'ts', 'showDiff', '.'], SRC).out));
ok('-U multiline routed to rg', eqSet(wrap(['-n', '-U', 'showDiff', '.'], SRC).out, rg(['-n', '-U', 'showDiff', '.'], SRC).out));
ok('single-file path routed to rg', norm(wrap(['-n', 'showDiff', 'patches/index.ts'], SRC).out).join() === norm(rg(['-n', 'showDiff', 'patches/index.ts'], SRC).out).join());
ok('short pattern (<3) routed to rg', eqSet(wrap(['-n', 'fn', '.'], SRC).out, rg(['-n', 'fn', '.'], SRC).out));
ok('regex routed to rg', eqSet(wrap(['-n', 'showD.*ff', '.'], SRC).out, rg(['-n', 'showD.*ff', '.'], SRC).out));
ok('glob *.ts translated == rg', eqSet(wrap(['-n', '--glob', '*.ts', 'PatchGroup', '.'], REPO).out, rg(['-n', '--glob', '*.ts', 'PatchGroup', '.'], REPO).out));
ok('fuzzy typo finds the symbol', wrap(['--fuzzy', '-n', 'shoDiff', '.'], SRC).out.includes('showDiff'));
ok('no-match exit == 1', wrap(['-n', 'zzqqxx_no', '.'], SRC).status === 1);
ok('--version starts "ripgrep "', (spawnSync(WRAPPER, ['--version'], { encoding: 'utf8' }).stdout || '').startsWith('ripgrep '));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
