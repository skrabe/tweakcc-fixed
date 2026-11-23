import { describe, expect, it } from 'vitest';

import { findAllMatchesWithStackFallback } from './safeRegexMatch';
import { MutableText } from './mutableText';
import {
  findAllPromptPieceMatches,
  findAllPromptPieceMatchesBatch,
  foldPromptMatchContent,
  PRISTINE_RESCANS_BEFORE_INDEX,
  PromptPieceMatcherCatalog,
  PromptMatchSpec,
} from './systemPromptPieceMatcher';
import { buildSearchRegexFromPieces } from './systemPromptSync';
import {
  BundleRegions,
  matchesInRegion,
  moduleCountDeclaration,
  moduleSentinel,
} from './virtualBundle';

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

  // `${a?b[E]:"stopped before it completed"}` — CC 2.1.266's getTask-stopped
  // tool result. The key is followed by a ternary `:`, which the previous
  // shortlist did not admit, so `E` stayed pinned to the darwin name and the
  // prompt was unmatchable on linux-x64 while every darwin gate stayed green.
  // Fourth instance of this family, so the lookahead now takes any expression
  // continuation rather than another enumerated shape.
  it('generalizes a bracket key followed by a ternary colon', async () => {
    const pieces = ['was ${', '?', '[E]:"stopped" }. done'];
    expect(
      await bothEngines(pieces, 'x=`was ${p?q[E]:"stopped" }. done`;')
    ).toBe(1);
    expect(
      await bothEngines(pieces, 'x=`was ${p?q[Vt]:"stopped" }. done`;')
    ).toBe(1);
  });

  // CC 2.1.286's html-saved viewed-once clause: `{ignoreHold:At}` sits deep in
  // the slot expression, and `At` is `kt` on linux-x64.
  it('generalizes a minified value behind an object-literal key', async () => {
    const pieces = ['file${', '(', ',', '.slug,', '.ver,{ignoreHold:At})}'];
    expect(
      await bothEngines(
        pieces,
        'x=`file${WOe(n,e.slug,r.ver,{ignoreHold:At})}`'
      )
    ).toBe(1);
    expect(
      await bothEngines(
        pieces,
        'x=`file${NHe(n,e.slug,r.ver,{ignoreHold:kt})}`'
      )
    ).toBe(1);
    expect(
      await bothEngines(
        pieces,
        'x=`file${NHe(n,e.slug,r.ver,{ignoreHeld:kt})}`'
      )
    ).toBe(0);
  });

  // CC 2.1.286's live-doc shim: the spreads repeat `Oe` (`Le` on linux-x64);
  // each occurrence matches independently.
  it('generalizes every repeated minified name in spreads', async () => {
    const pieces = [
      '${',
      '.line(',
      '.file,{edits:',
      '.edits,...',
      '.copy!==void 0&&{copy:Oe.copy},...typeof Oe.live==="string"&&{live:Oe.live}})}',
    ];
    const darwin =
      '${se.line(Oe.file,{edits:Oe.edits,...Oe.copy!==void 0&&{copy:Oe.copy},...typeof Oe.live==="string"&&{live:Oe.live}})}';
    expect(await bothEngines(pieces, darwin)).toBe(1);
    expect(await bothEngines(pieces, darwin.replace(/Oe/g, 'Le'))).toBe(1);
    expect(
      await bothEngines(pieces, darwin.replace(/Oe\.live\}/, 'Zz.live}'))
    ).toBe(1);
    expect(await bothEngines(pieces, darwin.replace('{copy:', '{kopy:'))).toBe(
      0
    );
  });

  // Same class, comma and closing-bracket continuations.
  it('generalizes a bracket key followed by a comma or a closing bracket', async () => {
    const comma = ['call ${', '(', '[K], 2) end'];
    expect(await bothEngines(comma, 'x=`call ${f(a[K], 2) end`;')).toBe(1);
    expect(await bothEngines(comma, 'x=`call ${f(a[Zz], 2) end`;')).toBe(1);
    const close = ['idx ${', '[', '[K]] end'];
    expect(await bothEngines(close, 'x=`idx ${o[a[K]] end`;')).toBe(1);
    expect(await bothEngines(close, 'x=`idx ${o[a[Q9]] end`;')).toBe(1);
  });
});

