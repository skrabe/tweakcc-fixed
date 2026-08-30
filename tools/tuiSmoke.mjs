#!/usr/bin/env node
/**
 * Interactive-TUI smoke test.
 *
 * `claude --print` renders no Ink tree, so it boots green through interface
 * faults that kill every real session. CC 2.1.246 shipped exactly that: a
 * patch spliced a bare string into a Box, and the TUI died on the first frame
 * with `Text string "┃ " must be rendered inside <Text>` while --print,
 * apply hygiene and the four-zeros gate all stayed clean.
 *
 * This drives the real binary under tmux (expect blocks on terminal capability
 * queries), waits for the composer, then opens the lazily-rendered surfaces a
 * regex patch can break without touching boot: /help, /config, /theme.
 *
 * Usage: node tools/tuiSmoke.mjs [--binary <path>] [--keep]
 * Exit 0 pass, 1 fail, 0 + "SKIP" when tmux is unavailable.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = f => {
  const i = args.indexOf(f);
  return i === -1 ? null : args[i + 1];
};
const KEEP = args.includes('--keep');
const SESSION = `tweakcc-tuismoke-${process.pid}`;

const sh = (cmd, a, opts = {}) =>
  spawnSync(cmd, a, { encoding: 'utf8', ...opts });

const tmux = (...a) => sh('tmux', a);
const capture = () => tmux('capture-pane', '-t', SESSION, '-p').stdout ?? '';
const alive = () => tmux('has-session', '-t', SESSION).status === 0;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const resolveBinary = () => {
  const explicit = argOf('--binary');
  if (explicit) return explicit;
  const link = path.join(os.homedir(), '.local', 'bin', 'claude');
  try {
    return fs.realpathSync(link);
  } catch {
    return null;
  }
};

// Ink prints these when the element tree is invalid. They are the whole point
// of this check, so match them anywhere in the pane, not only at boot.
export const FATAL = [
  'must be rendered inside <Text>',
  'unrecoverable interface error',
  'ERROR  Text string',
];

export const fatalIn = pane => FATAL.find(f => pane.includes(f)) ?? null;

const waitFor = (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  let pane = '';
  while (Date.now() < deadline) {
    pane = capture();
    const fatal = fatalIn(pane);
    if (fatal) return { ok: false, pane, reason: `Ink interface error: ${fatal}` };
    if (pane.includes('[EXIT=')) return { ok: false, pane, reason: 'process exited' };
    if (predicate(pane)) return { ok: true, pane };
    sleep(500);
  }
  return { ok: false, pane, reason: `timed out waiting for ${label}` };
};

const send = text => {
  tmux('send-keys', '-t', SESSION, '-l', text);
  sleep(300);
};
const key = k => {
  tmux('send-keys', '-t', SESSION, k);
  sleep(300);
};

const failures = [];
const note = (ok, msg) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${msg}`);
  if (!ok) failures.push(msg);
};

const main = () => {
  if (sh('tmux', ['-V']).status !== 0) {
    console.log('tuiSmoke: SKIP — tmux not installed');
    return 0;
  }
  const bin = resolveBinary();
  if (!bin || !fs.existsSync(bin)) {
    console.log('tuiSmoke: FAIL — could not resolve the claude binary');
    return 1;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-tuismoke-'));
  fs.writeFileSync(path.join(scratch, 'README.md'), '# tui smoke\n');
  try {
    execFileSync('git', ['init', '-q', scratch], { stdio: 'ignore' });
  } catch {
    /* a non-repo cwd is fine; CC just skips the git footer */
  }

  console.log(`tuiSmoke: ${bin}`);
  console.log(`tuiSmoke: cwd ${scratch}`);

  tmux('kill-session', '-t', SESSION);
  // NEVER pipe the binary's stdout: Ink needs a TTY, and `| tee` makes the
  // launch exit instantly with an empty pane that reads like a boot crash.
  const cmd =
    `${JSON.stringify(bin)} --dangerously-skip-permissions; ` +
    `echo "[EXIT=$?]"; sleep 600`;
  const started = tmux(
    'new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50',
    '-c', scratch, cmd
  );
  if (started.status !== 0) {
    console.log(`tuiSmoke: FAIL — tmux new-session: ${started.stderr?.trim()}`);
    return 1;
  }

  try {
    // A fresh cwd raises the workspace-trust dialog before the composer.
    const trust = waitFor(
      p => /Is this a project you created or one you trust/i.test(p) || /shift\+tab to cycle/.test(p),
      90000,
      'boot'
    );
    if (!trust.ok) {
      note(false, `boot: ${trust.reason}`);
      console.log(trust.pane.split('\n').slice(-25).join('\n'));
      return 1;
    }
    if (/Is this a project you created or one you trust/i.test(trust.pane)) {
      // The dialog's DEFAULT selection is "No, exit", so a bare Enter quits CC
      // and leaves an empty pane that reads exactly like a boot crash. Move to
      // "Yes, I trust this folder" first. Verified on CC 2.1.251: the marker
      // sits on the No row at first paint.
      key('Down');
      key('Enter');
    }

    const composer = waitFor(p => /shift\+tab to cycle/.test(p), 90000, 'composer');
    note(composer.ok, `boots to the composer${composer.ok ? '' : ` — ${composer.reason}`}`);
    if (!composer.ok) {
      console.log(composer.pane.split('\n').slice(-25).join('\n'));
      return 1;
    }

    // Each of these renders lazily: a patch can break one while boot stays clean.
    const surfaces = [
      ['/help', /Shortcuts|for commands/],
      ['/config', /Theme\s|Output style|Verbose output/],
      ['/theme', /Choose the text style|Dark mode/],
      ['/model', /Select model/],
      ['/status', /Session ID|Login method/],
    ];
    for (const [cmd2, expect] of surfaces) {
      key('C-u');
      send(cmd2);
      key('Enter');
      const r = waitFor(p => expect.test(p), 30000, cmd2);
      note(r.ok, `${cmd2} renders${r.ok ? '' : ` — ${r.reason}`}`);
      if (!r.ok) console.log(r.pane.split('\n').slice(-20).join('\n'));
      key('Escape');
      sleep(500);
      key('Escape');
    }

    const finalPane = capture();
    const lateFatal = fatalIn(finalPane);
    note(!lateFatal, lateFatal ? `interface error after navigation: ${lateFatal}` : 'no interface error after navigating every surface');
    note(alive(), alive() ? 'session still alive at the end' : 'session died during the run');
  } finally {
    if (!KEEP) {
      tmux('kill-session', '-t', SESSION);
      fs.rmSync(scratch, { recursive: true, force: true });
    } else {
      console.log(`tuiSmoke: kept session ${SESSION} and ${scratch}`);
    }
  }

  if (failures.length) {
    console.log(`tuiSmoke: FAIL — ${failures.length} check(s) failed`);
    return 1;
  }
  console.log('tuiSmoke: PASS');
  return 0;
};

// Importable for tests; only self-executes when run as the entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
