import { describe, expect, it, vi } from 'vitest';
import { MutableText } from './mutableText';
import { findAllMatchesWithStackFallback } from './safeRegexMatch';
import {
  MAX_ANCHOR_OCCURRENCES,
  PromptPieceMatcherCatalog,
  type PromptMatchSpec,
} from './systemPromptPieceMatcher';
import { buildSearchRegexFromPieces } from './systemPromptSync';

const { records } = vi.hoisted(() => ({
  records: [] as Array<Record<string, unknown>>,
}));

vi.mock('./perfTrace', async () => {
  const actual =
    await vi.importActual<typeof import('./perfTrace')>('./perfTrace');
  return {
    ...actual,
    TRACE: {
      emit: (kind: string, record: Record<string, unknown>) => {
        records.push({ k: kind, ...record });
      },
      digest: (text: string) => text,
      clip: (text: string) => text,
    },
  };
});

const VERSION = '9.9.9';
const PIECE = 'common phrase here';

const spec = (piece: string): PromptMatchSpec => ({
  regex: buildSearchRegexFromPieces([piece], VERSION),
  pieces: [piece],
  version: VERSION,
});

const COMMON = spec(PIECE);

const textWith = (count: number, tail = ''): string =>
  Array.from({ length: count }, (_, i) => `"${PIECE}";v${i};`).join('') + tail;

const signature = (matches: RegExpExecArray[]): string =>
  JSON.stringify(matches.map(m => [m.index, ...Array.from(m)]));

const fresh = async (text: string): Promise<string> =>
  signature(await findAllMatchesWithStackFallback(COMMON.regex, 'sg', text));

const memoHits = (): number =>
  records.filter(r => r.k === 'memo' && r.hit === true).length;

const memoMisses = (): number =>
  records.filter(r => r.k === 'memo' && r.hit === false).length;

describe('regex fallback memo', () => {
  it('answers a repeat on the same content and text from the memo', async () => {
    records.length = 0;
    const text = textWith(MAX_ANCHOR_OCCURRENCES + 1);
    const working = new MutableText(text);
    const catalog = new PromptPieceMatcherCatalog([COMMON]);
    catalog.index(text);
    expect(catalog.indexedOccurrences(COMMON.regex)).toBeNull();
    const first = await catalog.matchCurrent(COMMON.regex, working);
    const second = await catalog.matchCurrent(COMMON.regex, working);
    expect(memoMisses()).toBe(1);
    expect(memoHits()).toBe(1);
    expect(second).toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
    expect(second.every(match => Object.isFrozen(match))).toBe(true);
    expect(signature(second)).toBe(await fresh(text));
    expect(second).toHaveLength(MAX_ANCHOR_OCCURRENCES + 1);
  });

  it('recomputes after index() of other text on the same content object', async () => {
    records.length = 0;
    const a = textWith(MAX_ANCHOR_OCCURRENCES + 1);
    const working = new MutableText(a);
    const catalog = new PromptPieceMatcherCatalog([COMMON]);
    catalog.index(a);
    expect(signature(await catalog.matchCurrent(COMMON.regex, working))).toBe(
      await fresh(a)
    );
    working.splice(0, 0, `"${PIECE}";lead;`);
    const b = working.toString();
    catalog.index(b);
    const afterReindex = await catalog.matchCurrent(COMMON.regex, working);
    expect(memoHits()).toBe(0);
    expect(memoMisses()).toBe(2);
    expect(signature(afterReindex)).toBe(await fresh(b));
    expect(afterReindex).toHaveLength(MAX_ANCHOR_OCCURRENCES + 2);
  });

  it('recomputes after index(B) on a different content string', async () => {
    records.length = 0;
    const a = textWith(MAX_ANCHOR_OCCURRENCES + 1);
    const b = textWith(MAX_ANCHOR_OCCURRENCES + 3);
    const catalog = new PromptPieceMatcherCatalog([COMMON]);
    catalog.index(a);
    expect(signature(await catalog.matchCurrent(COMMON.regex, a))).toBe(
      await fresh(a)
    );
    catalog.index(b);
    expect(signature(await catalog.matchCurrent(COMMON.regex, b))).toBe(
      await fresh(b)
    );
    expect(memoHits()).toBe(0);
  });

  it('recomputes after a splice between two calls', async () => {
    records.length = 0;
    const text = textWith(MAX_ANCHOR_OCCURRENCES + 1);
    const working = new MutableText(text);
    const catalog = new PromptPieceMatcherCatalog([COMMON]);
    catalog.index(text);
    await catalog.matchCurrent(COMMON.regex, working);
    const at = text.indexOf(PIECE);
    working.splice(at, at + PIECE.length, 'gone');
    catalog.recordSplice(working, {
      start: at,
      end: at + PIECE.length,
      replacementLength: 4,
    });
    const after = await catalog.matchCurrent(COMMON.regex, working);
    expect(memoHits()).toBe(0);
    expect(signature(after)).toBe(await fresh(working.toString()));
    expect(after).toHaveLength(MAX_ANCHOR_OCCURRENCES);
    expect(signature(await catalog.matchCurrent(COMMON.regex, working))).toBe(
      signature(after)
    );
    expect(memoHits()).toBe(1);
  });

  it('drops the entry on delete and shares nothing between instances', async () => {
    records.length = 0;
    const a = textWith(MAX_ANCHOR_OCCURRENCES + 1);
    const b = textWith(MAX_ANCHOR_OCCURRENCES + 4);
    const working = new MutableText(a);
    const first = new PromptPieceMatcherCatalog([COMMON]);
    first.index(a);
    await first.matchCurrent(COMMON.regex, working);
    first.delete(COMMON.regex);
    expect(await first.matchCurrent(COMMON.regex, working)).toEqual([]);

    const readded = new PromptPieceMatcherCatalog([COMMON]);
    readded.index(a);
    const other = new PromptPieceMatcherCatalog([COMMON]);
    other.index(b);
    const fromReadded = await readded.matchCurrent(COMMON.regex, working);
    const fromOther = await other.matchCurrent(COMMON.regex, b);
    expect(memoHits()).toBe(0);
    expect(signature(fromReadded)).toBe(await fresh(a));
    expect(signature(fromOther)).toBe(await fresh(b));
    expect(signature(await readded.matchCurrent(COMMON.regex, working))).toBe(
      await fresh(a)
    );
    expect(signature(await other.matchCurrent(COMMON.regex, b))).toBe(
      await fresh(b)
    );
    expect(memoHits()).toBe(2);
  });

  it('caches nothing when the fallback throws', async () => {
    records.length = 0;
    const broken: PromptMatchSpec = {
      regex: '(',
      pieces: ['${a.b}'],
      version: VERSION,
    };
    const catalog = new PromptPieceMatcherCatalog([broken]);
    const text = 'x${a.b}y';
    catalog.index(text);
    await expect(catalog.matchCurrent('(', text)).rejects.toThrow();
    await expect(catalog.matchCurrent('(', text)).rejects.toThrow();
    expect(memoHits()).toBe(0);
  });
});
