// Partial-result salvage on retry.
//
// A group agent is handed 15-30 prompts and must return one object covering all
// of them. A single bad id, a dropped entry or a malformed fence used to discard
// the whole answer and restart from prompt one — on CC 2.1.237 that hit 3 of 10
// stage-1 agents, each re-judging ~24 prompts when a couple were wrong.
//
// These tests exercise the real script's agentWithRetry through stubbed globals.
// They skip when .claude/workflows is absent, since that directory is gitignored.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const WF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.claude/workflows');
const FILE = 'audit-new-prompts-stage1.workflow.js';
const has = fs.existsSync(path.join(WF, FILE));
const S3 = 'audit-new-prompts-stage3-verify.workflow.js';
const hasS3 = fs.existsSync(path.join(WF, S3));
const CLS = 'classify-and-name-prompts.workflow.js';
const hasCls = fs.existsSync(path.join(WF, CLS));

// Pull agentWithRetry (and the textJson/parseTextJson it closes over) out of the
// real script and run it against a scripted sequence of agent replies.
const harness = (replies, { textJson = false, file = FILE } = {}) => {
  const src = fs.readFileSync(path.join(WF, file), 'utf8');
  const fn = src.match(/async function agentWithRetry[\s\S]*?\n}\n/)[0];
  const prompts = [];
  const logs = [];
  let call = 0;
  const ctx = {
    textJson,
    parseTextJson: o => o,
    agent: async (prompt) => { prompts.push(prompt); return replies[call++]; },
    log: m => logs.push(String(m)),
    Array, Object, String, Error, Set, Map, Promise, JSON, Math, Number, console,
  };
  vm.createContext(ctx);
  vm.runInContext(`${fn}; globalThis.__f = agentWithRetry;`, ctx);
  return { run: (...a) => ctx.__f(...a), prompts, logs };
};

describe.skipIf(!has)('stage-1 retry salvages partial answers', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const v = id => ({ id, verdict: 'trim' });

  it('keeps good verdicts and re-asks only for the missing ones', async () => {
    const h = harness([
      { verdicts: [v('a'), v('b')] },   // two of four
      { verdicts: [v('c'), v('d')] },   // the rest
    ]);
    const out = await h.run('BASE', { label: 'audit:g0' }, 3, ids);
    expect(out.verdicts.map(x => x.id)).toEqual(ids);
    // The retry names exactly the outstanding ids and says not to repeat.
    expect(h.prompts[1]).toContain('PARTIAL RETRY');
    expect(h.prompts[1]).toContain('  - c');
    expect(h.prompts[1]).toContain('  - d');
    expect(h.prompts[1]).not.toContain('  - a');
  });

  it('returns verdicts in the caller declared order, not the answer order', async () => {
    const h = harness([
      { verdicts: [v('d'), v('b')] },
      { verdicts: [v('c'), v('a')] },
    ]);
    const out = await h.run('BASE', { label: 'audit:g0' }, 3, ids);
    expect(out.verdicts.map(x => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('discards an id nobody assigned rather than counting it as progress', async () => {
    const h = harness([
      { verdicts: [v('a'), v('made-up')] },
      { verdicts: [v('b'), v('c'), v('d')] },
    ]);
    const out = await h.run('BASE', { label: 'audit:g0' }, 3, ids);
    expect(out.verdicts.map(x => x.id)).toEqual(ids);
    expect(h.logs.join(' ')).toContain('discarded 1');
  });

  it('ignores a duplicate of something already kept', async () => {
    const h = harness([
      { verdicts: [v('a')] },
      { verdicts: [v('a'), v('b'), v('c')] },
      { verdicts: [v('d')] },
    ]);
    const out = await h.run('BASE', { label: 'audit:g0' }, 3, ids);
    expect(out.verdicts.map(x => x.id)).toEqual(ids);
  });

  it('survives an attempt that returns nothing at all', async () => {
    const h = harness([
      { verdicts: [v('a'), v('b')] },
      null,
      { verdicts: [v('c'), v('d')] },
    ]);
    const out = await h.run('BASE', { label: 'audit:g0' }, 3, ids);
    expect(out.verdicts.map(x => x.id)).toEqual(ids);
  });

  it('names precisely what is still missing when it gives up', async () => {
    const h = harness([
      { verdicts: [v('a'), v('b')] },
      { verdicts: [] },
      { verdicts: [] },
    ]);
    await expect(h.run('BASE', { label: 'audit:g0' }, 3, ids)).rejects.toThrow(/still missing 2 of 4.*c, d/s);
  });

  it('sends the original prompt on the first attempt, unmodified', async () => {
    const h = harness([{ verdicts: ids.map(v) }]);
    await h.run('BASE', { label: 'audit:g0' }, 3, ids);
    expect(h.prompts[0]).toBe('BASE');
  });

  it('falls back to all-or-nothing when the group carries only a count', async () => {
    // A count cannot tell a real id from a fabricated one, so salvaging there
    // would silently accept invented work.
    const h = harness([null, { verdicts: [v('a')] }]);
    const out = await h.run('BASE', { label: 'audit:g0' }, 3, null);
    expect(out.verdicts).toHaveLength(1);
    expect(h.prompts.every(p => p === 'BASE')).toBe(true);
  });
});


describe.skipIf(!hasS3)('stage-3 verify salvages the same way', () => {
  const ids = ['a', 'b', 'c'];
  const f = id => ({ id, pass: true });

  it('keeps findings across attempts and re-asks only the rest', async () => {
    const h = harness([{ findings: [f('a')] }, { findings: [f('b'), f('c')] }], { file: S3 });
    const out = await h.run('BASE', { label: 'verify:g0' }, 3, ids);
    expect(out.findings.map(x => x.id)).toEqual(ids);
    expect(h.prompts[1]).toContain('PARTIAL RETRY');
    expect(h.prompts[1]).toContain('  - b');
    expect(h.prompts[1]).not.toContain('  - a');
  });

  it('still accepts a whole answer when no id list was supplied', async () => {
    const h = harness([{ findings: [f('a')] }], { file: S3 });
    const out = await h.run('BASE', { label: 'verify:g0' }, 3, null);
    expect(out.findings).toHaveLength(1);
  });
});

describe.skipIf(!hasCls)('classify salvages by hash and respects reject', () => {
  const hashes = ['h1', 'h2'];
  const v = hash => ({ hash, facing: 'model' });

  it('keeps verdicts across attempts, keyed by hash', async () => {
    const h = harness([{ verdicts: [v('h1')] }, { verdicts: [v('h2')] }], { file: CLS });
    const out = await h.run('BASE', { label: 'classify:c0' }, 3, null, null, hashes);
    expect(out.verdicts.map(x => x.hash)).toEqual(hashes);
    expect(h.prompts[1]).toContain('  - h2');
  });

  it('discards a complete-but-rejected set instead of letting it block retries', async () => {
    // A quality rejection must not leave the kept map full, or every later
    // attempt becomes a no-op that re-returns the same rejected answer.
    let seen = 0;
    const reject = () => (++seen === 1 ? 'bad evidence' : null);
    const h = harness(
      [{ verdicts: hashes.map(v) }, { verdicts: hashes.map(v) }],
      { file: CLS }
    );
    const out = await h.run('BASE', { label: 'classify:c0' }, 3, reject, null, hashes);
    expect(out.verdicts.map(x => x.hash)).toEqual(hashes);
    expect(h.logs.join(' ')).toContain('complete but rejected');
  });
});
