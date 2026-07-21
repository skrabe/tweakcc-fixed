import { describe, expect, it } from 'vitest';

import { findAllMatchesWithStackFallback } from './safeRegexMatch';
import { MutableText } from './mutableText';
import {
  findAllPromptPieceMatches,
  findAllPromptPieceMatchesBatch,
  foldPromptMatchContent,
  PromptPieceMatcherCatalog,
  PromptMatchSpec,
} from './systemPromptPieceMatcher';
import { buildSearchRegexFromPieces } from './systemPromptSync';

const version = '2.1.215';

const spec = (pieces: string[]): PromptMatchSpec => ({
  regex: buildSearchRegexFromPieces(pieces, version),
  pieces,
  version,
});

const signature = (match: RegExpExecArray): Array<string | number | null> => [
  match.index,
  ...Array.from(match, value => value ?? null),
];

const expectEquivalent = async (
  pieces: string[],
  content: string
): Promise<void> => {
  const matcher = spec(pieces);
  const expected = await findAllMatchesWithStackFallback(
    matcher.regex,
    'sig',
    content
  );
  const actual = await findAllPromptPieceMatches(matcher, content);
  expect(actual.map(signature)).toEqual(expected.map(signature));
};

describe('findAllPromptPieceMatches', () => {
  it('matches delimiter, backslash, newline, and non-ASCII source forms', async () => {
    await expectEquivalent(
      ['long enough prefix "quoted" \\ path\ncafé — tail'],
      [
        'long enough prefix "quoted" \\ path\ncafé — tail',
        'long enough prefix \\"quoted\\" \\\\ path\\ncaf\\xE9 \\u2014 tail',
      ].join(' | ')
    );
  });

  it('matches inline interpolations without accepting nested braces', async () => {
    await expectEquivalent(
      ['long enough prefix ${obj.call(x)} and tail'],
      'long enough prefix ${a?b:c} and tail | ' +
        'long enough prefix ${a?{b}:c} and tail'
    );
  });

  it('returns greedy captures with the same backtracking as RegExp', async () => {
    const pieces = ['long enough prefix ${', 'ab and second ${', '[old]} tail'];
    await expectEquivalent(
      pieces,
      'long enough prefix ${FOOab and second ${OBJ[newKey]} tail'
    );
  });

  it('returns every non-overlapping site in source order', async () => {
    const pieces = ['a sufficiently distinctive repeated prompt'];
    const content = `${pieces[0]} xx ${pieces[0]}`;
    const matches = await findAllPromptPieceMatches(spec(pieces), content);
    expect(matches.map(match => match.index)).toEqual([
      0,
      pieces[0].length + 4,
    ]);
  });

  it('finds a valid match at an overlapping anchor occurrence', async () => {
    await expectEquivalent(['aaaaaaaaaaaa!'], 'aaaaaaaaaaaaa!');
  });

  it('falls back safely when no distinctive anchor exists', async () => {
    await expectEquivalent(['${', '}'], '${abc} ${def}');
  });

  it('falls back safely when an anchor has more than 250 occurrences', async () => {
    const prompt = 'frequently repeated anchor!';
    await expectEquivalent([prompt], `${prompt} `.repeat(251));
  });
});

describe('findAllPromptPieceMatchesBatch', () => {
  it('matches several shapes in one content scan', async () => {
    const specs = [
      spec(['first distinctive authored prompt']),
      spec(['second distinctive ${', '} prompt']),
    ];
    const content =
      'second distinctive ${x9} prompt | first distinctive authored prompt';
    const matches = await findAllPromptPieceMatchesBatch(
      specs,
      content,
      foldPromptMatchContent(content)
    );
    for (const matcher of specs) {
      const expected = await findAllMatchesWithStackFallback(
        matcher.regex,
        'sig',
        content
      );
      expect(matches.get(matcher.regex)?.map(signature)).toEqual(
        expected.map(signature)
      );
    }
  });

  it('repairs only matches touched by a splice and shifts the rest', async () => {
    const specs = [
      spec(['long enough prefix TARGET suffix']),
      spec(['TARGET']),
    ];
    const byRegex = new Map(specs.map(value => [value.regex, value]));
    const catalog = new PromptPieceMatcherCatalog([...byRegex.values()]);
    const original = 'long enough prefix TARGET suffix xx TARGET';
    const start = original.indexOf('TARGET');
    const replacement = 'TARGET!';
    const content =
      original.slice(0, start) +
      replacement +
      original.slice(start + 'TARGET'.length);
    await catalog.matchBatch(original);
    const working = new MutableText(content);
    catalog.recordSplice(working, {
      start,
      end: start + 'TARGET'.length,
      replacementLength: replacement.length,
    });

    for (const matcher of specs) {
      const expected = await findAllMatchesWithStackFallback(
        matcher.regex,
        'sig',
        content
      );
      expect(
        (await catalog.matchCurrent(matcher.regex, working)).map(signature)
      ).toEqual(expected.map(signature));
    }
  });

  it('indexes a match introduced entirely by replacement text', async () => {
    const matcher = spec(['The MCP server name']);
    const catalog = new PromptPieceMatcherCatalog([matcher]);
    const original = 'old resource description';
    const content = 'new description with the MCP server name';
    await catalog.matchBatch(original);
    const working = new MutableText(content);
    catalog.recordSplice(working, {
      start: 0,
      end: original.length,
      replacementLength: content.length,
    });
    const expected = await findAllMatchesWithStackFallback(
      matcher.regex,
      'sig',
      content
    );
    expect(
      (await catalog.matchCurrent(matcher.regex, working)).map(signature)
    ).toEqual(expected.map(signature));
  });

  it('indexes a match formed across both splice boundaries', async () => {
    const matcher = spec(['prefix TARGET suffix']);
    const catalog = new PromptPieceMatcherCatalog([matcher]);
    const original = 'prefix OLD suffix';
    await catalog.matchBatch(original);
    const working = new MutableText(original);
    const start = original.indexOf('OLD');
    working.splice(start, start + 3, 'TARGET');
    catalog.recordSplice(working, {
      start,
      end: start + 3,
      replacementLength: 6,
    });
    expect(
      (await catalog.matchCurrent(matcher.regex, working)).map(signature)
    ).toEqual([[0, 'prefix TARGET suffix']]);
  });

  it('keeps overflowed anchors on the full-match fallback after a splice', async () => {
    const prompt = 'frequently repeated anchor!';
    const matcher = spec([prompt]);
    const catalog = new PromptPieceMatcherCatalog([matcher]);
    const original = `${prompt} `.repeat(300);
    await catalog.matchBatch(original);
    const working = new MutableText(original);
    working.splice(0, prompt.length, 'X');
    catalog.recordSplice(working, {
      start: 0,
      end: prompt.length,
      replacementLength: 1,
    });
    expect(await catalog.matchCurrent(matcher.regex, working)).toHaveLength(
      299
    );
  });
});

describe('foldPromptMatchContent', () => {
  it('only folds ASCII so UTF-16 offsets and RegExp semantics stay intact', () => {
    expect(foldPromptMatchContent('A\u0130\u212A')).toBe('a\u0130\u212A');
  });

  it('does not equate Kelvin signs with ASCII k under non-u ignoreCase', async () => {
    await expectEquivalent(['kkkkkkkkkkkk'], '\u212A'.repeat(12));
  });
});
