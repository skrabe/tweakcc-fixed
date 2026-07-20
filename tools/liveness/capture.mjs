// Loopback liveness capture: run the PATCHED, INSTALLED Claude Code against a
// capture-only server and keep the outbound request body.
//
// This is deliberately NOT a fake Anthropic server. It answers every request
// with an error and kills the child the moment the main turn is in hand — the
// only thing under test is what Claude Code SENDS.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LivenessError, isMainTurn } from './projection.mjs';

const PATCH_MARKER = '__tweakcc';
const DUMMY_KEY = 'sk-ant-liveness-capture-not-a-real-key';

export const resolveBinary = () => {
  const override = process.env.TWEAKCC_CLAUDE_BIN;
  const launcher = override || path.join(os.homedir(), '.local/bin/claude');
  if (!fs.existsSync(launcher)) {
    throw new LivenessError(
      `Claude Code launcher not found at ${launcher}. ` +
        'Set TWEAKCC_CLAUDE_BIN to the installed binary.'
    );
  }
  // `claude` on PATH is a shell function, so it can never be spawned from node;
  // the launcher is a symlink into ~/.local/share/claude/versions/<ver>.
  const real = fs.realpathSync(launcher);
  try {
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    throw new LivenessError(`resolved binary is not executable: ${real}`);
  }
  return real;
};

// The binary is ~250MB, so it is scanned in chunks with an overlap window that
// keeps the marker from being split across a chunk boundary.
export const isPatched = binary => {
  const marker = Buffer.from(PATCH_MARKER, 'utf8');
  const overlap = marker.length - 1;
  const chunk = 1 << 22;
  const buf = Buffer.alloc(chunk + overlap);
  const fd = fs.openSync(binary, 'r');
  try {
    let offset = 0;
    let carry = 0;
    for (;;) {
      const read = fs.readSync(fd, buf, carry, chunk, offset);
      if (read <= 0) return false;
      const filled = carry + read;
      if (buf.subarray(0, filled).includes(marker)) return true;
      buf.copy(buf, 0, filled - overlap, filled);
      carry = overlap;
      offset += read;
    }
  } finally {
    fs.closeSync(fd);
  }
};

// A capture inherits whatever session the operator is sitting in. Claude Code
// reads CLAUDE*/ANTHROPIC* env and ~/.claude aggressively, so an unscrubbed run
// captures the operator's personal CLAUDE.md, skills and settings instead of
// the maintained prompt set.
const scrubbedEnv = () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC|CLAUDECODE|AI_AGENT|CODEX)/.test(key)) continue;
    env[key] = value;
  }
  return env;
};

const makeIsolatedHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-liveness-home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true })
  );
  return home;
};

const rmrf = target => {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // a leftover temp dir must never mask a real capture result
  }
};

export const captureRow = async (row, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 120000;
  const binary = options.binary ?? resolveBinary();
  const marker = `TWEAKCC-LIVENESS-${row.id.toUpperCase()}-${process.pid}`;
  const home = makeIsolatedHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-liveness-cwd-'));

  const requests = [];
  let child = null;
  let settled = false;

  try {
    return await new Promise((resolve, reject) => {
      const finish = fn => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child?.kill('SIGKILL');
        } catch {
          // child may already be gone
        }
        server.close();
        fn();
      };

      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          // Request headers carry the auth token. They are never read, never
          // stored and never logged — only the method, path and body shape.
          if (req.method === 'POST' && req.url.includes('/v1/messages')) {
            requests.push({ url: req.url, bytes: body.length });
            if (isMainTurn(body, marker)) {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end('{"type":"error","error":{"type":"api_error"}}');
              finish(() => resolve({ body, marker, requests, binary }));
              return;
            }
          }
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"type":"error","error":{"type":"api_error"}}');
        });
      });

      server.on('error', err =>
        finish(() =>
          reject(new LivenessError(`loopback server failed: ${err.message}`))
        )
      );

      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new LivenessError(
                `timed out after ${timeoutMs}ms without capturing the main ` +
                  `turn (${requests.length} /v1/messages POSTs seen)`
              )
            )
          ),
        timeoutMs
      );

      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        const env = {
          ...scrubbedEnv(),
          ...row.env,
          HOME: home,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_API_KEY: DUMMY_KEY,
          // Without this a localhost base URL flips first-party feature gating
          // and the capture would show a different prompt set than production.
          _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
        };
        const args = ['--print', ...row.args, marker];
        child = spawn(binary, args, {
          env,
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stdout.on('data', () => {});
        child.stderr.on('data', d => (stderr += d.toString().slice(0, 2000)));
        child.on('error', err =>
          finish(() =>
            reject(
              new LivenessError(`failed to spawn ${binary}: ${err.message}`)
            )
          )
        );
        child.on('exit', code => {
          if (settled) return;
          // The child exiting before the main turn means the request never
          // happened — auth refusal, a crash, or a flag the build rejected.
          setTimeout(
            () =>
              finish(() =>
                reject(
                  new LivenessError(
                    `Claude Code exited (code ${code}) before the main turn ` +
                      `was captured; ${requests.length} /v1/messages POSTs ` +
                      `seen. stderr: ${stderr.trim() || '<empty>'}`
                  )
                )
              ),
            250
          );
        });
      });
    });
  } finally {
    rmrf(home);
    rmrf(cwd);
  }
};
