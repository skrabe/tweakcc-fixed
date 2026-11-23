import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applySystemPrompts } from './systemPrompts';
import * as promptSync from '../systemPromptSync';
import * as systemPromptHashIndex from '../systemPromptHashIndex';
import { buildPristineSession } from '../systemPromptPreflight';
import type { PristinePromptAnswers } from '../systemPromptPieceMatcher';

const { records, shadow } = vi.hoisted(() => ({
  records: [] as Array<Record<string, unknown>>,
  shadow: { on: false },
}));

vi.mock('../perfTrace', async () => {
  const actual =
    await vi.importActual<typeof import('../perfTrace')>('../perfTrace');
  return {
    ...actual,
    TRACE: {
      emit: (kind: string, record: Record<string, unknown>) => {
        records.push({ k: kind, ...record });
      },
      digest: (text: string) => text,
      clip: (text: string) => text,
    },
    get SHADOW() {
      return shadow.on;
    },
    shadowFail: (check: string, detail: Record<string, unknown>) => {
      throw new Error(`shadow mismatch ${check}: ${JSON.stringify(detail)}`);
    },
  };
});

vi.mock('../systemPromptSync', async () => {
  const actual = await vi.importActual('../systemPromptSync');
  return {
    ...actual,
    loadSystemPromptsWithRegex: vi.fn(),
  };
});

vi.mock('../systemPromptHashIndex', async () => {
  const actual = await vi.importActual('../systemPromptHashIndex');
  return {
    ...actual,
    setAppliedHashes: vi.fn(),
  };
});

const VERSION = '1.0.0';
const TEXT = 'Mode ${x.alpha} runs every tool in a permission mode';
const SAME_SHAPE = 'Mode ${y.beta} runs every tool in a permission mode';
const PRISTINE = `a=["${TEXT}","x"];`;
const CURRENT = 'a=["LOBOTOMIZED bullet","x"];';

type Entry = Awaited<
  ReturnType<typeof promptSync.loadSystemPromptsWithRegex>
>[number];

const entry = (promptId: string, piece: string, asset?: string): Entry => ({
  promptId,
  prompt: {
    name: promptId,
    description: '',
    ccVersion: VERSION,
    contentLineOffset: 0,
    variables: [],
    content: 'edited',
  } as Entry['prompt'],
  regex: promptSync.buildSearchRegexFromPieces([piece], VERSION),
  getInterpolatedContent: () => 'edited',
  pieces: [piece],
  identifiers: [],
  identifierMap: {},
  ...(asset ? { asset } : {}),
});

const pristinePaths = (): unknown[] =>
  records.filter(r => r.k === 'pristine-path').map(r => r.path);

const clobbers = (): unknown[] => records.filter(r => r.k === 'clobber');

const run = async (
  entries: Entry[],
  current: string,
  answers: PristinePromptAnswers | null,
  patchFilter: string[] | null = null
) => {
  vi.mocked(promptSync.loadSystemPromptsWithRegex).mockResolvedValue(entries);
  records.length = 0;
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const result = await applySystemPrompts(
    current,
    VERSION,
    false,
    patchFilter,
    PRISTINE,
    answers
  );
  logSpy.mockRestore();
  return {
    result,
    paths: pristinePaths(),
    clobbers: clobbers(),
  };
};

const sessionFor = async (
  entries: Entry[],
  pristine: string,
  patchFilter: string[] | null = null
): Promise<PristinePromptAnswers> => {
  vi.mocked(promptSync.loadSystemPromptsWithRegex).mockResolvedValue(entries);
  return (
    await buildPristineSession({ pristine, version: VERSION, patchFilter })
  ).answers;
};

