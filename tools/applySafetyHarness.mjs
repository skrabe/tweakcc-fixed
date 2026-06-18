#!/usr/bin/env node
// Apply-safety ground-truth harness.
//
// Reproduces the REAL `node dist/index.mjs --apply` code path (same
// applySystemPrompts + Unicode-escaping detection + syncPrompt) WITHOUT touching
// the live native binary, and FULLY ISOLATED so it is parallel-safe:
//   - a temp HOME with a COPY of ~/.tweakcc/system-prompts (override set) so
//     syncPrompt's stub creation never races a sibling run or mutates the real
//     override dir;
//   - npm-install mode pointed at a COPY of the pristine cli.js, so the apply
//     patches that copy (no binary repack, no clobber of the user's CC).
//
// Checks (the bar a correct apply-safety fix must hit):
//   - 0 "Could not find" warnings
//   - 0 INTRODUCED minified `${var}` interpolations (vs pristine) — catches the
//     K9-class mis-bind that ReferenceErrors at boot
//   - the patched cli.js still parses
//
// Usage:  node tools/applySafetyHarness.mjs [pristineCliJs]
// Requires a built dist (run `pnpm build` first). Exit 0 = clean.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRISTINE = process.argv[2] || '/tmp/cli-2.1.179.js';
if (!fs.existsSync(PRISTINE)) {
  console.error(`harness: pristine cli.js not found: ${PRISTINE}`);
  process.exit(2);
}
// Version drives which prompts-X.Y.Z.json the apply loads — derive it from the
// pristine filename (cli-X.Y.Z.js) so the harness tracks the binary under test
// across version bumps instead of pinning a stale version.
const VERSION =
  (PRISTINE.match(/cli-(\d+\.\d+\.\d+)\.js$/) || [, '2.1.179'])[1];
const orig = fs.readFileSync(PRISTINE, 'utf8');

// minified `${var}` tokens: 1-4 alnum/$ chars, not an ALL_CAPS tweakcc name.
const minifiedSlots = (s) => {
  const out = new Map();
  for (const m of s.matchAll(/\$\{([A-Za-z$][\w$]{0,3})\}/g)) {
    const v = m[1];
    if (v === v.toUpperCase() && /[A-Z]/.test(v) && v.length > 2) continue; // skip ALLCAPS names
    out.set(v, (out.get(v) || 0) + 1);
  }
  return out;
};

