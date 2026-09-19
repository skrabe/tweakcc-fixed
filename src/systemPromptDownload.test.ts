import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  latestPromptsVersion,
  resolveFetchVersion,
} from './systemPromptDownload';
import { TWEAKCC_VERSION } from './packageMeta';

describe('latestPromptsVersion', () => {
  it('picks the newest version among prompts filenames', () => {
    expect(
      latestPromptsVersion([
        'prompts-2.1.267.json',
        'prompts-2.1.273.json',
        'prompts-2.1.270.json',
      ])
    ).toBe('2.1.273');
  });

  it('orders numerically so 2.1.10 beats 2.1.9', () => {
    // A plain lexicographic sort would rank "2.1.9" above "2.1.10".
    expect(
      latestPromptsVersion(['prompts-2.1.9.json', 'prompts-2.1.10.json'])
    ).toBe('2.1.10');
  });

  it('ignores names that are not prompts-X.Y.Z.json', () => {
    expect(
      latestPromptsVersion([
        'README.md',
        '.gitkeep',
        'prompts-old.json',
        'prompts-2.0.30.json',
      ])
    ).toBe('2.0.30');
  });

  it('returns null when no name matches', () => {
    expect(latestPromptsVersion([])).toBeNull();
    expect(
      latestPromptsVersion(['README.md', '.gitkeep', 'prompts-old.json'])
    ).toBeNull();
  });
});

describe('resolveFetchVersion', () => {
  it('takes an explicit version over everything else', () => {
    expect(resolveFetchVersion('2.1.200', '2.1.276', () => '2.1.277')).toBe(
      '2.1.200'
    );
  });

  it('prefers the declared version over newer prompt data on disk', () => {
    // The state of a checkout between a prompts commit and the release that
    // can patch what it describes. Answering 2.1.277 here would name a version
    // this build has no patch code for.
    expect(resolveFetchVersion(undefined, '2.1.276', () => '2.1.277')).toBe(
      '2.1.276'
    );
  });

  it('falls back to prompt data when nothing is declared', () => {
    expect(resolveFetchVersion(undefined, undefined, () => '2.1.273')).toBe(
      '2.1.273'
    );
  });

  it('returns null when no source can name a version', () => {
    expect(resolveFetchVersion(undefined, undefined, () => null)).toBeNull();
  });

  it('does not read the directory unless it reaches that source', () => {
    const localNewest = vi.fn(() => '2.1.273');
    resolveFetchVersion('2.1.200', '2.1.276', localNewest);
    resolveFetchVersion(undefined, '2.1.276', localNewest);
    expect(localNewest).not.toHaveBeenCalled();

    resolveFetchVersion(undefined, undefined, localNewest);
    expect(localNewest).toHaveBeenCalledTimes(1);
  });
});

describe('downloadStringsFile ref selection', () => {
  // A version no release carries, so the repo-local read above it misses and
  // the network path is what these exercise. A real version would be answered
  // from data/prompts/ and never reach a URL.
  const ABSENT = '99.99.99';
  const realFetch = globalThis.fetch;

  // A successful fetch writes the prompts JSON to the cache beside the user's
  // config, and PROMPT_CACHE_DIR is resolved when the module loads. So the
  // module is reloaded per test under a temp TWEAKCC_CONFIG_DIR: without it
  // the first test seeds a cache for ABSENT in the developer's real config
  // directory, and the later ones are served from it instead of reaching the
  // code under test.
  const load = async (): Promise<typeof import('./systemPromptDownload')> => {
    process.env.TWEAKCC_CONFIG_DIR = mkdtempSync(
      path.join(tmpdir(), 'tweakcc-prompt-cache-')
    );
    vi.resetModules();
    return import('./systemPromptDownload');
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.TWEAKCC_CONFIG_DIR;
    vi.resetModules();
  });

  const spyFetch = (reply: (n: number) => Response): { calls: string[] } => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn((input: string | URL | Request) => {
      calls.push(String(input));
      return Promise.resolve(reply(calls.length));
    }) as unknown as typeof fetch;
    return { calls };
  };

  const ok = (): Response =>
    new Response(JSON.stringify({ prompts: [] }), { status: 200 });

  it('asks this release tag before anything else', async () => {
    const { downloadStringsFile } = await load();
    const { calls } = spyFetch(() => ok());

    await downloadStringsFile(ABSENT);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`/refs/tags/v${TWEAKCC_VERSION}/`);
    expect(calls[0]).toContain(`prompts-${ABSENT}.json`);
  });

  it('falls through to main when the tag does not carry that version', async () => {
    // The one case a tag legitimately cannot answer: a Claude Code release
    // published after this one. `main` has it; the tag never will.
    const { downloadStringsFile } = await load();
    const { calls } = spyFetch(n =>
      n === 1 ? new Response('', { status: 404 }) : ok()
    );

    await downloadStringsFile(ABSENT);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/refs/tags/');
    expect(calls[1]).toContain('/refs/heads/main/');
  });

  it('reports a non-404 instead of spending the second request on it', async () => {
    // A rate limit or a 5xx says nothing about which ref holds the file, so
    // retrying reaches the same answer and doubles the load that caused it.
    const { downloadStringsFile } = await load();
    const { calls } = spyFetch(() => new Response('', { status: 429 }));

    await expect(downloadStringsFile(ABSENT)).rejects.toThrow(/Rate limit/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/refs/tags/');
  });
});
