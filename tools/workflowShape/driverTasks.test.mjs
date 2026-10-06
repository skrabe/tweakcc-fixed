// The driver's path-only handoff commands, run as the main loop and the agents
// run them: tasks-args builds the workflow args (and the trim-verify citation
// partition), tasks-check is the agent-side checker, tasks-harvest re-checks
// everything from disk; classify-args / audit-args read the builders'
// manifests. Fixtures live in a temp dir; SHOWTIME_TMP and SHOWTIME_TWEAKCC_DIR
// point the driver at them. Skips when the driver symlink is absent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRIVER = path.join(REPO, '.claude/skills/showtime-skrabe/driver.mjs');
const hasDriver = fs.existsSync(DRIVER);

let T;
const env = () => {
  const e = {
    ...process.env,
    TWEAKCC_REPO: REPO,
    SHOWTIME_TMP: path.join(T, 'tmp'),
    SHOWTIME_TWEAKCC_DIR: path.join(T, 'tc'),
    SHOWTIME_RUNLOG: path.join(T, 'run.log'),
  };
  delete e.SHOWTIME_VERBOSE;
  return e;
};
const driver = (...a) => {
  const r = spawnSync('node', [DRIVER, ...a], { encoding: 'utf8', env: env() });
  return { code: r.status, out: (r.stdout || '').replace(ANSI, ''), err: r.stderr || '', lines: (r.stdout || '').trim().split('\n') };
};
const write = (rel, data) => {
  const f = path.join(T, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
  return f;
};
const md = (rel, ccVersion = '9.9.9') => write(rel, `<!--\nname: 'x'\nccVersion: ${ccVersion}\n-->\nbody\n`);
// eslint-disable-next-line no-control-regex -- strip the driver's ANSI colours
const ANSI = /\x1b\[[0-9;]*m/g;
const digestOf = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);

describe.skipIf(!hasDriver)('driver tasks-args / tasks-check / tasks-harvest', () => {
  beforeAll(() => {
    T = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-tasks-'));
    // remindersDir defaults to the realpath of <tweakcc>/system-reminders.
    fs.mkdirSync(path.join(T, 'tc/lcc/system-reminders'), { recursive: true });
    fs.symlinkSync(path.join(T, 'tc/lcc/system-reminders'), path.join(T, 'tc/system-reminders'));
  });
  afterAll(() => fs.rmSync(T, { recursive: true, force: true }));

  it('trim: args line, PASS with a WARN for an unwritten path, stale-digest FAIL, ccVersion FAIL, harvest', () => {
    const pa = write('trim/packet-a.json', {});
    const pb = write('trim/packet-b.json', {});
    const a = md('set/a.md');
    const a2 = path.join(T, 'set/a2.md');
    const b = md('set/b.md', '9.9.8');
    const tasks = write('trim/tasks.json', [
      { id: 'a', packet: pa, paths: [a, a2] },
      { id: 'b', packet: pb, paths: [b] },
    ]);
    const args = driver('tasks-args', 'trim', tasks, '--version', '9.9.9', '--model', 'opus', '--effort', 'medium');
    expect(args.code).toBe(0);
    expect(args.lines).toHaveLength(1);
    const parsed = JSON.parse(args.lines[0]);
    expect(Object.keys(parsed)).toEqual(['version', 'tasksPath', 'count', 'tasksDigest', 'model', 'repoDir', 'remindersDir', 'effort']);
    expect(parsed).toMatchObject({ version: '9.9.9', tasksPath: tasks, count: 2, tasksDigest: digestOf(tasks), model: 'opus', repoDir: REPO, remindersDir: fs.realpathSync(path.join(T, 'tc/lcc/system-reminders')), effort: 'medium' });

    write('trim/trim-result-00.json', { task: '00', tasksDigest: parsed.tasksDigest, version: '9.9.9', id: 'a', filesWritten: [a], summary: 'cut the slogan' });
    const ok = driver('tasks-check', 'trim', tasks, '00');
    expect(ok.code).toBe(0);
    expect(ok.lines[0]).toBe('PASS trim 00 a: 1 file(s) written, 1 warning(s)');
    expect(ok.out).toContain(`WARN: listed path not written: ${a2}`);

    write('trim/trim-result-01.json', { task: '01', tasksDigest: 'ffffffffffffffff', version: '9.9.9', id: 'b', filesWritten: [b], summary: 's' });
    const stale = driver('tasks-check', 'trim', tasks, '01');
    expect(stale.code).toBe(1);
    expect(stale.lines[0]).toBe('FAIL trim 01: 2 problem(s)');
    expect(stale.out).toContain('stale or foreign result');
    expect(stale.out).toContain(`${b}: ccVersion 9.9.8, expected 9.9.9`);

    const inc = driver('tasks-harvest', 'trim', tasks);
    expect(inc.code).toBe(1);
    expect(inc.lines[0]).toBe('tasks-harvest trim: 1/2 PASS, 1 warn — INCOMPLETE — rerun: 01');
    expect(inc.out).toContain('01: FAIL: stale or foreign result');
    expect(fs.existsSync(path.join(T, 'trim/trim-results.json'))).toBe(false);

    md('set/b.md', '9.9.9');
    write('trim/trim-result-01.json', { task: '01', tasksDigest: parsed.tasksDigest, version: '9.9.9', id: 'b', filesWritten: [b], summary: 's' });
    const done = driver('tasks-harvest', 'trim', tasks);
    expect(done.code).toBe(0);
    expect(done.lines[0]).toBe(`tasks-harvest trim: 2/2 PASS, 1 warn — COMPLETE -> ${path.join(T, 'trim/trim-results.json')}`);
    const merged = JSON.parse(fs.readFileSync(path.join(T, 'trim/trim-results.json'), 'utf8'));
    expect(merged.results.map(r => r.id)).toEqual(['a', 'b']);
    expect(fs.readFileSync(path.join(T, 'run.log'), 'utf8')).toMatch(/^\d\d:\d\d\ttasks-harvest trim .*: tasks-harvest trim: 2\/2 PASS/m);
  });

  it('trim: a result for another tasks version is caught even when the agent copied a wrong version', () => {
    const p = write('ver/packet.json', {});
    const f = md('ver/a.md', '9.9.8');
    const tasks = write('ver/tasks.json', [{ id: 'a', packet: p, paths: [f] }]);
    const { tasksDigest } = JSON.parse(driver('tasks-args', 'trim', tasks, '--version', '9.9.9', '--model', 'm', '--effort', 'e').lines[0]);
    write('ver/trim-result-00.json', { task: '00', tasksDigest, version: '9.9.8', id: 'a', filesWritten: [f], summary: 's' });
    const r = driver('tasks-check', 'trim', tasks, '00');
    expect(r.code).toBe(1);
    expect(r.out).toContain('version 9.9.8 != 9.9.9');
  });

  it('realign: the entry version wins, the classification enum is enforced', () => {
    const p = write('realign/packet.json', {});
    const f = md('realign/a.md', '9.9.7');
    const tasks = write('realign/tasks.json', { version: '9.9.9', tasks: [{ id: 'a', packet: p, paths: [f], version: '9.9.7' }] });
    const { tasksDigest } = JSON.parse(driver('tasks-args', 'realign', tasks, '--version', '9.9.9', '--model', 'm', '--effort', 'e').lines[0]);
    write('realign/realign-result-00.json', { task: '00', tasksDigest, version: '9.9.7', id: 'a', classification: 'bump', filesWritten: [f], summary: 's' });
    const bad = driver('tasks-check', 'realign', tasks, '00');
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('classification must be "mechanical-bump" or "retrim"');
    write('realign/realign-result-00.json', { task: '00', tasksDigest, version: '9.9.7', id: 'a', classification: 'retrim', filesWritten: [f], summary: 's' });
    const ok = driver('tasks-check', 'realign', tasks, '00');
    expect(ok.lines[0]).toBe('PASS realign 00 a: retrim, 1 file(s) written');
    const h = driver('tasks-harvest', 'realign', tasks);
    expect(h.lines[0]).toMatch(/^tasks-harvest realign: 1\/1 PASS \(retrim 1, mechanical 0\), 0 warn — COMPLETE -> /);
    expect(driver('tasks-args', 'realign', tasks, '--version', '9.9.8', '--model', 'm', '--effort', 'e').code).toBe(1);
  });

  it('verify: ids are required, findings must cover exactly the ids, harvest lists the refuted', () => {
    const p = write('verify/packet.json', {});
    const noIds = write('verify/bad.json', [{ name: 'g00', packet: p }]);
    const r0 = driver('tasks-args', 'verify', noIds, '--version', '9.9.9', '--model', 'm', '--effort', 'e');
    expect(r0.code).toBe(1);
    expect(r0.out).toContain('ids is required');

    const tasks = write('verify/tasks.json', [{ name: 'g00', packet: p, ids: ['a', 'b', 'c'] }]);
    // The capture `driver check` recorded for this version is reused, never re-probed.
    const probe = path.join(T, 'tmp/turnprobe-9.9.9-1');
    write('tmp/turnprobe-9.9.9-1/req-1.json', {});
    write('tmp/turnprobe-9.9.9.json', { dir: probe, at: 'now' });
    const vArgs = JSON.parse(driver('tasks-args', 'verify', tasks, '--version', '9.9.9', '--model', 'm', '--effort', 'e').lines[0]);
    expect(vArgs).toMatchObject({ capturesDir: probe, capturesFrom: 'check' });
    const { tasksDigest } = vArgs;
    const f = (id, pass = true) => ({ id, pass, checks: 'read the deployed body', issue: pass ? null : 'lost the limit', requiredAction: pass ? null : 'restore it' });
    write('verify/verify-result-00.json', { task: '00', tasksDigest, version: '9.9.9', name: 'g00', findings: [f('a'), f('b'), f('z'), { id: 'a', pass: false }] });
    const bad = driver('tasks-check', 'verify', tasks, '00');
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('FAIL: missing finding for c');
    expect(bad.out).toContain('FAIL: finding for unassigned id z');
    expect(bad.out).toContain('FAIL: duplicate finding for a');

    write('verify/verify-result-00.json', { task: '00', tasksDigest, version: '9.9.9', name: 'g00', findings: [f('a'), { ...f('b', false), issue: '' }, f('c')] });
    expect(driver('tasks-check', 'verify', tasks, '00').out).toContain('finding b: pass=false needs a non-empty issue');

    write('verify/verify-result-00.json', { task: '00', tasksDigest, version: '9.9.9', name: 'g00', findings: [f('a'), f('b', false), f('c')] });
    const ok = driver('tasks-check', 'verify', tasks, '00');
    expect(ok.code).toBe(0);
    expect(ok.lines[0]).toBe('PASS verify 00 g00: 3 finding(s), 1 refuted');
    const h = driver('tasks-harvest', 'verify', tasks);
    expect(h.code).toBe(0);
    expect(h.lines[0]).toMatch(/^tasks-harvest verify: 1\/1 PASS, 3 finding\(s\), 1 refuted, 0 warn — COMPLETE -> /);
    expect(h.lines[1]).toBe('refuted: b');
  });

  it('trim-verify: coupled partition, stage flag, two result files per task', () => {
    const p = write('tv/packet.json', {});
    const files = ['a', 'b', 'x', 'y', 'z'].map(id => md(`tv/${id}.md`));
    const tasks = write('tv/tasks.json', [
      { id: 'a', packet: p, paths: [files[0]], verdict: { coveredBy: [{ carrierId: 'b', quote: 'q' }] } },
      { id: 'b', packet: p, paths: [files[1]], verdict: { coveredBy: [] } },
      { id: 'x', packet: p, paths: [files[2]], verdict: { coveredBy: [{ carrierId: 'not-in-batch' }] } },
      { id: 'y', packet: p, paths: [files[3]], verdict: { coveredBy: [{ carrierId: 'y' }] } },
      { id: 'z', packet: p, paths: [files[4]] },
    ]);
    expect(driver('tasks-args', 'trim-verify', tasks, '--version', '9.9.9', '--model', 'm', '--effort', 'e').code).toBe(1);
    const cap = path.join(T, 'tv-captures');
    write('tv-captures/req-2.json', {});
    fs.mkdirSync(path.join(T, 'empty-captures'), { recursive: true });
    const noBodies = driver('tasks-args', 'trim-verify', tasks, '--version', '9.9.9', '--model', 'm', '--trim-effort', 'medium', '--verify-effort', 'xhigh', '--captures', path.join(T, 'empty-captures'));
    expect(noBodies.code).toBe(1);
    expect(noBodies.out).toContain('holds no req-*.json request bodies');
    const a = driver('tasks-args', 'trim-verify', tasks, '--version', '9.9.9', '--model', 'm', '--trim-effort', 'medium', '--verify-effort', 'xhigh', '--captures', cap);
    expect(a.code).toBe(0);
    const parsed = JSON.parse(a.lines[0]);
    expect(Object.keys(parsed)).toEqual(['version', 'tasksPath', 'count', 'tasksDigest', 'model', 'repoDir', 'remindersDir', 'trimEffort', 'verifyEffort', 'coupled', 'capturesDir', 'capturesFrom']);
    expect(parsed).toMatchObject({ capturesDir: cap, capturesFrom: 'flag' });
    expect(parsed.coupled).toEqual(['00', '01']);

    expect(driver('tasks-check', 'trim-verify', tasks, '00').code).toBe(2);
    write('tv/trim-verify-trim-00.json', { task: '00', tasksDigest: parsed.tasksDigest, version: '9.9.9', id: 'a', filesWritten: [files[0]], summary: 's' });
    expect(driver('tasks-check', 'trim-verify', tasks, '00', '--stage', 'trim').lines[0]).toBe('PASS trim-verify 00 trim a: 1 file(s) written');
    write('tv/trim-verify-verify-00.json', { task: '00', tasksDigest: parsed.tasksDigest, version: '9.9.9', id: 'a', findings: [{ id: 'a', pass: false, issue: 'lost', requiredAction: 'restore' }] });
    expect(driver('tasks-check', 'trim-verify', tasks, '00', '--stage', 'verify').lines[0]).toBe('PASS trim-verify 00 verify a: refuted');
    const h = driver('tasks-harvest', 'trim-verify', tasks);
    expect(h.code).toBe(1);
    expect(h.lines[0]).toBe('tasks-harvest trim-verify: 1/5 PASS (trim 1/5, verify 1/5), 1 refuted, 0 warn — INCOMPLETE — rerun: 01,02,03,04');
    expect(h.lines[1]).toBe('refuted: a');
  });

  it('rejects a bad tasks file and an out-of-range task with exit 2', () => {
    const p = write('bad/packet.json', {});
    const dup = write('bad/tasks.json', [
      { id: 'a', packet: p, paths: [path.join(T, 'bad/x.md')] },
      { id: 'a', packet: path.join(T, 'bad/missing.json'), paths: [path.join(T, 'bad/x.md')] },
    ]);
    const r = driver('tasks-args', 'trim', dup, '--version', '9.9.9', '--model', 'm', '--effort', 'e');
    expect(r.code).toBe(1);
    expect(r.out).toContain('id a is also in task 00');
    expect(r.out).toContain('packet not found');
    expect(r.out).toContain('two writers on one file race');
    expect(driver('tasks-check', 'trim', dup, '00').code).toBe(2);
    const one = write('bad/one.json', [{ id: 'a', packet: p, paths: [path.join(T, 'bad/x.md')] }]);
    expect(driver('tasks-check', 'trim', one, '01').code).toBe(2);
  });
});

describe.skipIf(!hasDriver)('driver classify-args / audit-args read the builders\' manifests', () => {
  beforeAll(() => {
    T = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-args-'));
    fs.mkdirSync(path.join(T, 'tc/lcc/system-reminders'), { recursive: true });
    fs.symlinkSync(path.join(T, 'tc/lcc/system-reminders'), path.join(T, 'tc/system-reminders'));
  });
  afterAll(() => fs.rmSync(T, { recursive: true, force: true }));

  it('classify-args prints the path-only args with part counts and refuses the old flow', () => {
    const flags = ['--model', 'sonnet', '--verify-model', 'opus', '--classify-effort', 'high', '--verify-effort', 'medium'];
    write('tmp/classify-evidence-9.9.8/classify-evidence-00.json', {});
    const old = driver('classify-args', '9.9.8', ...flags);
    expect(old.code).toBe(1);
    expect(old.out).toContain('OLD classify-evidence-NN.json packets');

    const dir = path.join(T, 'tmp/classify-evidence-9.9.9');
    // A manifest from before the Read-sized parts is refused, not guessed at.
    write('tmp/classify-evidence-9.9.9/manifest.json', { version: '9.9.9', chunkCount: 2, chunks: [{ chunk: '00', file: 'chunk-00.json' }, { chunk: '01', file: 'chunk-01.json' }] });
    write('tmp/classify-evidence-9.9.9/chunk-00.json', {});
    write('tmp/classify-evidence-9.9.9/chunk-01.json', {});
    const noParts = driver('classify-args', '9.9.9', ...flags);
    expect(noParts.code).toBe(1);
    expect(noParts.out).toContain('lists no mdParts');
    write('tmp/classify-evidence-9.9.9/manifest.json', {
      version: '9.9.9', chunkCount: 2,
      chunks: [{ chunk: '00', file: 'chunk-00.json', mdParts: ['chunk-00.md'] }, { chunk: '01', file: 'chunk-01.json', mdParts: ['chunk-01.part1.md', 'chunk-01.part2.md'] }],
    });
    write('tmp/classify-evidence-9.9.9/chunk-00.md', {});
    write('tmp/classify-evidence-9.9.9/chunk-01.part1.md', {});
    expect(driver('classify-args', '9.9.9', ...flags).out).toContain('packet part(s) missing');
    write('tmp/classify-evidence-9.9.9/chunk-01.part2.md', {});
    const r = driver('classify-args', '9.9.9', ...flags);
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(JSON.parse(r.lines[0])).toEqual({
      version: '9.9.9', evidenceDir: dir, chunkCount: 2, mdParts: [1, 2], model: 'sonnet', verifyModel: 'opus', classifyEffort: 'high', verifyEffort: 'medium', repoDir: REPO,
    });
    expect(Object.keys(JSON.parse(r.lines[0]))).toEqual(['version', 'evidenceDir', 'chunkCount', 'mdParts', 'model', 'verifyModel', 'classifyEffort', 'verifyEffort', 'repoDir']);
    const noDefaults = driver('classify-args', '9.9.9', '--model', 'sonnet');
    expect(noDefaults.code).toBe(1);
    expect(noDefaults.out).toContain('missing --verify-model, --classify-effort, --verify-effort');
  });

  it('audit-args reproduces the builder line and fails when the active set moved', () => {
    const setA = path.join(T, 'tc/lobotomized-claude-code/system-prompts-a');
    const setB = path.join(T, 'tc/lobotomized-claude-code/system-prompts-b');
    fs.mkdirSync(setA, { recursive: true });
    fs.mkdirSync(setB, { recursive: true });
    fs.symlinkSync(setA, path.join(T, 'tc/system-prompts'));
    const dir = path.join(T, 'tmp/audit-packets-9.9.9');
    const packet = write('tmp/audit-packets-9.9.9/audit-packet-00.json', {});
    const md = write('tmp/audit-packets-9.9.9/audit-packet-00.md', {});
    write('tmp/audit-packets-9.9.9/audit-manifest.json', {
      format: 2, version: '9.9.9', corpus: { activeSet: setA }, groupCount: 1,
      groups: [{ name: 'g00', packet, md, mdParts: [md], verdicts: path.join(dir, 'verdicts-00.json'), ids: ['a'] }],
    });
    const focus = write('focus.txt', 'audit against the new card\n');
    const r = driver('audit-args', '9.9.9', '--model', 'opus', '--effort', 'medium', '--focus-file', focus);
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(1);
    const parsed = JSON.parse(r.lines[0]);
    const rem = fs.realpathSync(path.join(T, 'tc/lcc/system-reminders'));
    expect(Object.keys(parsed)).toEqual(['version', 'packetDir', 'groupCount', 'mdParts', 'activeSet', 'repoDir', 'remindersDir', 'model', 'effort', 'focus']);
    expect(parsed).toEqual({ version: '9.9.9', packetDir: dir, groupCount: 1, mdParts: [1], activeSet: setA, repoDir: REPO, remindersDir: rem, model: 'opus', effort: 'medium', focus: 'audit against the new card' });
    expect(Object.keys(JSON.parse(driver('audit-args', '9.9.9', '--model', 'opus', '--effort', 'medium').lines[0]))).toEqual(['version', 'packetDir', 'groupCount', 'mdParts', 'activeSet', 'repoDir', 'remindersDir', 'model', 'effort']);
    const noModel = driver('audit-args', '9.9.9');
    expect(noModel.code).toBe(1);
    expect(noModel.out).toContain('missing --model, --effort');
    const other = path.join(T, 'tc/other-reminders');
    fs.mkdirSync(other, { recursive: true });
    expect(JSON.parse(driver('audit-args', '9.9.9', '--model', 'opus', '--effort', 'medium', '--reminders-dir', other).lines[0]).remindersDir).toBe(fs.realpathSync(other));
    const bad = driver('audit-args', '9.9.9', '--model', 'opus', '--effort', 'medium', '--repo-dir', T);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('is not a tweakcc-fixed checkout');

    fs.rmSync(path.join(T, 'tc/system-prompts'));
    fs.symlinkSync(setB, path.join(T, 'tc/system-prompts'));
    const moved = driver('audit-args', '9.9.9', '--model', 'opus', '--effort', 'medium');
    expect(moved.code).toBe(1);
    expect(moved.out).toContain('readlink ~/.tweakcc/system-prompts is now');
    expect(driver('audit-args', '9.9.7', '--model', 'opus', '--effort', 'medium').out).toContain('Build the packets first');
  });
});

// Compact output: findings and one summary line by default, the full step log
// on disk, everything live with --verbose. Exercised through `validate` against
// a fixture repo and override set.
describe.skipIf(!hasDriver)('driver output is compact by default', () => {
  let FAKE;
  beforeAll(() => {
    T = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-compact-'));
    FAKE = path.join(T, 'repo');
    write('repo/data/prompts/prompts-9.9.8.json', { version: '9.9.8', prompts: [{ id: 'a', pieces: ['hello'], identifiers: [], identifierMap: {} }] });
    write('repo/data/prompts/prompts-9.9.9.json', { version: '9.9.9', prompts: [{ id: 'a', pieces: ['hello'], identifiers: [], identifierMap: {} }] });
    write('repo/tools/promptExtractor.js', '');
    // validate runs the content-swap gate from the checkout it is pointed at.
    for (const f of ['checkContentSwap.mjs', 'lib/contentSwap.mjs', 'lib/overrideSets.cjs']) {
      fs.mkdirSync(path.dirname(path.join(FAKE, 'tools', f)), { recursive: true });
      fs.copyFileSync(path.join(REPO, 'tools', f), path.join(FAKE, 'tools', f));
    }
    md('tc/lobotomized-claude-code/system-prompts-x/a.md');
  });
  afterAll(() => fs.rmSync(T, { recursive: true, force: true }));
  const run = (...a) => {
    const r = spawnSync('node', [DRIVER, ...a], { encoding: 'utf8', env: { ...env(), TWEAKCC_REPO: FAKE } });
    return { code: r.status, lines: (r.stdout || '').replace(ANSI, '').trim().split('\n') };
  };

  it('prints the log path and one summary line on success, and appends the run log', () => {
    const r = run('validate', '9.9.9');
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      `· full log: ${path.join(T, 'tmp/showtime-validate.log')}`,
      '✓ validate 9.9.9: all 1 set(s) clean; ccVersion null: 0; content swap: 0 unacknowledged',
    ]);
    expect(fs.readFileSync(path.join(T, 'tmp/showtime-validate.log'), 'utf8')).toContain('system-prompts-x: orphan=0 UNKNOWN_N=0 unbound=0');
    expect(fs.readFileSync(path.join(T, 'run.log'), 'utf8')).toMatch(/^\d\d:\d\d\tvalidate 9\.9\.9: validate 9\.9\.9: all 1 set\(s\) clean; ccVersion null: 0; content swap: 0 unacknowledged$/m);
  });

  it('prints the whole failing step with its detail lines, and keeps the exit code', () => {
    md('tc/lobotomized-claude-code/system-prompts-x/gone.md');
    const r = run('validate', '9.9.9');
    fs.rmSync(path.join(T, 'tc/lobotomized-claude-code/system-prompts-x/gone.md'));
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([
      'Validate override sets against 9.9.9',
      '✗ system-prompts-x: orphan=1 UNKNOWN_N=0 unbound=0',
      '    orphan   gone',
      `· full log: ${path.join(T, 'tmp/showtime-validate.log')}`,
      '✗ validate 9.9.9: 1 problem(s) across 1 set(s); ccVersion null: 0; content swap: 0 unacknowledged',
    ]);
  });

  it('prints everything live with --verbose', () => {
    const r = run('validate', '9.9.9', '--verbose');
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe('Validate override sets against 9.9.9');
    expect(r.lines).toContain('✓ system-prompts-x: orphan=0 UNKNOWN_N=0 unbound=0');
    expect(r.lines).toContain('✓ ccVersion: null: 0');
    expect(r.lines[r.lines.length - 1]).toBe('✓ validate 9.9.9: all 1 set(s) clean; ccVersion null: 0; content swap: 0 unacknowledged');
  });
});
