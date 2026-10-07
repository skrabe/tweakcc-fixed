// Locks the tag-balance gate against the miss it was built for: the auto-mode
// security monitor override kept `<cc_automode_session_rules>` and dropped its
// closer, which no other gate could see.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  tagEvents,
  tagFindings,
  stripFrontmatter,
  reconstruct,
} from './checkTagBalance.mjs';

const SCRIPT = path.join(import.meta.dirname, 'checkTagBalance.mjs');
const find = (p, d) => tagFindings([p], d).map(f => `${f.kind}:${f.tag}`);

describe('checkTagBalance: findings', () => {
  const pristine =
    'Intro.\n<rules>\nDo this.\n</rules>\n\nMore.\n<other>\nx\n</other>\n';

  it('flags a dropped close', () => {
    expect(
      find(pristine, 'Intro.\n<rules>\nDo this.\n\n<other>\nx\n</other>')
    ).toEqual(['unbalanced:rules']);
  });

  it('flags the real shape: opener after prose, closer after slots', () => {
    const p =
      'BLOCK it.<cc_automode_session_rules><cross_session_messages_rule>\n${A}${B}</cc_automode_session_rules>';
    const d =
      '<cc_automode_session_rules><cross_session_messages_rule>\n${A}${B}';
    expect(find(p, d)).toEqual(['unbalanced:cc_automode_session_rules']);
    expect(find(p, p)).toEqual([]);
  });

  it('ignores a code-side replace marker pristine never closes', () => {
    const p = 'Rules.\n<cross_session_messages_rule>\n<permissions_template>\n';
    expect(find(p, 'Rules.\n<cross_session_messages_rule>')).toEqual([]);
    expect(find(p, 'Rules.')).toEqual([]);
  });

  it('does not count a prose mention of a tag', () => {
    const p = 'Wrap it in <analysis> tags first.\n<analysis>\nx\n</analysis>\n';
    expect(
      find(
        p,
        'Wrap your analysis in <analysis> tags first.\n<analysis>\nx\n</analysis>\n'
      )
    ).toEqual([]);
  });

  it('does not count a tag inside a backtick span or fence', () => {
    const p = '<a>\nx\n</a>\n';
    expect(find(p, '<a>\nx\n</a>\n`<a>`\n```\n<a>\n```\n')).toEqual([]);
  });

  it('flags a close that comes out of order, when pristine nests soundly', () => {
    const p = '<outer>\n<inner>\nx\n</inner>\n</outer>\n';
    expect(find(p, '<outer>\n<inner>\nx\n</outer>\n</inner>\n')).toEqual([
      'nesting:outer',
    ]);
  });

  it('stays quiet on out-of-order text when pristine is out of order too', () => {
    const p = '<a>\n<b>\n</a>\n</b>\n';
    expect(find(p, p.replace('x', 'y'))).toEqual([]);
  });

  it('treats a same-line pair as balanced', () => {
    const p = '<summary>One</summary>\n<summary>Two</summary>\n';
    expect(find(p, '<summary>One</summary>\n')).toEqual([]);
  });

  it('reads frontmatter and pieces the way the sibling gates do', () => {
    expect(stripFrontmatter('<!--\nid: x\n-->\nbody')).toBe('body');
    expect(
      reconstruct({
        pieces: ['a${', '}b'],
        identifiers: [0],
        identifierMap: { 0: 'V' },
      })
    ).toBe('a${V}b');
    expect(tagEvents('<a>\n</a>')).toHaveLength(2);
  });
});

describe('checkTagBalance: CLI', () => {
  let dir;
  const id = 'tool-result-fixture-wrapper';
  const hash = b =>
    crypto.createHash('sha1').update(b.trim()).digest('hex').slice(0, 12);
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  const run = (...extra) =>
    spawnSync(
      process.execPath,
      [
        SCRIPT,
        path.join(dir, 'prompts.json'),
        `--set=${path.join(dir, 'system-prompts-x')}`,
        `--allowlist=${path.join(dir, 'allow.json')}`,
        ...extra,
      ],
      { encoding: 'utf8' }
    );
  const setBody = body =>
    write('system-prompts-x/' + id + '.md', `<!--\nname: x\n-->\n${body}`);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagbal-'));
    fs.mkdirSync(path.join(dir, 'system-prompts-x'));
    write(
      'prompts.json',
      JSON.stringify({
        prompts: [
          {
            id,
            pieces: ['Intro.\n<rules>\nDo this.\n</rules>\nTail.'],
            identifiers: [],
            identifierMap: {},
          },
        ],
      })
    );
    write('allow.json', '{}');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('exits 1 on a dropped close', () => {
    setBody('Intro.\n<rules>\nDo this.\nTail.');
    const r = run('--all');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(id);
    expect(r.stdout).toContain('audited sets: system-prompts-x');
  });

  it('exits 0 on a sound trim', () => {
    setBody('Intro.\n<rules>\nDo.\n</rules>');
    expect(run('--all').status).toBe(0);
  });

  it('honours an allowlist row and re-opens it when the body changes', () => {
    const body = 'Intro.\n<rules>\nDo this.\nTail.';
    setBody(body);
    write(
      'allow.json',
      JSON.stringify({
        [id]: { bodyHash: hash(body), tags: { rules: 'intended' } },
      })
    );
    const ok = run('--all');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('justified: intended');
    setBody(body + ' edited');
    const reopened = run('--all');
    expect(reopened.status).toBe(1);
    expect(reopened.stdout).toContain('allowlist row is stale');
    expect(reopened.stdout).toContain('tag finding');
    write('allow.json', '{}');
  });

  it('exits 2 when nothing was checked', () => {
    setBody('');
    expect(run('--all').status).toBe(2);
    setBody('Intro.\n<rules>\nx\n</rules>');
    write('empty.txt', '\n');
    expect(run(`--ids=${path.join(dir, 'empty.txt')}`).status).toBe(2);
  });

  it('exits 2 on a missing catalogue', () => {
    fs.rmSync(path.join(dir, 'prompts.json'));
    expect(run('--all').status).toBe(2);
  });
});
