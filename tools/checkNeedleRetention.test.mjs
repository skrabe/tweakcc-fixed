// Locks the CC 2.1.281 class: a const-bound needle the binary cuts a
// tool_result with (`var J4o=". If you have other tasks"` then
// `n.indexOf(J4o)`) that an override trimmed away while every gate stayed green.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  collectSearchNeedles,
  isProseNeedle,
  placedFor,
} from './lib/searchNeedles.mjs';

const REPO = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..'
);
const TOOL = path.join(REPO, 'tools/checkNeedleRetention.mjs');

const CUT = 'tool-result-fixture-denied';
const PREFIX = 'tool-result-fixture-blocked';
const QUOTER = 'tool-result-fixture-quoter';

// The builder and its reader sit side by side, as they do in the real bundle.
const CLI = `var version="9.9.9";
var Q1x=". If you have other work";
function cut(e){let r=e.indexOf(Q1x);if(r<=0)return null;return e.slice(0,r)}
function deny(r){return\`\${r}. If you have other work that does not need this, keep going.\`}
function blocked(x){return\`Blocked by fixture policy: \${x}\`}
function isBlocked(e){return e.startsWith("Blocked by fixture policy:")}
function quote(){return"Messages starting with [FIXTURE MARKER - NOT INPUT] come from the harness."}
var M7z="[FIXTURE MARKER - NOT INPUT]";
function isMarker(e){return e.startsWith(M7z)}
`;

const PROMPTS = {
  prompts: [
    {
      id: CUT,
      version: '9.9.9',
      pieces: [
        '${',
        '}. If you have other work that does not need this, keep going.',
      ],
      identifiers: [0],
      identifierMap: { 0: 'REASON' },
    },
    {
      id: PREFIX,
      version: '9.9.9',
      pieces: ['Blocked by fixture policy: ${', '}'],
      identifiers: [0],
      identifierMap: { 0: 'DETAIL' },
    },
    {
      id: QUOTER,
      version: '9.9.9',
      pieces: [
        'Messages starting with [FIXTURE MARKER - NOT INPUT] come from the harness.',
      ],
      identifiers: [],
      identifierMap: {},
    },
  ],
};

const fm = (id, extra = '') => `<!--\nname: '${id}'\n${extra}-->\n`;

function scaffold(overrides, { allow = null, cli = CLI } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'needle-test-'));
  fs.writeFileSync(path.join(root, 'cli.js'), cli);
  fs.writeFileSync(path.join(root, 'prompts.json'), JSON.stringify(PROMPTS));
  const set = path.join(root, 'lcc', 'system-prompts-fixture');
  fs.mkdirSync(set, { recursive: true });
  for (const [id, text] of Object.entries(overrides)) {
    fs.writeFileSync(path.join(set, `${id}.md`), text);
  }
  const allowPath = path.join(root, 'allow.json');
  fs.writeFileSync(allowPath, JSON.stringify(allow || {}));
  return { root, set, allowPath };
}

function run({ root, set, allowPath }, cliPath = path.join(root, 'cli.js')) {
  const r = spawnSync(
    'node',
    [
      TOOL,
      cliPath,
      path.join(root, 'prompts.json'),
      `--sets=${set}`,
      `--allowlist=${allowPath}`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, TWEAKCC_CONFIG_DIR: root },
    }
  );
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('collectSearchNeedles', () => {
  it('resolves a const bound once in its module', () => {
    const rows = collectSearchNeedles(CLI);
    expect(rows).toContainEqual(
      expect.objectContaining({
        needle: '. If you have other work',
        via: 'Q1x -> .indexOf()',
      })
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        needle: 'Blocked by fixture policy:',
        via: 'inline .startsWith()',
      })
    );
  });

  it('does not resolve a const assigned twice', () => {
    const src =
      'var Z9q=". If you have other work";function f(e){return e.indexOf(Z9q)}Z9q="something else entirely";';
    expect(collectSearchNeedles(src)).toEqual([]);
  });

  it('decodes escapes in the needle literal', () => {
    const src =
      'function f(e){return e.includes("fixture \\u2014 needle text")}';
    expect(collectSearchNeedles(src)[0].needle).toBe('fixture — needle text');
  });
});

