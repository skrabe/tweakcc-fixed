import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildTrimTasks } from './buildTrimTasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'buildTrimTasks.mjs');
const fm = v => `<!--\nname: x\ndescription: d\nccVersion: ${v}\n-->\n`;
const entry = (id, text) => ({
  name: id,
  id,
  description: 'd',
  pieces: [text],
  identifiers: [],
  identifierMap: {},
  version: '9.9.9',
});
const CATALOGUE = {
  version: '9.9.9',
  prompts: [
    entry('tool-result-fixture-trimmed', 'One. Two restated. Three.'),
    entry('tool-result-fixture-wiped', 'Wholly restated.'),
    entry('tool-result-fixture-carrier', 'Two restated carrier text.'),
  ],
};
const verdicts = [
  {
    id: 'tool-result-fixture-trimmed',
    verdict: 'trim',
    coveredBy: [
      { carrierId: 'tool-result-fixture-carrier', quote: 'Two restated' },
      { carrierId: 'system-reminders/fixture-rem', quote: 'Two' },
    ],
    trimPlan: 'Delete sentence two.',
  },
  {
    id: 'tool-result-fixture-wiped',
    verdict: 'wipe-merge',
    coveredBy: [{ carrierId: 'tool-result-fixture-carrier', quote: 'Two restated' }],
    trimPlan: null,
  },
  { id: 'tool-result-fixture-carrier', verdict: 'pristine-keep', coveredBy: [], trimPlan: null },
];
const auditPackets = [
  { prompts: CATALOGUE.prompts.map(p => ({ id: p.id, version: '9.9.9', setFiles: [] })) },
];

let dir;
let setDir;
let remDir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-trim-tasks-'));
  setDir = path.join(dir, 'set');
  remDir = path.join(dir, 'rem');
  fs.mkdirSync(setDir);
  fs.mkdirSync(remDir);
  fs.writeFileSync(path.join(setDir, 'tool-result-fixture-trimmed.md'), fm('9.9.9') + 'One. Three.\n');
  fs.writeFileSync(path.join(setDir, 'tool-result-fixture-wiped.md'), fm('9.9.9'));
  fs.writeFileSync(path.join(setDir, 'tool-result-fixture-carrier.md'), fm('9.9.8') + ' Two restated carrier text.\n');
  fs.writeFileSync(path.join(remDir, 'fixture-rem.md'), fm('9.9.9') + 'Two reminder.\n');
});

const build = (result = { verdicts }, catalogue = CATALOGUE, packets = auditPackets) =>
  buildTrimTasks({ catalogue, result, auditPackets: packets, setDir, remindersDir: remDir });

