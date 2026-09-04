// Locks the removed-id gate against the miss found on CC 2.1.261: a prompt made
// almost entirely of `${…}` slots has no literal run long enough for the 25-char
// window, so every probe pass came back empty and the id fell through to
// `gone` — which tells the operator to archive an override that is still live.
// Two real prompts hit it that bump (`Published ${.path)} at ${.url)}${}…` and
// the computer-use background-element result), and both were sitting in the
// classify sidecar at the time.
//
// The tool is a script, not a module: it does its work at import time. So this
// drives it as a subprocess against fixtures, which is also the only way to
// assert the bucketing the pipeline actually reads.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(
  new URL('./checkRemovedIdCoverage.mjs', import.meta.url)
);
let dir;

const write = (name, value) => {
  const p = path.join(dir, name);
  fs.writeFileSync(
    p,
    typeof value === 'string' ? value : JSON.stringify(value)
  );
  return p;
};

// TWEAKCC_CLASSIFY_DIR points the sidecar scan at an empty directory: reading
// the real /tmp would let whatever bump is in flight decide the answer.
const run = (cli, prev, cur) => {
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, TWEAKCC_CLASSIFY_DIR: path.join(dir, 'empty') },
  };
  try {
    return execFileSync(process.execPath, [TOOL, cli, prev, cur], opts);
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
};

// The slot-only shape, from CC 2.1.259's `tool-result-artifact-published`.
const slotOnly = {
  id: 'tool-result-artifact-published',
  version: '2.1.259',
  pieces: ['Published ${', '(', '.path)} at ${', '(', '.url)}${', '}'],
  identifiers: [0, 1, 2, 1, 3],
  identifierMap: { 0: 'VAR_0', 1: 'VAR_1', 2: 'VAR_2', 3: 'VAR_3' },
};

// A real removal: long, distinctive prose that is nowhere in the bundle.
const realRemoval = {
  // A synthetic id: a REAL one gets an `archived` verdict in
  // data/removed-id-allowlist.json the moment that removal is processed, and
  // the gate then correctly stops listing it — which fails this test for the
  // opposite of the reason it exists.
  id: 'tool-result-fixture-genuinely-absent',
  version: '2.1.259',
  pieces: [
    'A sub-goal is the smallest unit of work that is worth narrating on its ' +
      'own, and it ends when every tool call it required has returned.',
  ],
  identifiers: [],
  identifierMap: {},
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'removed-id-'));
  fs.mkdirSync(path.join(dir, 'empty'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('checkRemovedIdCoverage: prompts with little literal text', () => {
  it('does not call a slot-only prompt removed while its text is in the bundle', () => {
    const out = run(
      write(
        'cli.js',
        'function q(e){return `Published ${a(e.path)} at ${a(e.url)}${b}`}'
      ),
      write('prev.json', { prompts: [slotOnly] }),
      write('cur.json', { prompts: [] })
    );
    expect(out).toMatch(/STILL IN BUNDLE[\s\S]*tool-result-artifact-published/);
    expect(out).not.toMatch(
      /truly removed, no recorded verdict:[\s\S]*tool-result-artifact-published/
    );
  });

  it('ignores a piece carrying a minified bracket key, which changes per build', () => {
    // `[_.kind]` on one build is `[k.kind]` on the next, so requiring it makes
    // a live prompt read as removed — the computer-use case on CC 2.1.261.
    const prompt = {
      id: 'tool-result-computer-use-element',
      version: '2.1.259',
      pieces: ['This element (${', '}) cannot be ${', '[_.kind]} while ${', ')} is in the '],
      identifiers: [0, 1, 2],
      identifierMap: { 0: 'A', 1: 'B', 2: 'C' },
    };
    const out = run(
      write(
        'cli-bk.js',
        'x=`This element (${a}) cannot be ${L[k.kind]} while ${f(b)} is in the ${s}`'
      ),
      write('prev-bk.json', { prompts: [prompt] }),
      write('cur-bk.json', { prompts: [] })
    );
    expect(out).toMatch(
      /STILL IN BUNDLE[\s\S]*tool-result-computer-use-element/
    );
  });

  it('still calls a genuinely absent prompt removed', () => {
    const out = run(
      write('cli-gone.js', 'function q(){return "unrelated bundle text"}'),
      write('prev-gone.json', { prompts: [realRemoval] }),
      write('cur-gone.json', { prompts: [] })
    );
    expect(out).toMatch(
      /truly removed[\s\S]*tool-result-fixture-genuinely-absent/
    );
  });

  it('reports no-probe-surface rather than a removal when it cannot test either way', () => {
    const out = run(
      write('cli-np.js', 'function q(){return "x"}'),
      write('prev-np.json', {
        prompts: [
          {
            id: 'tool-result-slotless',
            version: '2.1.259',
            pieces: ['${', '}${', '}'],
            identifiers: [0, 1],
            identifierMap: { 0: 'A', 1: 'B' },
          },
        ],
      }),
      write('cur-np.json', { prompts: [] })
    );
    expect(out).toMatch(/no probe surface/);
    expect(out).toMatch(/NO PROBE SURFACE[\s\S]*tool-result-slotless/);
    expect(out).not.toMatch(
      /truly removed, no recorded verdict:[\s\S]*tool-result-slotless/
    );
  });
});
