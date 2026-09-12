import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOL = path.join(import.meta.dirname, 'checkMapDrift.mjs');

const run = (prev, next, extra = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapdrift-'));
  const a = path.join(dir, 'prev.json');
  const b = path.join(dir, 'next.json');
  fs.writeFileSync(a, JSON.stringify({ prompts: prev }));
  fs.writeFileSync(b, JSON.stringify({ prompts: next }));
  const r = spawnSync('node', [TOOL, a, b, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
};

const prompt = (pieces, map, extra = {}) => ({
  id: extra.id ?? 'fixture-intro',
  pieces,
  identifiers: extra.identifiers ?? [0, 1],
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

  it('flags a name carried by index onto slots inserted ahead of it', () => {
    const prev = prompt(
      [
        'Report the commit hash in your summary.\n${',
        '()>1?`- If you have the ${',
        '} tool, you may use it to fan out`:""}',
      ],
      { 0: 'MAX_SUBAGENT_SPAWN_DEPTH_FN', 1: 'AGENT_TOOL_NAME' },
      { id: 'fixture-worker' }
    );
    const next = prompt(
      [
        'suggest them as follow-ups instead. -${',
        '()?`If you changed any files, commit them through the `/${',
        '}` skill when done (not a bare `git commit`), PR via `/${',
        '}` skill.`:"commit when done."} Report the commit hash in your summary.\n${',
        '()>1?`- If you have the ${',
        '} tool, you may use it to fan out`:""}',
      ],
      {
        0: 'MAX_SUBAGENT_SPAWN_DEPTH_FN',
        1: 'AGENT_TOOL_NAME',
        2: 'VAR_2',
        3: 'VAR_3',
        4: 'VAR_4',
      },
      { id: 'fixture-worker', identifiers: [0, 1, 2, 3, 4] }
    );
    const r = run([prev], [next]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('fixture-worker');
    expect(r.out).toContain('1 moved');
    expect(r.out).toMatch(/MAX_SUBAGENT_SPAWN_DEPTH_FN/);
    expect(r.out).toMatch(/AGENT_TOOL_NAME/);
  });

  it('passes an append-at-end reshape that keeps old names on their context', () => {
    const prev = prompt(
      [
        'You are the coordinator. Spawn with ${',
        '} and message workers via ${',
        '}.',
      ],
      { 0: 'AGENT_TOOL_NAME', 1: 'SENDMESSAGE_TOOL_NAME' },
      { id: 'fixture-coordinator' }
    );
    const next = prompt(
      [
        'You are the coordinator. Spawn with ${',
        '} and message workers via ${',
        '}. Commit through the skill when done.${',
        '}',
      ],
      {
        0: 'AGENT_TOOL_NAME',
        1: 'SENDMESSAGE_TOOL_NAME',
        2: 'WORKER_COMMIT_SUFFIX',
      },
      { id: 'fixture-coordinator', identifiers: [0, 1, 2] }
    );
    const r = run([prev], [next]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 moved');
    expect(r.out).not.toContain('fixture-coordinator');
  });

  it('passes a renamed-in-place slot when identifiers gain an appended name', () => {
    const prev = prompt(
      ['Intro config ${', '!==null?', '():"x"} then spawn with ${', '}.'],
      { 0: 'CFG', 1: 'INTRO_FN' },
      { id: 'fixture-rename' }
    );
    const next = prompt(
      [
        'Intro config ${',
        '!==null?',
        '():"x"} then spawn with ${',
        '}. Extra note:${',
        '}',
      ],
      { 0: 'CFG', 1: 'INTRO', 2: 'NEW_NOTE' },
      { id: 'fixture-rename', identifiers: [0, 1, 2] }
    );
    const r = run([prev], [next]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 moved');
    expect(r.out).not.toContain('fixture-rename');
  });

  it('acknowledges a moved binding with --allow', () => {
    const prev = prompt(
      [
        'Report the commit hash in your summary.\n${',
        '()>1?`- If you have the ${',
        '} tool, you may use it to fan out`:""}',
      ],
      { 0: 'MAX_SUBAGENT_SPAWN_DEPTH_FN', 1: 'AGENT_TOOL_NAME' },
      { id: 'fixture-worker' }
    );
    const next = prompt(
      [
        'suggest them as follow-ups instead. -${',
        '()?`If you changed any files, commit them through the `/${',
        '}` skill when done (not a bare `git commit`), PR via `/${',
        '}` skill.`:"commit when done."} Report the commit hash in your summary.\n${',
        '()>1?`- If you have the ${',
        '} tool, you may use it to fan out`:""}',
      ],
      {
        0: 'MAX_SUBAGENT_SPAWN_DEPTH_FN',
        1: 'AGENT_TOOL_NAME',
        2: 'VAR_2',
        3: 'VAR_3',
        4: 'VAR_4',
      },
      { id: 'fixture-worker', identifiers: [0, 1, 2, 3, 4] }
    );
    const r = run([prev], [next], ['--allow=fixture-worker']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('acknowledged moved binding');
    expect(r.out).toContain('0 moved');
  });
});