describe('pristine session answers in the clobber check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(systemPromptHashIndex.setAppliedHashes).mockResolvedValue();
  });

  it('maps both shapes to one regex', () => {
    expect(entry('a', TEXT).regex).toBe(entry('b', SAME_SHAPE).regex);
  });

  it('declines a same-regex answer the batch compiled from other pieces', async () => {
    const entries = [
      entry('js-first', TEXT),
      entry('asset-only', SAME_SHAPE, 'prompts.md'),
      entry('js-last', TEXT),
    ];
    const answers = await sessionFor(entries, PRISTINE);
    const stored = answers.answers.get(entries[0].regex);
    expect(stored?.spec.pieces).toBe(entries[1].pieces);
    expect(stored?.spec.pieces).not.toBe(entries[2].pieces);
    expect(stored?.accepted.has(entries[2].pieces)).toBe(false);
    expect(stored?.matches).toHaveLength(1);

    const reused = await run(entries, CURRENT, answers);
    const fresh = await run(entries, CURRENT, null);

    expect(
      reused.paths.filter(p => p === 'declined:specMismatch')
    ).toHaveLength(3);
    expect(reused.paths).not.toContain('session');
    expect(fresh.paths).not.toContain('session');
    expect(reused.clobbers).toEqual(fresh.clobbers);
    expect(
      reused.clobbers.map(c => (c as { verdict: boolean }).verdict)
    ).toEqual([true, true, true]);
    expect(reused.result).toEqual(fresh.result);
  });

  it('answers for an entry whose pieces equal the compiled spec', async () => {
    const entries = [entry('first', TEXT), entry('second', TEXT)];
    const answers = await sessionFor(entries, PRISTINE);
    const stored = answers.answers.get(entries[0].regex);
    expect(stored?.spec.pieces).toBe(entries[0].pieces);
    expect(stored?.accepted.has(entries[1].pieces)).toBe(true);
    const reused = await run(entries, CURRENT, answers);
    const fresh = await run(entries, CURRENT, null);
    expect(reused.paths).toEqual(['session', 'session']);
    expect(reused.clobbers).toEqual(fresh.clobbers);
    expect(reused.result).toEqual(fresh.result);
  });

  it('answers from the session when the batch compiled the same spec', async () => {
    const entries = [entry('only', TEXT)];
    const answers = await sessionFor(entries, PRISTINE);
    const reused = await run(entries, CURRENT, answers);
    const fresh = await run(entries, CURRENT, null);

    expect(reused.paths).toEqual(['session']);
    expect(fresh.paths).toContain('declined:noSession');
    expect(reused.clobbers).toEqual(fresh.clobbers);
    expect(reused.clobbers).toEqual([
      expect.objectContaining({ verdict: true }),
    ]);
    expect(reused.result).toEqual(fresh.result);
  });

  it('checks every reused answer against the U1 path in shadow mode', async () => {
    const entries = [
      entry('only', TEXT),
      entry('absent', 'text found nowhere'),
    ];
    const answers = await sessionFor(entries, PRISTINE);
    shadow.on = true;
    try {
      const reused = await run(entries, CURRENT, answers);
      expect(reused.paths.filter(p => p === 'session')).toHaveLength(2);
      expect(
        records.filter(r => r.k === 'shadow' && r.check === 'u4-pristine-reuse')
      ).toHaveLength(2);
    } finally {
      shadow.on = false;
    }
  });

  it('declines when the apply filters differently from the preflight', async () => {
    const entries = [
      entry('only', TEXT),
      entry('other', 'unrelated text here'),
    ];
    const answers = await sessionFor(entries, PRISTINE, ['only']);
    const unfiltered = await run(entries, CURRENT, answers);
    const fresh = await run(entries, CURRENT, null);
    expect(unfiltered.paths).toContain('declined:filtered');
    expect(unfiltered.paths).not.toContain('session');
    expect(unfiltered.clobbers).toEqual(fresh.clobbers);
    expect(unfiltered.result).toEqual(fresh.result);

    const filtered = await run(entries, CURRENT, answers, ['only']);
    const freshFiltered = await run(entries, CURRENT, null, ['only']);
    expect(filtered.paths).toEqual(['session']);
    expect(filtered.clobbers).toEqual(freshFiltered.clobbers);
    expect(filtered.result).toEqual(freshFiltered.result);
  });

  it('declines when the current text carries another build time', async () => {
    const entries = [entry('only', TEXT)];
    const answers = await sessionFor(entries, PRISTINE);
    const current = `${CURRENT}BUILD_TIME:"2026-02-02T00:00:00Z"`;
    const reused = await run(entries, current, answers);
    const fresh = await run(entries, current, null);
    expect(reused.paths).toContain('declined:buildTimeMismatch');
    expect(reused.paths).not.toContain('session');
    expect(reused.clobbers).toEqual(fresh.clobbers);
    expect(reused.result).toEqual(fresh.result);
  });

  it('declines an answer computed for another pristine text', async () => {
    const entries = [entry('only', TEXT)];
    const answers = await sessionFor(entries, `${PRISTINE} `);
    const reused = await run(entries, CURRENT, answers);
    expect(reused.paths).toContain('declined:noSession');
    expect(reused.paths).not.toContain('session');
  });
});
