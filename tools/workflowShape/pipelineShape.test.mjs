// The workflow scripts live under .claude/, which is gitignored, so these tests
// skip cleanly when the scripts are absent. They exist because the property
// under test is a SCHEDULING shape that nothing else can see: a workflow that
// silently reverts to stage-major still produces correct output, just slower,
// and no other check would notice.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const WF = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.claude/workflows'
);
const has = f => fs.existsSync(path.join(WF, f));

// Run a workflow script with stubbed globals, timing every agent turn so the
// interleaving is observable. `slow` names the one label that takes long.
const runShaped = async (file, ctxExtra, slow) => {
  const src = fs
    .readFileSync(path.join(WF, file), 'utf8')
    .replace(/^export const meta/m, 'const meta');
  const timeline = [];
  const logs = [];
  const ctx = {
    ...ctxExtra,
    pipeline: async (items, ...stages) =>
      Promise.all(
        items.map(async (it, i) => {
          let v = it;
          for (const s of stages) {
            try {
              v = await s(v, it, i);
            } catch {
              return null;
            }
          }
          return v;
        })
      ),
    parallel: async thunks =>
      Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null))),
    agent: async () => null,
    phase: () => {},
    log: m => logs.push(String(m)),
    console,
    JSON, Math, Number, Array, Object, String, Error, Set, Map, Promise, RegExp, Date,
    setTimeout, clearTimeout,
  };
  const patched =
    'globalThis.__t = [];' +
    src.replace(
      /async function agentWithRetry\([\s\S]*?\n}\n/,
      `async function agentWithRetry(prompt, o) {
         const [which, id] = String(o.label || '').split(':');
         globalThis.__t.push(which + ':start:' + id);
         await new Promise(r => setTimeout(r, ${JSON.stringify(slow)} === (which + ':' + id) ? 220 : 25));
         globalThis.__t.push(which + ':end:' + id);
         return { id, verdicts: [], filesWritten: [], summary: '', pass: true, issue: '', requiredAction: '' };
       }\n`
    );
  try {
    await vm.runInNewContext(`(async () => { ${patched} })()`, ctx, { timeout: 20000 });
  } catch {
    /* completeness checks over stub data are not what is under test */
  }
  timeline.push(...(vm.runInNewContext('globalThis.__t', ctx) || []));
  return { timeline, logs, at: s => timeline.indexOf(s) };
};

describe.skipIf(!has('classify-and-name-prompts.workflow.js'))(
  'classify-and-name-prompts is a per-item pipeline',
  () => {
    it('verifies one group while another is still classifying', async () => {
      const groups = [['c0'], ['c1'], ['c2'], ['c3']];
      const shared = {
        version: '9.9.9',
        groups,
        validateResults: false,
        expectedHashes: { c0: 0, c1: 0, c2: 0, c3: 0 },
        evidencePaths: { c0: '/tmp/e0.json', c1: '/tmp/e1.json', c2: '/tmp/e2.json', c3: '/tmp/e3.json' },
      };
      const { timeline, at } = await runShaped(
        'classify-and-name-prompts.workflow.js',
        { input: shared, args: shared },
        'classify:c0'
      );
      const firstVerify = timeline.findIndex(e => e.startsWith('verify:start'));
      const lastClassifyEnd = timeline.reduce(
        (acc, e, i) => (e.startsWith('classify:end') ? i : acc),
        -1
      );
      expect(firstVerify).toBeGreaterThan(-1);
      // Under the old stage-major shape this was impossible by construction.
      expect(firstVerify).toBeLessThan(lastClassifyEnd);
      expect(at('verify:end:c1')).toBeLessThan(at('classify:end:c0'));
    });
  }
);

describe.skipIf(!has('audit-trim-and-verify.workflow.js'))(
  'audit-trim-and-verify keeps the barrier only where citations require it',
  () => {
    // a cites b, so BOTH are coupled: b's verifier is the one that would read
    // a's half-written body. x/y/z cite nothing in this batch.
    const tasks = [
      { id: 'a', packet: '/tmp/a.json', verdict: { coveredBy: [{ carrierId: 'b' }] } },
      { id: 'b', packet: '/tmp/b.json', verdict: { coveredBy: [] } },
      { id: 'x', packet: '/tmp/x.json', verdict: { coveredBy: [{ carrierId: 'not-in-batch' }] } },
      { id: 'y', packet: '/tmp/y.json', verdict: { coveredBy: [] } },
      { id: 'z', packet: '/tmp/z.json', verdict: {} },
    ];
    const run = () =>
      runShaped('audit-trim-and-verify.workflow.js', { args: { version: '9.9.9', tasks } }, 'trim:x');

    it('partitions on the in-batch citation graph, both directions', async () => {
      const { logs } = await run();
      expect(logs[0]).toContain('3 independent');
      expect(logs[0]).toContain('2 coupled');
    });

    it('pipelines an independent item past a slow sibling', async () => {
      const { at } = await run();
      expect(at('verify:start:y')).toBeGreaterThan(-1);
      expect(at('verify:start:y')).toBeLessThan(at('trim:end:x'));
    });

    it('holds coupled verifies until every coupled trim has landed', async () => {
      const { at } = await run();
      const firstCoupledVerify = Math.min(at('verify:start:a'), at('verify:start:b'));
      const lastCoupledTrim = Math.max(at('trim:end:a'), at('trim:end:b'));
      expect(firstCoupledVerify).toBeGreaterThan(lastCoupledTrim);
    });
  }
);


// A static guard alongside the behavioural ones. The wave loop is easy to
// reintroduce by habit and produces correct output, so nothing else notices —
// but it reimposes a barrier per wave, which is what this whole change removed.
describe('no workflow reintroduces a wave loop', () => {
  const files = fs.existsSync(WF) ? fs.readdirSync(WF).filter(f => f.endsWith('.workflow.js')) : [];

  it.skipIf(!files.length)('has no `+= batchSize` loop anywhere', () => {
    const offenders = files.filter(f =>
      /(?:off|offset|i)\s*\+=\s*batchSize/.test(fs.readFileSync(path.join(WF, f), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  it.skipIf(!files.length)('throttles with a sliding-window gate where it throttles at all', () => {
    // Every workflow that still accepts `batchSize` must implement it as the
    // sliding-window gate, never as slice-and-await.
    const bad = files.filter(f => {
      const src = fs.readFileSync(path.join(WF, f), 'utf8');
      return src.includes('batchSize') && !src.includes('const gate = ');
    });
    expect(bad).toEqual([]);
  });
});
