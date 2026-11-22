import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { CONFIG_DIR } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const o = require('node:os') as typeof import('node:os');
  const p = require('node:path') as typeof import('node:path');
  const f = require('node:fs') as typeof import('node:fs');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const dir = f.mkdtempSync(p.join(o.tmpdir(), 'preflight-interp-'));
  process.env.TWEAKCC_CONFIG_DIR = dir;
  return { CONFIG_DIR: dir };
});

import { runSystemPromptPreflight } from './systemPromptPreflight';
import { clearShadowSetCache, preloadStringsFile } from './systemPromptSync';

const VERSION = '2.1.330';
const ID = 'tool-result-repl-parse-template-literal-hint';
const PRISTINE_BODY =
  'A template literal ends at the next backtick and `${` starts an interpolation, so text that contains either (RST ``code``, a shell ${VAR}, a Python f-string) is safer in a \'…\' or "…" string, or read from a file.';
const PRISTINE =
  'if(e.includes("`"))l.push("A template literal ends at the next backtick ' +
  'and `${` starts an interpolation, so text that contains either (RST ' +
  "``code``, a shell ${VAR}, a Python f-string) is safer in a '\\u2026' or " +
  '\\"\\u2026\\" string, or read from a file.");';

const promptsDir = path.join(CONFIG_DIR, 'system-prompts');

const writeOverride = async (body: string): Promise<void> => {
  await fs.writeFile(
    path.join(promptsDir, `${ID}.md`),
    `<!--\nname: 'Tool Result: REPL parse template literal hint'\nccVersion: ${VERSION}\n-->\n${body}\n`
  );
  clearShadowSetCache();
};

describe('runSystemPromptPreflight interpolation guard', () => {
  beforeAll(async () => {
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.mkdir(path.join(CONFIG_DIR, 'system-reminders'), {
      recursive: true,
    });
    expect((await preloadStringsFile(VERSION)).success).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await fs.rm(CONFIG_DIR, { recursive: true, force: true });
  });

  it('leaves a vanilla override whose pristine text carries a literal ${ uninterpolated', async () => {
    await writeOverride(PRISTINE_BODY);
    const result = await runSystemPromptPreflight({
      pristine: PRISTINE,
      version: VERSION,
      patchFilter: [ID],
    });
    expect(result.sitesChecked).toBe(1);
    expect(result.findings).toEqual([]);
  }, 60_000);

  it('reports a malformed interpolation in an edited override as a finding', async () => {
    await writeOverride(
      PRISTINE_BODY.replace('read from a file', 'read from ${a file')
    );
    const result = await runSystemPromptPreflight({
      pristine: PRISTINE,
      version: VERSION,
      patchFilter: [ID],
    });
    expect(result.sitesChecked).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({
        check: 'interpolation',
        severity: 'error',
        id: ID,
        site: 0,
      }),
    ]);
  }, 60_000);
});
