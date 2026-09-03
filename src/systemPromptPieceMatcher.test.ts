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
    'sg',
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
        'sg',
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
        'sg',
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
    const content = 'new description with The MCP server name';
    await catalog.matchBatch(original);
    const working = new MutableText(content);
    catalog.recordSplice(working, {
      start: 0,
      end: original.length,
      replacementLength: content.length,
    });
    const expected = await findAllMatchesWithStackFallback(
      matcher.regex,
      'sg',
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

describe('case sensitivity', () => {
  // Matching is case-sensitive. The `i` flag was carried for hex-casing in
  // `\uXXXX` escapes, which escapeNonAsciiForRegex already handles precisely,
  // and it widened every prompt regex over its own PROSE — `(no output)` occurs
  // 6 times in cli.js (its exact catalogue multiplicity) but 8 times
  // case-insensitively, so the group resolved as ambiguous and was skipped.
  it('passes content through unfolded', () => {
    expect(foldPromptMatchContent('A\u0130\u212A')).toBe('A\u0130\u212A');
  });

  it('does not match a prompt against differently-cased prose', async () => {
    const matcher = spec(['Only http(s), mailto, relative, or fragment URLs']);
    const found = await findAllPromptPieceMatches(
      matcher,
      'x = "only http(s), mailto, relative, or fragment URLs";'
    );
    expect(found).toEqual([]);
  });

  // Kelvin sign (U+212A) equates to ASCII k under non-unicode ignoreCase. With
  // the flag gone the hazard cannot arise at all, but keep it pinned.
  it('does not equate Kelvin signs with ASCII k', async () => {
    const matcher = spec(['kkkkkkkkkkkk']);
    expect(
      await findAllPromptPieceMatches(matcher, '\u212A'.repeat(12))
    ).toEqual([]);
  });
});

// A bracket KEY on an interpolated object carries a minified identifier, and
// minifiers pick a different letter per platform. Pinning the darwin name makes
// the prompt unmatchable on Linux while every local gate stays green — which is
// exactly what the cross-platform gate exists to catch. Both engines have to
// generalize it, and identically, or `pnpm test:matcher` fails.
describe('bracket keys on an interpolated object are platform-generalized', () => {
  const bothEngines = async (pieces: string[], haystack: string) => {
    const matcher = spec(pieces);
    const viaRegex = await findAllMatchesWithStackFallback(
      matcher.regex,
      'sg',
      haystack
    );
    const viaMatcher = await findAllPromptPieceMatches(matcher, haystack);
    // The two engines must agree; `pnpm test:matcher` enforces the same
    // property against the real bundle.
    expect(viaMatcher.length).toBe(viaRegex.length);
    return viaMatcher.length;
  };

  // `${o[P-1]}` — CC 2.1.251's two zsh `read` tool-results. `P` on darwin is
  // `E` on linux-arm64.
  it('matches an arithmetic key under either platform name', async () => {
    const pieces = ["'read ${", "[P-1]}' operand is too complex"];
    expect(
      await bothEngines(pieces, `x='read \${o[P-1]}' operand is too complex;`)
    ).toBe(1);
    expect(
      await bothEngines(pieces, `x='read \${q[E-1]}' operand is too complex;`)
    ).toBe(1);
  });

  // `${OBJ[g.terminal]}` — CC 2.1.237's /terminal-setup pair. The leading
  // identifier is minified; the property path is Anthropic's own.
  it('matches a property-path key under either platform name', async () => {
    const pieces = ['open ${', '[g.terminal]} to finish'];
    expect(
      await bothEngines(pieces, 'open ${M[G.terminal]} to finish now')
    ).toBe(1);
    expect(
      await bothEngines(pieces, 'open ${M[q.terminal]} to finish now')
    ).toBe(1);
  });

  // The plain member key was already generalized; keep it covered so a future
  // edit to the arithmetic branch cannot break it.
  it('matches a plain member key under either platform name', async () => {
    const pieces = ['pick ${', '[f]} first'];
    expect(await bothEngines(pieces, 'pick ${m[f]} first please')).toBe(1);
    expect(await bothEngines(pieces, 'pick ${m[Z9]} first please')).toBe(1);
  });

  // `${Mh(me[K].value)}` — CC 2.1.259's worktree-guard results. The key is
  // followed by `.value)` rather than `}`, so a `}`-only lookahead left `K`
  // pinned to the darwin name and both prompts were unmatchable on linux-arm64
  // while every darwin gate stayed green. The cross-platform gate caught it.
  it('generalizes a bracket key followed by a property access, not just }', async () => {
    const pieces = ['with ${', '(', '[K].value) here'];
    expect(await bothEngines(pieces, 'x=`with ${Mh(me[K].value) here`;')).toBe(
      1
    );
    expect(await bothEngines(pieces, 'x=`with ${Aq(zz[Q7].value) here`;')).toBe(
      1
    );
  });

  // The same key closing a call directly (`[K])`) rather than a property.
  it('generalizes a bracket key followed by a closing paren', async () => {
    const pieces = ['run ${', '(', '[K]) now'];
    expect(await bothEngines(pieces, 'x=`run ${f(a[K]) now`;')).toBe(1);
    expect(await bothEngines(pieces, 'x=`run ${f(a[W3]) now`;')).toBe(1);
  });
});
