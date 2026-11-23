import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tool = path.join(import.meta.dirname, 'auditCallSlots.mjs');

const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-'));
  const json = path.join(dir, 'prompts.json');
  fs.writeFileSync(
    json,
    JSON.stringify({
      prompts: [
        {
          id: 'a-prompt',
          pieces: ['Call ${', '() now'],
          identifiers: [0],
          identifierMap: { 0: 'CALL_ME' },
        },
        {
          id: 'b-prompt',
          pieces: ['Value ${', '} here'],
          identifiers: [0],
          identifierMap: { 0: 'PLAIN' },
        },
      ],
    })
  );
  const set = path.join(dir, 'set');
  fs.mkdirSync(set);
  const md = body => `<!--\nname: x\nccVersion: 1.0.0\n-->\n${body}\n`;
  fs.writeFileSync(path.join(set, 'a-prompt.md'), md('Call ${CALL_ME()} now'));
  fs.writeFileSync(path.join(set, 'b-prompt.md'), md('Value ${PLAIN()} here'));
  const ids = path.join(dir, 'ids.txt');
  fs.writeFileSync(ids, 'a-prompt\n');
  return { json, set, ids };
};

const run = args => spawnSync('node', [tool, ...args], { encoding: 'utf8' });

describe('auditCallSlots arguments', () => {
  it('accepts the set positionally and as --set=, and flags the bad slot', () => {
    const { json, set } = fixture();
    for (const args of [[json, set], [json, `--set=${set}`]]) {
      const r = run(args);
      expect(r.status).toBe(1);
      expect(r.stderr + r.stdout).toContain('b-prompt');
    }
  });

  it('limits the audit to --ids', () => {
    const { json, set, ids } = fixture();
    const r = run([json, `--set=${set}`, `--ids=${ids}`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 of 2 file(s)');
  });

  it('rejects an unknown flag instead of reading it as a path', () => {
    const { json, set } = fixture();
    const r = run([json, `--set=${set}`, '--cli=x']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown flag --cli=x');
  });
});
