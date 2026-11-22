import { describe, expect, it } from 'vitest';
import { MutableText } from './mutableText';
import { findAllMatchesWithStackFallback } from './safeRegexMatch';
import {
  MAX_ANCHOR_OCCURRENCES,
  PromptPieceMatcherCatalog,
  promptAnchorInfo,
  type PromptMatchSpec,
} from './systemPromptPieceMatcher';
import { buildSearchRegexFromPieces } from './systemPromptSync';

const VERSION = '9.9.9';
const PAIR = '\u{1F600}';

const spec = (piece: string): PromptMatchSpec => ({
  regex: buildSearchRegexFromPieces([piece], VERSION),
  pieces: [piece],
  version: VERSION,
});

const LONG = spec('alpha bravo charlie delta echo');
const AT_249 = spec('count oscar papa quebec');
const AT_250 = spec('count romeo sierra tango');
const AT_251 = spec('count uniform victor whiskey');
const SHORT = spec('\n</qq>\n');
const TINY = spec('\n<q>\n');
const ARROW = spec('Settings \u2192 This computer \u2192 System panel');
const COLLIDE = spec('Apha bravo charlie zulu');
const SPECS = [LONG, AT_249, AT_250, AT_251, SHORT, TINY, ARROW, COLLIDE];

const literal = (text: string): string => `"${text}";`;

const repeated = (text: string, count: number): string =>
  Array.from({ length: count }, () => literal(text)).join('');

const fixture = (): string =>
  [
    PAIR,
    literal(LONG.pieces[0]),
    literal('alpha bravo XXcharlie delta echo'),
    PAIR,
    literal(LONG.pieces[0]),
    repeated(AT_249.pieces[0], 249),
    repeated(AT_250.pieces[0], 250),
    repeated(AT_251.pieces[0], 251),
    literal('\\n</qq>\\n'),
    PAIR,
    literal('\\n<q>\\n'),
    literal('\n<q>\n'),
    literal('Settings \u2192 This computer \u2192 System panel'),
    literal('Settings \\u2192 This computer \\u2192 System panel'),
    literal('\u0141pha bravo charlie zulu'),
    literal(COLLIDE.pieces[0]),
    PAIR,
    literal(LONG.pieces[0]),
  ].join('\n');

const oracle = (text: string, anchor: string): number[] | null => {
  const found: number[] = [];
  for (
    let at = text.indexOf(anchor);
    at !== -1;
    at = text.indexOf(anchor, at + 1)
  ) {
    found.push(at);
  }
  return found.length > MAX_ANCHOR_OCCURRENCES ? null : found;
};

const signature = (matches: RegExpExecArray[]): string =>
  JSON.stringify(matches.map(m => [m.index, ...Array.from(m)]));

describe('anchor index fixtures (UTF-16 offsets, splices, cap transitions)', () => {
  it('keeps every indexed occurrence exact through surrogate pairs and splices', async () => {
    const working = new MutableText(fixture());
    const catalog = new PromptPieceMatcherCatalog(SPECS);
    catalog.index(working.toString());
    const nulled = new Set<string>();
    const pastPair: Record<string, number> = {};

    const compare = async (stage: string): Promise<void> => {
      const text = working.toString();
      const firstPair = text.search(/[\uD800-\uDBFF]/);
      let past = 0;
      for (const s of SPECS) {
        const anchor = promptAnchorInfo(s).anchor;
        expect(anchor, s.pieces[0]).not.toBeNull();
        const want = oracle(text, anchor!);
        const got = catalog.indexedOccurrences(s.regex);
        if (stage === 'index' || got !== null) {
          expect(got, `${stage}: ${anchor}`).toEqual(want);
        } else {
          expect(
            want === null || nulled.has(s.regex),
            `${stage}: ${anchor}`
          ).toBe(true);
        }
        expect(got, `${stage}: ${anchor}`).toBeDefined();
        if (got === null) nulled.add(s.regex);
        else if (got && firstPair !== -1)
          past += got.filter(at => at > firstPair).length;
        const current = await catalog.matchCurrent(s.regex, working);
        const reference = await findAllMatchesWithStackFallback(
          s.regex,
          'sg',
          text
        );
        expect(signature(current), `${stage}: ${anchor}`).toBe(
          signature(reference)
        );
      }
      pastPair[stage] = past;
    };

    const splice = async (
      stage: string,
      start: number,
      end: number,
      replacement: string
    ): Promise<void> => {
      working.splice(start, end, replacement);
      catalog.recordSplice(working, {
        start,
        end,
        replacementLength: replacement.length,
      });
      await compare(stage);
    };

    await compare('index');
    expect(catalog.indexedOccurrences(AT_249.regex)).toHaveLength(249);
    expect(catalog.indexedOccurrences(AT_250.regex)).toHaveLength(250);
    expect(catalog.indexedOccurrences(AT_251.regex)).toBeNull();
    expect(catalog.indexedOccurrences(COLLIDE.regex)).toHaveLength(1);

    const text = (): string => working.toString();
    const second = text().indexOf(
      LONG.pieces[0],
      text().indexOf(LONG.pieces[0]) + 1
    );
    await splice('insert-pair', second, second, PAIR);
    await splice('delete-pair', 0, PAIR.length, '');
    const gap = text().indexOf('XXcharlie');
    await splice('form-across-boundary', gap, gap + 2, '');
    const at249 = text().indexOf(AT_249.pieces[0]);
    await splice('destroy-one', at249, at249 + 1, 'K');
    const at250 = text().indexOf(AT_250.pieces[0]);
    await splice('cross-cap', at250, at250, literal(AT_250.pieces[0]));
    const at251 = text().indexOf(AT_251.pieces[0]);
    await splice('below-cap-after-null', at251, at251 + 1, 'K');

    expect(catalog.indexedOccurrences(AT_249.regex)).toHaveLength(248);
    expect(catalog.indexedOccurrences(AT_250.regex)).toBeNull();
    expect(catalog.indexedOccurrences(LONG.regex)).toHaveLength(4);
    for (const [stage, count] of Object.entries(pastPair)) {
      expect(
        count,
        `${stage}: occurrences past a surrogate pair`
      ).toBeGreaterThan(0);
    }
    expect(Object.keys(pastPair)).toHaveLength(7);
  });
});
