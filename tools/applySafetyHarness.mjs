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
//   - 0 "cannot apply safely" warnings
//   - 0 INTRODUCED minified `${var}` interpolations (vs pristine) — catches the
//     K9-class mis-bind that ReferenceErrors at boot
//   - 0 INTRODUCED raw non-ASCII codepoints (vs pristine) — every injection
//     surface escapes to \uXXXX; raw bytes there mojibake under Bun's Latin-1
//     module storage
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
// Version drives which prompts-X.Y.Z.json the apply loads — derive it from the
// pristine filename (cli-X.Y.Z.js) so the harness tracks the binary under test
// across version bumps instead of pinning a stale version.
const VERSION =
  (PRISTINE.match(/cli-(\d+\.\d+\.\d+)\.js$/) || [, '2.1.179'])[1];

// minified `${var}` tokens: 1-4 alnum/$ chars, not an ALL_CAPS tweakcc name.
// Is short ident `v` BOUND anywhere in `window` — arrow/function params (incl.
// destructured), let/const/var declarations? `(?<!\$)` keeps a `${v}` interpolation
// (opener `{` preceded by `$`) from counting as an object-destructure binding.
const bindsInWindow = (window, v) => {
  const re = new RegExp(
    `(?:\\b(?:let|const|var|function)\\s+|(?<!\\$)[([,{]\\s*)${v.replace(/[$]/g, '\\$&')}(?=\\s*(?:[)\\]},=:]|=>))`
  );
  return re.test(window);
};

// How far back a short-var binding can sit from its `${v}` use. Minified function
// params and module consts (`function f(e,r,t){…${e}…}`, `var CIu=…;…${CIu}…`)
// bind arbitrarily far above the interpolation, so a small window false-flags them
// (2.1.218: 300 flagged bound `e`/`CIu`, 3000 swept in unrelated bindings; 1500
// clears fable-5 to zero while a name bound NOWHERE within reach — a real leak —
// still flags). Backstop only: the driver leak-guard + parse + smoke are primary.
const BIND_WINDOW_BACK = 1500;

// "Dangerous" `${v}` slots in `s`: short-ident interpolations whose `v` is NOT
// bound in the slot's OWN enclosing window (arrow/params before the template body,
// or a `let v=` just before its `${v}`). A slot bound in its own window is a plain
// local in emitted code — it parses and never ReferenceErrors, so it is never
// dangerous, in pristine OR patched.
const dangerousSlots = (s) => {
  const out = new Map();
  for (const m of s.matchAll(/\$\{([A-Za-z$][\w$]{0,3})\}/g)) {
    const v = m[1];
    if (v === v.toUpperCase() && /[A-Z]/.test(v) && v.length > 2) continue; // ALLCAPS = override placeholder, checked elsewhere
    const idx = m.index;
    const window = s.slice(Math.max(0, idx - BIND_WINDOW_BACK), idx + 60);
    if (bindsInWindow(window, v)) continue; // bound local — safe
    out.set(v, (out.get(v) || 0) + 1);
  }
  return out;
};

// K9-class UNRESOLVED binary idents the PATCH introduced. The bind-discount MUST be
// scoped to each slot's own enclosing template literal, not counted file-wide: `q`,
// `e`, `t` are common minified names, so a whole-file binding delta nets out and
// either hides a real leak or (2.1.218) cries wolf on a legitimately-bound `${q}`
// like `Object.entries(t).map(([q,K])=>`# ${q}\n${K}`)`. We instead net-count the
// DANGEROUS (unbound-in-window) slots per var: a var is introduced-unresolved only
// where patched has MORE unbound `${v}` slots than pristine did. Net-counting keeps
// this robust to the byte shifts minification/override edits cause everywhere.
export const introducedUnresolvedSlots = (orig, patched) => {
  const o = dangerousSlots(orig);
  const p = dangerousSlots(patched);
  const out = new Map();
  for (const [v, n] of p) {
    const delta = n - (o.get(v) || 0);
    if (delta > 0) out.set(v, delta);
  }
  return out;
};

// Raw (unescaped) non-ASCII the patch INTRODUCED. Compared per codepoint against
// the pristine rather than absolute-counted: the pristine binary carries plenty
// of its own non-ASCII, so only a codepoint whose count GREW can have come from
// an injection surface that failed to escape to \uXXXX.
export const introducedRawNonAscii = (pristine, patched) => {
  const census = (s) => {
    const out = new Map();
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) continue;
      out.set(cp, (out.get(cp) || 0) + 1);
    }
    return out;
  };
  const o = census(pristine);
  const p = census(patched);
  const out = [];
  for (const [cp, n] of p) {
    const delta = n - (o.get(cp) || 0);
    if (delta > 0) {
      out.push(
        `U+${cp.toString(16).toUpperCase().padStart(4, '0')}(+${delta})`
      );
    }
  }
  return out.sort();
};

// A "cannot apply safely" warning means an override was NOT spliced — the
// operator's content is missing from the binary. Counting it without gating on
// it reported PASS for a half-applied set, so it is a failure like the rest.
export const harnessVerdict = ({
  cnf,
  cannotApply,
  introduced,
  rawNonAscii,
  parses,
  wfScriptErrors,
}) =>
  cnf === 0 &&
  cannotApply === 0 &&
  introduced.length === 0 &&
  rawNonAscii.length === 0 &&
  parses &&
  wfScriptErrors.length === 0;

const runHarness = () => {
if (!fs.existsSync(PRISTINE)) {
  console.error(`harness: pristine cli.js not found: ${PRISTINE}`);
  process.exit(2);
}
const orig = fs.readFileSync(PRISTINE, 'utf8');
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

  const introduced = [];
  for (const [v, n] of introducedUnresolvedSlots(orig, patched)) {
    introduced.push(`${v}(+${n})`);
  }

  const rawNonAscii = introducedRawNonAscii(orig, patched);

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
  console.log(`introduced raw non-ASCII: ${rawNonAscii.length}  ${rawNonAscii.slice(0, 12).join(' ')}`);
  console.log(`patched parses:    ${parses}  [${parseMode}]`);
  console.log(`workflow-script JS: ${wfScriptErrors.length === 0 ? 'ok' : wfScriptErrors.join(' | ')}`);
  const ok = harnessVerdict({
    cnf,
    cannotApply,
    introduced,
    rawNonAscii,
    parses,
    wfScriptErrors,
  });
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
};

// Run unless we were imported (the unit tests import the two pure helpers).
// Resolved through realpath on both sides: a mismatch here would make the
// harness exit 0 having checked nothing — a false PASS, the exact failure mode
// this file exists to catch.
const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const invokedDirectly =
  !!process.argv[1] &&
  realpath(process.argv[1]) === realpath(fileURLToPath(import.meta.url));
if (invokedDirectly) runHarness();
