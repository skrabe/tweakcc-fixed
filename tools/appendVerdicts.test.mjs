import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mergeRows, normalizeRows } from './appendVerdicts.mjs';

const tool = path.join(import.meta.dirname, 'appendVerdicts.mjs');

describe('appendVerdicts', () => {
  it('keys array rows only by an explicit key', () => {
    const { rows, errors } = normalizeRows([
      { key: 'k1', verdict: 'glue' },
      { key: 'h1', hash: 'other', id: 'some-id', verdict: 'catalogue' },
    ]);
    expect(errors).toEqual([]);
    expect(rows).toEqual({
      k1: { verdict: 'glue' },
      h1: { hash: 'other', id: 'some-id', verdict: 'catalogue' },
    });
    expect(normalizeRows([{ id: 'x', hash: 'y' }]).errors).toHaveLength(1);
  });

  it('refuses an existing key unless replacing', () => {
    expect(mergeRows({ a: 1 }, { a: 2 }).merged).toBeUndefined();
    expect(mergeRows({ a: 1 }, { a: 2 }, { replace: true }).merged).toEqual({
      a: 2,
    });
  });

  it('appends without reformatting existing rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-'));
    const target = path.join(dir, 'allow.json');
    const before =
      '{\n  "b": {\n    "verdict": "glue",\n    "why": "x"\n  },\n  "a": [1, 2]\n}\n';
    fs.writeFileSync(target, before);
    const rows = path.join(dir, 'rows.json');
    fs.writeFileSync(rows, JSON.stringify([{ key: 'c', verdict: 'glue' }]));
    const r = spawnSync('node', [tool, target, rows], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const after = fs.readFileSync(target, 'utf8');
    expect(after.startsWith(before.slice(0, -3))).toBe(true);
    expect(JSON.parse(after).c).toEqual({ verdict: 'glue' });
    const again = spawnSync('node', [tool, target, rows], { encoding: 'utf8' });
    expect(again.status).toBe(1);
  });

  it('leaves escaped characters in existing rows untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-'));
    const target = path.join(dir, 'allow.json');
    const before = '{\n  "a": {\n    "why": "x \\u2014 y"\n  }\n}\n';
    fs.writeFileSync(target, before);
    const rows = path.join(dir, 'rows.json');
    fs.writeFileSync(rows, JSON.stringify([{ key: 'b', why: 'z' }]));
    const r = spawnSync('node', [tool, target, rows], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const after = fs.readFileSync(target, 'utf8');
    expect(after).toContain('"why": "x \\u2014 y"');
    expect(JSON.parse(after)).toEqual({ a: { why: 'x — y' }, b: { why: 'z' } });
  });
});
