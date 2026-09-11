import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOL = path.join(import.meta.dirname, 'checkMapDrift.mjs');

const run = (prev, next) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapdrift-'));
  const a = path.join(dir, 'prev.json');
  const b = path.join(dir, 'next.json');
  fs.writeFileSync(a, JSON.stringify({ prompts: prev }));
  fs.writeFileSync(b, JSON.stringify({ prompts: next }));
  const r = spawnSync('node', [TOOL, a, b], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
};

const prompt = (pieces, map) => ({
  id: 'fixture-intro',
  pieces,
  identifiers: [0, 1],
  identifierMap: map,
});

describe('checkMapDrift', () => {
  it('fails a rename under an unchanged use-shape', () => {
    const r = run(
      [prompt(['${', '!==null?', '():"x"}'], { 0: 'CFG', 1: 'INTRO_FN' })],
      [prompt(['${', '!==null?', '():"x"}'], { 0: 'CFG', 1: 'OTHER_FN' })]
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('1 unacknowledged');
  });

  it('passes a rename that follows the slot from a call to a value', () => {
    const r = run(
      [prompt(['${', '!==null?', '():"x"}'], { 0: 'CFG', 1: 'INTRO_FN' })],
      [prompt(['${', '!==null?', ':"x"}'], { 0: 'CFG', 1: 'INTRO' })]
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 reshaped');
  });
});