describe('needle rules', () => {
  it('rejects punctuation, lone words and identifier-like keys', () => {
    expect(isProseNeedle('\n\n')).toBe(false);
    expect(isProseNeedle(', ')).toBe(false);
    expect(isProseNeedle('tool_result_block')).toBe(false);
    expect(isProseNeedle('sandbox.filesystem.allowWrite')).toBe(false);
    expect(isProseNeedle('. If you have other tasks')).toBe(true);
  });

  it('only counts startsWith when the needle opens a line or run', () => {
    const forms = ['Messages starting with [MARK] come from the harness.'];
    expect(placedFor('.startsWith()', forms, '[MARK] come')).toBe(false);
    expect(placedFor('.includes()', forms, '[MARK] come')).toBe(true);
    expect(placedFor('.startsWith()', ['x\u0000[MARK] y'], '[MARK]')).toBe(
      true
    );
  });
});

describe('checkNeedleRetention', () => {
  it('flags an override that drops a const-bound indexOf needle', () => {
    const r = run(scaffold({ [CUT]: fm(CUT) + '${REASON}.' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain(`DROPPED NEEDLE  system-prompts-fixture/${CUT}`);
    expect(r.out).toContain('Q1x -> .indexOf()');
    expect(r.out).toMatch(/1 finding\(s\) — FAIL/);
  });

  it('flags an override that drops an inline startsWith needle', () => {
    const r = run(
      scaffold({ [PREFIX]: fm(PREFIX) + 'Fixture policy blocked: ${DETAIL}' })
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain(`system-prompts-fixture/${PREFIX}`);
    expect(r.out).toContain('inline .startsWith()');
  });

  it('passes an override that keeps the needle', () => {
    const r = run(
      scaffold({
        [CUT]: fm(CUT) + '${REASON}. If you have other work, do it.',
        [PREFIX]: fm(PREFIX) + 'Blocked by fixture policy: ${DETAIL} (retry)',
      })
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0 finding\(s\) — PASS/);
    expect(r.out).toContain('audited sets: system-prompts-fixture');
  });

  it('ignores a suppressed (empty-body) override', () => {
    const r = run(scaffold({ [CUT]: fm(CUT) }));
    expect(r.code).toBe(0);
  });

  it('ignores a missing override (pristine applies)', () => {
    const r = run(scaffold({}));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /needle retention: \d+ needle\(s\) in \d+ prompt\(s\)/
    );
  });

  it('ignores a prompt that only quotes a marker mid-sentence', () => {
    const r = run(scaffold({ [QUOTER]: fm(QUOTER) + 'Harness messages.' }));
    expect(r.code).toBe(0);
  });

  it('skips an id another override shadows', () => {
    const r = run(
      scaffold({
        [CUT]: fm(CUT) + '${REASON}.',
        'tool-result-fixture-owner': fm(
          'tool-result-fixture-owner',
          `shadows:\n  - ${CUT}\n`
        ),
      })
    );
    expect(r.code).toBe(0);
  });

  it('lets the allowlist silence a finding and reports stale rows', () => {
    const r = run(
      scaffold(
        { [CUT]: fm(CUT) + '${REASON}.' },
        {
          allow: {
            [CUT]: { '. If you have other work': 'fixture: reviewed drop' },
            [PREFIX]: { 'Blocked by fixture policy:': 'fixture: stale' },
          },
        }
      )
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0 finding\(s\) — PASS/);
    expect(r.out).toContain(`stale allowlist row: ${PREFIX}`);
    expect(r.out).not.toContain(`stale allowlist row: ${CUT}`);
  });

  it('exits 2 when the bundle is missing', () => {
    const s = scaffold({});
    const r = run(s, path.join(s.root, 'nope.js'));
    expect(r.code).toBe(2);
  });

  it('exits 2 when the override set is missing', () => {
    const s = scaffold({});
    const r = run({ ...s, set: path.join(s.root, 'missing-set') });
    expect(r.code).toBe(2);
  });
});
