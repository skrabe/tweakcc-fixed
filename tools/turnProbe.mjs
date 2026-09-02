#!/usr/bin/env node
/**
 * turnProbe — drive ONE real interactive turn through a patched binary and
 * prove the main-loop request actually left the process.
 *
 * Every other gate in this stack stops before the API: apply hygiene, the
 * apply-safety harness, four-zeros, `--print` READY and tuiSmoke's lazy
 * surfaces all passed on CC 2.1.257 while every interactive turn ended
 * instantly with 0 tokens — the main-loop `/v1/messages` POST was never
 * assembled. Only a wire capture of a live turn shows that.
 *
 * Mechanics: a loopback HTTP forwarder (the Max OAuth headers pass straight
 * through to api.anthropic.com), the binary launched under tmux in a scratch
 * repo with ANTHROPIC_BASE_URL pointed at the forwarder, the workspace-trust
 * dialog driven onto "Yes" and read back, one prompt sent, then the captured
 * request bodies are classified. A main-loop request carries a `tools` array
 * and a multi-block `system`; side calls (title, quota) carry neither.
 *
 *   node tools/turnProbe.mjs [--binary <path>] [--out <dir>] [--keep]
 *                            [--prompt <text>] [--timeout <ms>]
 *
 * Exit 0 when a main-loop request was sent AND the reply rendered; 1 otherwise.
 * Prints every captured request with its size and class so a failure reads
 * as "only a 4.6 KB side call went out", not as a bare red X.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = f => {
  const i = args.indexOf(f);
  return i === -1 ? null : args[i + 1];
};
const KEEP = args.includes('--keep');
const PROMPT =
  argOf('--prompt') ?? 'Reply with exactly the word PONG and nothing else.';
const TIMEOUT = Number(argOf('--timeout') ?? 120000);
const SESSION = `tweakcc-turnprobe-${process.pid}`;

const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: 'utf8', ...opts });
const tmux = (...a) => sh('tmux', a);
const capture = () => tmux('capture-pane', '-t', SESSION, '-p').stdout ?? '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const resolveBinary = () => {
  const explicit = argOf('--binary');
  if (explicit) return explicit;
  try {
    return fs.realpathSync(path.join(os.homedir(), '.local', 'bin', 'claude'));
  } catch {
    return null;
  }
};

const classify = body => {
  let j;
  try {
    j = JSON.parse(body.toString('utf8'));
  } catch {
    return { kind: 'unparseable', model: '?' };
  }
  const tools = Array.isArray(j.tools) ? j.tools.length : 0;
  const system = Array.isArray(j.system) ? j.system.length : typeof j.system === 'string' ? 1 : 0;
  const kind = tools > 0 ? 'main-loop' : 'side-call';
  return { kind, model: j.model ?? '?', tools, system, stream: j.stream === true };
};

const startForwarder = (outDir) =>
  new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const id = String(requests.length + 1).padStart(3, '0');
        const rec = { id, url: req.url, method: req.method, bytes: body.length, status: null, ...(
          req.method === 'POST' && req.url.startsWith('/v1/messages') ? classify(body) : { kind: 'other' }
        ) };
        requests.push(rec);
        if (rec.kind !== 'other') fs.writeFileSync(path.join(outDir, `req-${id}.json`), body);
        const headers = { ...req.headers, host: 'api.anthropic.com' };
        delete headers['content-length'];
        const up = https.request(
          { hostname: 'api.anthropic.com', port: 443, path: req.url, method: req.method, headers },
          r => {
            rec.status = r.statusCode;
            const rc = [];
            res.writeHead(r.statusCode, r.headers);
            r.on('data', d => { rc.push(d); res.write(d); });
            r.on('end', () => {
              res.end();
              if (rec.kind !== 'other')
                fs.writeFileSync(path.join(outDir, `res-${id}.txt`), `STATUS ${r.statusCode}\n` + Buffer.concat(rc).toString('utf8').slice(0, 8000));
            });
          }
        );
        up.on('error', e => { rec.status = `ERR ${e.message}`; res.writeHead(502); res.end(String(e)); });
        if (body.length) up.write(body);
        up.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });

const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  let pane = '';
  while (Date.now() < deadline) {
    pane = capture();
    if (pane.includes('[EXIT=')) return { ok: false, pane, reason: 'process exited' };
    if (predicate(pane)) return { ok: true, pane };
    await sleep(500);
  }
  return { ok: false, pane, reason: `timed out waiting for ${label}` };
};
const send = async text => { tmux('send-keys', '-t', SESSION, '-l', text); await sleep(300); };
const key = async k => { tmux('send-keys', '-t', SESSION, k); await sleep(300); };

const main = async () => {
  if (sh('tmux', ['-V']).status !== 0) {
    console.log('turnProbe: SKIP — tmux not installed');
    return 0;
  }
  const bin = resolveBinary();
  if (!bin || !fs.existsSync(bin)) {
    console.log('turnProbe: FAIL — could not resolve the claude binary');
    return 1;
  }
  const outDir = argOf('--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-turnprobe-'));
  fs.mkdirSync(outDir, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-turnprobe-cwd-'));
  fs.writeFileSync(path.join(scratch, 'README.md'), '# turn probe\n');
  try { execFileSync('git', ['init', '-q', scratch], { stdio: 'ignore' }); } catch { /* non-repo cwd is fine */ }

  const { server, port, requests } = await startForwarder(outDir);
  console.log(`turnProbe: ${bin}`);
  console.log(`turnProbe: forwarder 127.0.0.1:${port}, captures in ${outDir}`);

  tmux('kill-session', '-t', SESSION);
  const cmd =
    `ANTHROPIC_BASE_URL=http://127.0.0.1:${port} ${JSON.stringify(bin)} --dangerously-skip-permissions; ` +
    `echo "[EXIT=$?]"; sleep 600`;
  const started = tmux('new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50', '-c', scratch, cmd);
  if (started.status !== 0) {
    console.log(`turnProbe: FAIL — tmux new-session: ${started.stderr?.trim()}`);
    server.close();
    return 1;
  }

  const failures = [];
  const note = (ok, msg) => { console.log(`${ok ? '  ✓' : '  ✗'} ${msg}`); if (!ok) failures.push(msg); };
  try {
    const trust = await waitFor(
      p => /Is this a project you created or one you trust/i.test(p) || /shift\+tab to cycle/.test(p),
      90000, 'trust dialog or composer');
    if (!trust.ok) {
      note(false, `boot: ${trust.reason}`);
      console.log(trust.pane.split('\n').slice(-25).join('\n'));
      return 1;
    }
    if (/Is this a project you created or one you trust/i.test(trust.pane)) {
      const YES = /❯\s*Yes, I trust this folder/;
      let onYes = false;
      for (let i = 0; i < 12 && !onYes; i += 1) {
        await key('Down');
        const pane = capture();
        if (pane.includes('[EXIT=')) break;
        onYes = YES.test(pane);
      }
      if (!onYes) { note(false, 'boot: could not select "Yes, I trust this folder"'); return 1; }
      await key('Enter');
    }
    const composer = await waitFor(p => /shift\+tab to cycle/.test(p), 90000, 'composer');
    note(composer.ok, `boots to the composer${composer.ok ? '' : ` — ${composer.reason}`}`);
    if (!composer.ok) { console.log(composer.pane.split('\n').slice(-25).join('\n')); return 1; }

    await key('C-u');
    await send(PROMPT);
    await key('Enter');

    const mainLoopSent = () => requests.some(r => r.kind === 'main-loop');
    // Wait for the reply itself, not for the first error text: CC retries a
    // transport error or a 429 on its own, and the pane shows "API Error"
    // for a moment while it does. Stopping on that text turned a successful
    // retried turn into a FAIL on 2026-09-02 (ERR then 200, reply pending).
    const replied = await waitFor(p => /PONG/.test(p.replace(PROMPT, '')), TIMEOUT, 'a reply');
    // Give any trailing side-call (title generation) a moment to land.
    await sleep(2500);

    const pane = capture();
    const echoStripped = pane.replace(PROMPT, '');
    const gotPong = /PONG/.test(echoStripped);
    const errorText = (pane.match(/.*(API Error|Error:|error).*/i) ?? [null])[0];

    console.log('  requests captured:');
    for (const r of requests) {
      console.log(`    ${r.id} ${r.method} ${r.url}  ${String(r.bytes).padStart(7)} B  ${r.kind}${r.model ? `  model=${r.model}` : ''}${r.tools ? `  tools=${r.tools} system=${r.system}` : ''}  status=${r.status}`);
    }
    note(mainLoopSent(), mainLoopSent()
      ? 'main-loop request (tools + system) was sent'
      : 'NO main-loop request left the process — the turn ended before request assembly');
    // One main-loop 200 is the bar: a transport ERR or a 429 followed by a
    // retried 200 is CC working as designed, not a rejected build. Only a
    // main-loop that NEVER got a 200 (4xx on every attempt) is a failure.
    const mainStatuses = requests.filter(r => r.kind === 'main-loop').map(r => r.status);
    const mainOk = mainStatuses.includes(200);
    if (mainLoopSent()) note(mainOk, mainOk
      ? `main-loop request returned 200${mainStatuses.length > 1 ? ` (after ${mainStatuses.slice(0, -1).join(', ')} — retried by CC)` : ''}`
      : `main-loop request rejected: ${mainStatuses.join(', ')}`);
    note(gotPong, gotPong ? 'reply rendered in the TUI' : `no reply rendered${errorText ? ` — ${errorText.trim()}` : replied.ok ? '' : ` — ${replied.reason}`}`);
    if (!gotPong) console.log(pane.split('\n').filter(l => l.trim()).slice(-20).join('\n'));
    fs.writeFileSync(path.join(outDir, 'pane.txt'), pane);
    fs.writeFileSync(path.join(outDir, 'requests.json'), JSON.stringify(requests, null, 2));
  } finally {
    server.close();
    if (!KEEP) {
      tmux('kill-session', '-t', SESSION);
      fs.rmSync(scratch, { recursive: true, force: true });
    } else {
      console.log(`turnProbe: kept session ${SESSION} and ${scratch}`);
    }
  }
  if (failures.length) { console.log(`turnProbe: FAIL — ${failures.length} check(s) failed`); return 1; }
  console.log('turnProbe: PASS');
  return 0;
};

if (import.meta.url === `file://${process.argv[1]}`) main().then(c => process.exit(c));
