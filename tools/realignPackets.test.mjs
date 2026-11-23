import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALLOW = JSON.parse(
  fs.readFileSync(
    path.join(HERE, '..', 'data', 'trim-slot-allowlist.json'),
    'utf8'
  )
);
const CUT_ID = Object.keys(ALLOW).find(
  id => Object.keys(ALLOW[id].tokens || {}).length
);

const entry = (id, text) => ({
  id,
  name: id,
  pieces: [text],
  identifiers: [],
  identifierMap: {},
  version: '1.0.0',
});

const build = (ids, bodies) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realign-packets-'));
  const prevPath = path.join(dir, 'prev.json');
  const curPath = path.join(dir, 'cur.json');
  fs.writeFileSync(
    prevPath,
    JSON.stringify({ prompts: ids.map(id => entry(id, `old ${id}`)) })
  );
  fs.writeFileSync(
    curPath,
    JSON.stringify({ prompts: ids.map(id => entry(id, `new ${id}`)) })
  );
  const set = path.join(dir, 'system-prompts-fixture');
  fs.mkdirSync(set);
  for (const id of ids)
    fs.writeFileSync(
      path.join(set, `${id}.md`),
      `<!--\nccVersion: 1.0.0\n-->\n${bodies[id]}`
    );
  const out = path.join(dir, 'out');
  execFileSync(
    'node',
    [
      path.join(HERE, 'realignPackets.mjs'),
      prevPath,
      curPath,
      `--ids=${ids.join(',')}`,
      `--sets=${set}`,
      `--out=${out}`,
    ],
    { encoding: 'utf8', stdio: 'pipe' }
  );
  const read = id => fs.readFileSync(path.join(out, `${id}.md`), 'utf8');
  return { read, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

describe('realignPackets deliberate cuts', () => {
  it('names every reviewed cut slot and its reason, and adds nothing for an id with none', () => {
    expect(CUT_ID).toBeTruthy();
    const plain = 'fixture-no-cuts-recorded';
    const { read, done } = build([CUT_ID, plain], {
      [CUT_ID]: 'trim',
      [plain]: 'trim',
    });
    const packet = read(CUT_ID);
    expect(packet).toContain('## Deliberate cuts');
    for (const [token, why] of Object.entries(ALLOW[CUT_ID].tokens)) {
      expect(packet).toContain(`\`${token}\``);
      expect(packet).toContain(why);
    }
    expect(packet.indexOf('## Deliberate cuts')).toBeLessThan(
      packet.indexOf('## OLD pristine')
    );
    expect(read(plain)).not.toContain('## Deliberate cuts');
    done();
  });
});