// Binding sites of short idents: arrow/function params (incl. destructured) and
// let/const/var declarations. A `${v}` is only the dangerous K9-class UNRESOLVED
// binary ident when nothing BINDS `v` in the same emitted code — patches/overrides
// legitimately carry JS with short locals (e.g.
// `Object.entries(_).map(([q,K])=>`# ${q}\n${K}`)`), which parse fine and never
// ReferenceError. Counting bindings lets the introduced check discount them.
const boundLocals = (s) => {
  const out = new Map();
  // `(?<!\$)` keeps a `${v}` interpolation (opener `{` preceded by `$`) from
  // counting as an object-destructure binding — else every slot self-discounts
  // and a real unresolved ident slips through.
  for (const m of s.matchAll(
    /(?:\b(?:let|const|var)\s+|(?<!\$)[([,{]\s*)([A-Za-z$][\w$]{0,3})(?=\s*(?:[)\]},=:]|=>))/g
  )) {
    out.set(m[1], (out.get(m[1]) || 0) + 1);
  }
  return out;
};

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'applysafe-home-'));
try {
  // Isolated ~/.tweakcc with a copy of the real override set + config.
  const realTweakcc = path.join(os.homedir(), '.tweakcc');
  const tc = path.join(tmpHome, '.tweakcc');
  fs.mkdirSync(tc, { recursive: true });
  for (const name of ['system-prompts', 'system-reminders']) {
    const src = path.join(realTweakcc, name);
    if (fs.existsSync(src)) {
      fs.cpSync(fs.realpathSync(src), path.join(tc, name), { recursive: true });
    }
  }
  for (const f of ['config.json']) {
    const src = path.join(realTweakcc, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tc, f));
  }

  // npm-install copy of the pristine cli.js.
  const pkgDir = path.join(tmpHome, 'cc', 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkgDir, { recursive: true });
  const cliCopy = path.join(pkgDir, 'cli.js');
  fs.copyFileSync(PRISTINE, cliCopy);
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@anthropic-ai/claude-code', version: VERSION })
  );

  let log = '';
  try {
    log = execFileSync('node', [path.join(REPO, 'dist', 'index.mjs'), '--apply'], {
      env: { ...process.env, HOME: tmpHome, TWEAKCC_CC_INSTALLATION_PATH: cliCopy },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    log = (e.stdout || '') + (e.stderr || '');
  }

  const patched = fs.readFileSync(cliCopy, 'utf8');
  const cnf = (log.match(/Could not find/g) || []).length;
  const cannotApply = (log.match(/cannot apply safely/gi) || []).length;

  const o = minifiedSlots(orig);
  const p = minifiedSlots(patched);
  const ob = boundLocals(orig);
  const pb = boundLocals(patched);
  const introduced = [];
  for (const [v, n] of p) {
    const slotDelta = n - (o.get(v) || 0);
    if (slotDelta <= 0) continue;
    // Discount slots matched by a freshly-introduced binding of the same name —
    // those are bound locals in emitted code, not unresolved binary idents.
    const bindDelta = (pb.get(v) || 0) - (ob.get(v) || 0);
    const unresolved = slotDelta - Math.max(0, bindDelta);
    if (unresolved > 0) introduced.push(`${v}(+${unresolved})`);
  }

  // Syntax check. The check must use a parser capable of the language features
  // the pristine binary ALREADY uses — Bun compiled this cli.js and it contains
  // `using`/`await using` (TC39 explicit resource management). Older node
  // (<=22.x) rejects `using` outright, so `node --check` would report the
  // pristine itself as not-parsing — a node-version gap, not a defect in the
  // patcher's output. So: enumerate candidate checkers (the harness's own node
  // plain and with the explicit-resource-management flag, plus any discoverable
  // newer node from mise/nvm and process.execPath siblings), pick the first one
  // that parses the PRISTINE baseline, and use it for the PATCHED file. If no
  // checker can parse the pristine, fall back to parse-equivalence: the patched
  // file is acceptable iff it fails (or succeeds) at the exact same point as the
  // pristine — i.e. our splicing introduced no new syntax break.
  const firstSyntaxError = (file, bin, flags) => {
    try {
      execFileSync(bin, [...flags, '--check', file], { stdio: 'pipe' });
      return null; // parsed clean
    } catch (e) {
      const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
      const m = out.match(/SyntaxError:.*/);
      // Normalize away the file path / line:col so only the error kind compares.
      return m ? m[0] : `EXIT_${e.status ?? 'ERR'}`;
    }
  };

  const candidateNodes = [];
  const seen = new Set();
  const addNode = (bin) => {
    if (bin && !seen.has(bin) && fs.existsSync(bin)) {
      seen.add(bin);
      candidateNodes.push(bin);
    }
  };
  addNode('node');
  addNode(process.execPath);
  // Discover newer node installs (mise / nvm / fnm) — sorted so highest wins.
  const versionDirs = [];
  for (const root of [
    path.join(os.homedir(), '.local', 'share', 'mise', 'installs', 'node'),
    path.join(os.homedir(), '.nvm', 'versions', 'node'),
    path.join(os.homedir(), '.local', 'share', 'fnm', 'node-versions'),
  ]) {
    try {
      for (const d of fs.readdirSync(root)) {
        versionDirs.push(path.join(root, d));
      }
    } catch {
      /* root absent */
    }
  }
  versionDirs.sort().reverse();
  for (const d of versionDirs) {
    addNode(path.join(d, 'bin', 'node'));
    addNode(path.join(d, 'installation', 'bin', 'node')); // fnm layout
  }

  // Each candidate checker is (bin, flags). Flag variant handles node 22.x,
  // which can parse `using` only behind --js-explicit-resource-management.
  const checkers = [];
  for (const bin of candidateNodes) {
    checkers.push({ bin, flags: [] });
    checkers.push({ bin, flags: ['--js-explicit-resource-management'] });
  }

  // Pick the first checker that parses the pristine clean.
  let parses;
  let parseMode = 'none';
  const capable = checkers.find(
    c => firstSyntaxError(PRISTINE, c.bin, c.flags) === null
  );
  if (capable) {
    parses = firstSyntaxError(cliCopy, capable.bin, capable.flags) === null;
    parseMode = `${capable.bin}${capable.flags.length ? ' ' + capable.flags.join(' ') : ''}`;
  } else {
    // No checker can parse the pristine (pure node-version gap). Fall back to
    // parse-equivalence with the harness's own node: patched is OK iff it
    // breaks at exactly the same place as the pristine (no new corruption).
    const base = firstSyntaxError(PRISTINE, 'node', []);
    const got = firstSyntaxError(cliCopy, 'node', []);
    parses = base === got;
    parseMode = `equivalence(node): pristine=${base} patched=${got}`;
  }

  // Workflow-script override JS check. A workflow-script-*.md override is
  // EXECUTABLE JS spliced into cli.js as a template-literal string, so "patched
  // parses" only proves cli.js parses — NOT that the embedded script is itself
  // valid (a duplicate `const`, etc. ships silently; smoke never runs the
  // workflow). Resolve the body the way it lives at runtime (interpolations ->
  // placeholder, one backslash layer collapsed, export dropped), wrap so
  // top-level await/return are legal, and node --check it (plain modern JS, no
  // `using`, so the harness node suffices).
  const wfScriptErrors = [];
  const spDir = path.join(tc, 'system-prompts');
  let wfFiles = [];
  try {
    wfFiles = fs
      .readdirSync(spDir)
      .filter(f => /^workflow-script-.*\.md$/.test(f));
  } catch {
    /* no override dir */
  }
  for (const f of wfFiles) {
    const body = fs
      .readFileSync(path.join(spDir, f), 'utf8')
      .replace(/^<!--[\s\S]*?-->\n?/, '');
    if (!body.trim()) continue; // empty body = no override
    const js = body
      .replace(/\$\{[^{}]*\}/g, '(null)')
      .replace(/\\\\/g, '\\')
      .replace(/^export /m, '');
    const wrapped = path.join(tmpHome, `wfcheck-${f}.js`);
    fs.writeFileSync(wrapped, `async function __f(){\n${js}\n}`);
    const err = firstSyntaxError(wrapped, 'node', []);
    if (err) wfScriptErrors.push(`${f}: ${err}`);
  }

  console.log('=== apply-safety harness ===');
  console.log(`pristine:          ${PRISTINE}`);
  console.log(`Could not find:    ${cnf}`);
  console.log(`cannot apply safely (warns): ${cannotApply}`);
  console.log(`introduced minified \${var}: ${introduced.length}  ${introduced.slice(0, 12).join(' ')}`);
  console.log(`patched parses:    ${parses}  [${parseMode}]`);
  console.log(`workflow-script JS: ${wfScriptErrors.length === 0 ? 'ok' : wfScriptErrors.join(' | ')}`);
  const ok =
    cnf === 0 && introduced.length === 0 && parses && wfScriptErrors.length === 0;
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