describe('buildTrimTasks', () => {
  it('builds one packet per trim and wipe-merge verdict and no other', () => {
    const r = build();
    expect(r.problems).toEqual([]);
    expect(r.trims.map(p => p.id)).toEqual(['tool-result-fixture-trimmed']);
    expect(r.wipes.map(p => p.id)).toEqual(['tool-result-fixture-wiped']);
  });

  it('carries the catalogue, audit entry and deployed override body verbatim', () => {
    const [p] = build().trims;
    expect(p.overrideFile).toBe(path.join(setDir, 'tool-result-fixture-trimmed.md'));
    expect(p.catalogueEntries).toHaveLength(1);
    expect(p.auditEntry.id).toBe(p.id);
    expect(p.verdict.trimPlan).toBe('Delete sentence two.');
    expect(p.deployedOverride).toEqual({ file: p.overrideFile, ccVersion: '9.9.9', body: 'One. Three.\n' });
  });

  it('looks each carrier up in the active set or the reminders dir', () => {
    const [p] = build().trims;
    const [set, rem] = p.carriers;
    expect(set.carrierId).toBe('tool-result-fixture-carrier');
    expect(set.catalogueVersion).toBe('9.9.9');
    expect(set.deployed.ccVersion).toBe('9.9.8');
    expect(set.deployed.body).toBe(' Two restated carrier text.\n');
    expect(rem.carrierId).toBe('system-reminders/fixture-rem');
    expect(rem.catalogueEntries).toEqual([]);
    expect(rem.deployed.body).toBe('Two reminder.\n');
  });

  it('writes a wiped override body as empty', () => {
    expect(build().wipes[0].deployedOverride.body).toBe('');
  });

  it('notes a missing override file instead of inventing a body', () => {
    fs.rmSync(path.join(setDir, 'tool-result-fixture-gone.md'), { force: true });
    const r = build({ verdicts: [{ ...verdicts[1], id: 'tool-result-fixture-gone' }] }, {
      version: '9.9.9',
      prompts: [...CATALOGUE.prompts, entry('tool-result-fixture-gone', 'Gone.')],
    }, [{ prompts: [{ id: 'tool-result-fixture-gone' }] }]);
    expect(r.problems).toEqual([]);
    expect(r.wipes[0].deployedOverride.body).toBeNull();
    expect(r.wipes[0].deployedOverride.note).toMatch(/no override file/);
  });

  it('reports ids missing from the catalogue, the audit packets or a carrier lookup', () => {
    const noAudit = build({ verdicts }, CATALOGUE, [{ prompts: [] }]);
    expect(noAudit.problems.join('\n')).toMatch(/tool-result-fixture-trimmed: not in the audit packets/);
    const noCatalogue = build({ verdicts }, { version: '9.9.9', prompts: [CATALOGUE.prompts[0]] });
    expect(noCatalogue.problems.join('\n')).toMatch(/tool-result-fixture-wiped: not in the catalogue/);
    expect(noCatalogue.problems.join('\n')).toMatch(/carrier tool-result-fixture-carrier is not in the catalogue/);
  });
});

describe('buildTrimTasks CLI', () => {
  const write = (name, value) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, JSON.stringify(value));
    return f;
  };
  const run = (result, outName) => {
    const pdir = path.join(dir, 'audit');
    fs.mkdirSync(pdir, { recursive: true });
    write('audit/audit-packet-00.json', auditPackets[0]);
    return spawnSync(
      'node',
      [
        SCRIPT,
        write('prompts.json', CATALOGUE),
        write('result.json', result),
        pdir,
        `--set=${setDir}`,
        `--reminders=${remDir}`,
        `--out-trim=${path.join(dir, outName, 'trim')}`,
        `--out-verify=${path.join(dir, outName, 'verify')}`,
      ],
      { encoding: 'utf8' }
    );
  };

  it('writes both tasks files in the shapes the driver validates and prints the hints', () => {
    const r = run({ verdicts }, 'out');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 trim-verify task\(s\)/);
    expect(r.stdout).toMatch(/tasks-args trim-verify .*trim\/tasks\.json/);
    expect(r.stdout).toMatch(/tasks-args verify .*verify\/tasks\.json/);
    const trim = JSON.parse(fs.readFileSync(path.join(dir, 'out/trim/tasks.json'), 'utf8'));
    expect(trim).toEqual([
      {
        id: 'tool-result-fixture-trimmed',
        packet: path.join(dir, 'out/trim/tool-result-fixture-trimmed.json'),
        paths: [path.join(setDir, 'tool-result-fixture-trimmed.md')],
        verdict: verdicts[0],
      },
    ]);
    const verify = JSON.parse(fs.readFileSync(path.join(dir, 'out/verify/tasks.json'), 'utf8'));
    expect(verify).toEqual([
      { name: 'w00', packet: path.join(dir, 'out/verify/packets.json'), ids: ['tool-result-fixture-wiped'] },
    ]);
    const packets = JSON.parse(fs.readFileSync(verify[0].packet, 'utf8'));
    expect(packets.ids).toEqual(['tool-result-fixture-wiped']);
    expect(packets.packets[0].id).toBe('tool-result-fixture-wiped');
  });

  it('exits non-zero and writes nothing when an id is missing', () => {
    const r = run({ verdicts: [{ ...verdicts[1], id: 'tool-result-fixture-absent' }] }, 'bad');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/tool-result-fixture-absent: not in the catalogue/);
    expect(fs.existsSync(path.join(dir, 'bad'))).toBe(false);
  });
});