// A prompt with no 12-char word run (`\n</ax-summary>`, `${a}.path} → ${b}`)
// used to fall back to its RegExp for every lookup, which over a MutableText
// meant joining the whole bundle first: ~1,500 full copies per apply. It now
// narrows on its longest exact literal run, so it must never reach the RegExp.
describe('prompts without a long word run', () => {
  // A spec whose RegExp cannot even compile: reaching the fallback throws.
  const tokenOnly = (pieces: string[]): PromptMatchSpec => ({
    ...spec(pieces),
    regex: `(${pieces.join('|')}`,
  });

  it('agree with the RegExp engine on short and punctuation anchors', async () => {
    const haystack =
      'a=`\n</ax-summary>`;b="  ${o}.path} → ${q}";c="(x)"; d=`\n</ax-summary>`';
    await expectEquivalent(['\n</ax-summary>'], haystack);
    await expectEquivalent(['  ${', '.path} → ${', '}'], haystack);
    await expectEquivalent(['(x)'], haystack);
  });

  it('are matched by the catalogue without the RegExp fallback', async () => {
    const short = tokenOnly(['\n</ax-summary>']);
    const tiny = tokenOnly(['(x)']);
    const catalog = new PromptPieceMatcherCatalog([short, tiny]);
    const content = 'a=`\n</ax-summary>`;c="(x)";';
    catalog.index(content);
    const working = new MutableText(content);
    expect(
      (await catalog.matchCurrent(short.regex, working)).map(signature)
    ).toEqual([[3, '\n</ax-summary>']]);
    expect(
      (await catalog.matchCurrent(tiny.regex, working)).map(signature)
    ).toEqual([[22, '(x)']]);
  });

  it('keeps short and tiny anchor occurrences current through a splice', async () => {
    const short = tokenOnly(['\n</ax-summary>']);
    const tiny = tokenOnly(['(x)']);
    const catalog = new PromptPieceMatcherCatalog([short, tiny]);
    const original = 'a=`OLD`;';
    catalog.index(original);
    const working = new MutableText(original);
    const replacement = '\n</ax-summary>(x)';
    working.splice(3, 6, replacement);
    catalog.recordSplice(working, {
      start: 3,
      end: 6,
      replacementLength: replacement.length,
    });
    expect(
      (await catalog.matchCurrent(short.regex, working)).map(signature)
    ).toEqual([[3, '\n</ax-summary>']]);
    expect(
      (await catalog.matchCurrent(tiny.regex, working)).map(signature)
    ).toEqual([[17, '(x)']]);
  });
});

