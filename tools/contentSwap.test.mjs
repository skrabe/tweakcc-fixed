import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentSwapSweep, realignHazard } from './lib/contentSwap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = (id, body, version = '1.0.0', extra = {}) => ({
  id,
  version,
  pieces: Array.isArray(body) ? body : [body],
  ...extra,
});
const F = 'tool-result-fixture-swap';

// A new prompt inserted at -2 shifts the family: old -2 -> -3, old -3 -> -4.
const prev = [
  P(`${F}`, 'base body'),
  P(`${F}-2`, 'second body'),
  P(`${F}-3`, 'third body'),
];
const cur = [
  P(`${F}`, 'base body'),
  P(`${F}-2`, 'brand new body', '2.0.0'),
  P(`${F}-3`, 'second body'),
  P(`${F}-4`, 'third body'),
];

describe('contentSwapSweep', () => {
  it('flags exactly the shifted ids of a positional insertion', () => {
    const s = contentSwapSweep(prev, cur);
    expect(s.swaps.map(x => [x.id, x.from, x.moved, x.newId])).toEqual([
      [`${F}-3`, [`${F}-2`], true, false],
      [`${F}-4`, [`${F}-3`], true, true],
    ]);
    expect([...s.movedFrom.keys()].sort()).toEqual([`${F}-2`, `${F}-3`]);
    expect(realignHazard(s, F)).toBeNull();
    expect(realignHazard(s, `${F}-2`)).toMatch(/moved to .*-3/);
    expect(realignHazard(s, `${F}-3`)).toMatch(/moved to .*-4.*-2's previous body/);
    expect(realignHazard(s, `${F}-4`)).toMatch(/-3's previous body/);
  });

  it('compares string pieces only, so a slot relabel is not a swap', () => {
    const a = [P(`${F}-a`, ['x ${', '} y'], '1.0.0', { identifierMap: { 0: 'OLD' } })];
    const b = [P(`${F}-a`, ['x ${', '} y'], '1.0.0', { identifierMap: { 0: 'NEW' } })];
    const s = contentSwapSweep(a, b);
    expect(s.swaps).toEqual([]);
    expect(s.versionStale).toEqual([]);
  });

  it('reports a body change under an unchanged version', () => {
    const s = contentSwapSweep([P(`${F}-v`, 'one')], [P(`${F}-v`, 'two')]);
    expect(s.versionStale.map(v => v.id)).toEqual([`${F}-v`]);
  });

  it('marks a body still carried by its old id as shared, not moved', () => {
    const s = contentSwapSweep(
      [P(`${F}-s`, 'same'), P(`${F}-t`, 'other')],
      [P(`${F}-s`, 'same'), P(`${F}-t`, 'same')]
    );
    expect(s.swaps.map(x => [x.id, x.moved])).toEqual([[`${F}-t`, false]]);
    expect(s.movedFrom.size).toBe(0);
  });
});

describe('realignPackets refuses a moved id', () => {
  it('writes nothing and exits 1 until the id is acknowledged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-swap-'));
    const prevPath = path.join(dir, 'prev.json');
    const curPath = path.join(dir, 'cur.json');
    fs.writeFileSync(prevPath, JSON.stringify({ prompts: prev }));
    fs.writeFileSync(curPath, JSON.stringify({ prompts: cur }));
    const set = path.join(dir, 'system-prompts-fixture');
    fs.mkdirSync(set);
    fs.writeFileSync(path.join(set, `${F}-3.md`), '<!--\nccVersion: 1.0.0\n-->\ntrim');
    const out = path.join(dir, 'out');
    const run = extra => {
      try {
        execFileSync('node', [path.join(HERE, 'realignPackets.mjs'), prevPath, curPath, `--ids=${F}-3`, `--sets=${set}`, `--out=${out}`, ...extra], { encoding: 'utf8', stdio: 'pipe' });
        return 0;
      } catch (e) {
        return e.status;
      }
    };
    expect(run([])).toBe(1);
    expect(fs.existsSync(path.join(out, 'tasks.json'))).toBe(false);
    expect(run([`--allow-moved=${F}-3`])).toBe(0);
    expect(fs.existsSync(path.join(out, 'tasks.json'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
