import { describe, expect, it } from 'vitest';
import {
  checkPromptDifferential,
  indexBundleOccurrences,
} from './matcherDifferential';
import { MAX_ANCHOR_OCCURRENCES } from './systemPromptPieceMatcher';

const PIECES = ['Report the zebra quartz marker now'];
const VERSION = '9.9.9';

const bundleWith = (copies: number, extra = ''): string =>
  'var v="9.9.9";\n' +
  Array.from({ length: copies }, (_, n) => `var s${n}="${PIECES[0]}";`).join(
    '\n'
  ) +
  extra;

describe('matcher differential core', () => {
  it('compares the token matcher past the occurrence cap instead of the regex with itself', async () => {
    const content = bundleWith(MAX_ANCHOR_OCCURRENCES + 1);
    const [indexed] = indexBundleOccurrences([PIECES], VERSION, content);
    expect(indexed).toBeNull();
    const result = await checkPromptDifferential(
      PIECES,
      VERSION,
      content,
      indexed
    );
    expect(result).toMatchObject({
      status: 'match',
      exercised: true,
      answer: 'token-past-cap',
    });
  });

  it('answers from the exact-case index below the cap', async () => {
    const content = bundleWith(3, `\nvar u="${PIECES[0].toUpperCase()}";`);
    const [indexed] = indexBundleOccurrences([PIECES], VERSION, content);
    expect(indexed).toHaveLength(3);
    const result = await checkPromptDifferential(
      PIECES,
      VERSION,
      content,
      indexed
    );
    expect(result).toMatchObject({ status: 'match', answer: 'token' });
    expect(result.status === 'match' && result.kinds).toContain('literal');
  });

  it('reports a wrong occurrence list as a mismatch', async () => {
    const content = bundleWith(2);
    const result = await checkPromptDifferential(PIECES, VERSION, content, [
      content.indexOf(PIECES[0]),
    ]);
    expect(result).toMatchObject({ status: 'mismatch', answer: 'token' });
  });
});