describe('PromptPieceMatcherCatalog.matchPristine', () => {
  const tokenOnly = (pieces: string[]): PromptMatchSpec => ({
    ...spec(pieces),
    regex: `(${pieces.join('|')}`,
  });

  const rescan = async (
    matcher: PromptMatchSpec,
    content: string
  ): Promise<unknown> => {
    try {
      return (await findAllPromptPieceMatches(matcher, content)).map(signature);
    } catch (error) {
      return { threw: String(error) };
    }
  };

  const fromIndex = async (
    catalog: PromptPieceMatcherCatalog,
    matcher: PromptMatchSpec,
    content: string
  ): Promise<unknown> => {
    for (let i = 0; i < PRISTINE_RESCANS_BEFORE_INDEX; i++) {
      await catalog.matchPristine(matcher, content).catch(() => []);
    }
    try {
      return (await catalog.matchPristine(matcher, content)).map(signature);
    } catch (error) {
      return { threw: String(error) };
    }
  };

  it('answers the first checks by rescanning, then from the index', async () => {
    const matcher = spec(['Rescanned Then Indexed Anchor']);
    const content =
      'a="Rescanned Then Indexed Anchor";b="rescanned then indexed anchor"';
    const catalog = new PromptPieceMatcherCatalog([matcher]);
    const expected = await rescan(matcher, content);
    for (let i = 0; i <= PRISTINE_RESCANS_BEFORE_INDEX + 1; i++) {
      expect(
        (await catalog.matchPristine(matcher, content)).map(signature)
      ).toEqual(expected);
    }
  });

  it('agrees with the pristine rescan for every anchor kind', async () => {
    const specs = [
      spec(['Long Enough Prefix "quoted" ', ' and tail']),
      spec(['\n</ax-summary>']),
      spec(['(x)']),
      spec(['${', '}']),
      spec(['café — Tail Words Here']),
    ];
    const content = [
      'a="Long Enough Prefix \\"quoted\\" aB and tail"',
      'b="long enough prefix \\"quoted\\" cD and tail"',
      'c=`\n</ax-summary>`;d=`\n</AX-SUMMARY>`;e="(x)(X)"',
      'f=`${abc} ${def}`',
      'g="caf\\xE9 \\u2014 tail words here";h="café — Tail Words Here"',
    ].join(';');
    const catalog = new PromptPieceMatcherCatalog(specs);
    for (const matcher of specs) {
      expect(await fromIndex(catalog, matcher, content)).toEqual(
        await rescan(matcher, content)
      );
    }
  });

  it('answers from the index without compiling the prompt regex', async () => {
    const matcher = tokenOnly(['Pristine Anchor Words', '!']);
    const content =
      'x="Pristine Anchor Words$!";y="pristine anchor words$!";z="PRISTINE ANCHOR WORDSq!"';
    const catalog = new PromptPieceMatcherCatalog([matcher]);
    const expected = await rescan(matcher, content);
    expect(expected).toEqual([[3, 'Pristine Anchor Words$!', '$']]);
    expect(await fromIndex(catalog, matcher, content)).toEqual(expected);
  });

  it('counts case-insensitive hits toward the occurrence cap as the rescan does', async () => {
    const prompt = 'Frequently Repeated Anchor!';
    const variant = 'frequently repeated ANCHOR!';
    for (const [exact, folded] of [
      [250, 0],
      [251, 0],
      [200, 50],
      [200, 51],
      [0, 251],
    ]) {
      const content = `${prompt} `.repeat(exact) + `${variant} `.repeat(folded);
      const indexedOnly = tokenOnly([prompt]);
      const indexedCatalog = new PromptPieceMatcherCatalog([indexedOnly]);
      const rescanned = await rescan(indexedOnly, content);
      expect(await fromIndex(indexedCatalog, indexedOnly, content)).toEqual(
        rescanned
      );
      expect(Array.isArray(rescanned)).toBe(exact + folded <= 250);

      const real = spec([prompt]);
      const realCatalog = new PromptPieceMatcherCatalog([real]);
      const expected = await rescan(real, content);
      expect(expected).toHaveLength(exact);
      expect(await fromIndex(realCatalog, real, content)).toEqual(expected);
    }
  });

  it('folds only ASCII letters, as the case-insensitive rescan does', async () => {
    const matcher = spec(['Keep Skipping Kelvin Signs']);
    const content = [
      '"Keep Skipping Kelvin Signs"',
      '"Keep ſkipping Kelvin ſigns"',
      '"KEEP SKIPPING KELVIN SIGNS"',
    ].join(',');
    const catalog = new PromptPieceMatcherCatalog([matcher]);
    expect(await fromIndex(catalog, matcher, content)).toEqual(
      await rescan(matcher, content)
    );
  });

  it('is unaffected by current-content splices and deletions', async () => {
    const kept = spec(['Surviving Pristine Prompt Text']);
    const gone = spec(['Deleted Before The Check Ran']);
    const pristine =
      'a="Surviving Pristine Prompt Text";b="Deleted Before The Check Ran"';
    const catalog = new PromptPieceMatcherCatalog([kept, gone]);
    catalog.index(pristine);
    const working = new MutableText(pristine);
    working.splice(3, 33, 'replaced');
    catalog.recordSplice(working, {
      start: 3,
      end: 33,
      replacementLength: 'replaced'.length,
    });
    catalog.delete(gone.regex);
    expect(await catalog.matchCurrent(kept.regex, working)).toEqual([]);
    expect(await fromIndex(catalog, kept, pristine)).toEqual(
      await rescan(kept, pristine)
    );
    expect(await fromIndex(catalog, gone, pristine)).toEqual(
      await rescan(gone, pristine)
    );
    expect(await fromIndex(catalog, kept, pristine)).toEqual([
      [3, 'Surviving Pristine Prompt Text'],
    ]);
  });

  it('keeps the JS and text-asset verdicts of the rescan', async () => {
    const shared = spec(['Shared By Script And Document']);
    const scriptOnly = spec(['Only The Script Carries This']);
    const assetOnly = spec(['Only The Document Carries This']);
    const content =
      '#!/usr/bin/env node\n' +
      moduleCountDeclaration(1) +
      moduleSentinel(0, '/$bunfs/root/m0.js') +
      'let a = "Shared By Script And Document";let b = "Only The Script Carries This";' +
      moduleSentinel(1, '/$bunfs/root/a0.md') +
      '`# Doc\nShared By Script And Document\nOnly The Document Carries This\n`';
    const regions = BundleRegions.of(content)!;
    expect(regions).not.toBeNull();
    const catalog = new PromptPieceMatcherCatalog([
      shared,
      scriptOnly,
      assetOnly,
    ]);
    for (let i = 0; i < PRISTINE_RESCANS_BEFORE_INDEX; i++) {
      await catalog.matchPristine(shared, content);
    }
    for (const [matcher, inJs, inAsset] of [
      [shared, true, true],
      [scriptOnly, true, false],
      [assetOnly, false, true],
    ] as const) {
      const expected = await findAllPromptPieceMatches(matcher, content);
      const actual = await catalog.matchPristine(matcher, content);
      expect(actual.map(signature)).toEqual(expected.map(signature));
      for (const [asset, present] of [
        [false, inJs],
        [true, inAsset],
      ] as const) {
        expect(matchesInRegion(actual, regions, asset).map(signature)).toEqual(
          matchesInRegion(expected, regions, asset).map(signature)
        );
        expect(matchesInRegion(actual, regions, asset).length > 0).toBe(
          present
        );
      }
    }
  });

  it('rebuilds for different content and falls back for a foreign spec', async () => {
    const matcher = spec(['Content Specific Anchor Text']);
    const catalog = new PromptPieceMatcherCatalog([matcher]);
    const first = 'x="Content Specific Anchor Text"';
    const second =
      'yy="content specific anchor text";z="Content Specific Anchor Text"';
    expect(await fromIndex(catalog, matcher, first)).toEqual(
      await rescan(matcher, first)
    );
    expect(await fromIndex(catalog, matcher, second)).toEqual(
      await rescan(matcher, second)
    );
    const foreign = { ...matcher };
    expect(await fromIndex(catalog, foreign, second)).toEqual(
      await rescan(foreign, second)
    );
  });
});
