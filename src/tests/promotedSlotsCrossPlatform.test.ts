import { describe, expect, it } from 'vitest';

import { findAllMatchesWithStackFallback } from '../safeRegexMatch';
import { findAllPromptPieceMatches } from '../systemPromptPieceMatcher';
import {
  applyIdentifierMapping,
  buildSearchRegexFromPieces,
} from '../systemPromptSync';

/* eslint-disable @typescript-eslint/no-require-imports */
const parser = require('@babel/parser');
const { templateShape } = require('../../tools/lib/bundleSites.cjs');
/* eslint-enable @typescript-eslint/no-require-imports */

// Extract a template the way the catalogue does, then check that the entry
// matches a build whose minifier picked other names, on both match engines, and
// that the override writes that build's own names back.
const version = '2.1.300';

const shapeOf = (src: string) => {
  const ast = parser.parse(src);
  return templateShape(ast.program.body[0].expression.right, src) as {
    pieces: string[];
    identifiers: number[];
  };
};

const matchBoth = async (pieces: string[], haystack: string) => {
  const regex = buildSearchRegexFromPieces(pieces, version);
  const viaRegex = await findAllMatchesWithStackFallback(regex, 'sg', haystack);
  const viaMatcher = await findAllPromptPieceMatches(
    { regex, pieces, version },
    haystack
  );
  expect(viaMatcher.map(m => [m.index, ...m])).toEqual(
    viaRegex.map(m => [m.index, ...m])
  );
  return viaMatcher;
};

describe('an indexed object literal matches across platform builds', () => {
  const body = (key: string, cond: string) =>
    '`Write a doc. ${{here:"Pass `path` or `local_path`.",none:"Pass `path` and `content`."}[' +
    key +
    ']} Then ${' +
    cond +
    '?"list memory.":""} Done.`';
  const darwin = `x=${body('e', 'Mt')};`;
  const linux = `x=${body('t', 'Qa')};`;

  it('captures the index as a slot', () => {
    const shape = shapeOf(darwin);
    expect(shape.identifiers).toEqual([0, 1]);
    expect(shape.pieces.some(p => p.includes('[e]'))).toBe(false);
  });

  it('matches the other build and writes its index back', async () => {
    const { pieces, identifiers } = shapeOf(darwin);
    expect(await matchBoth(pieces, darwin)).toHaveLength(1);
    const [match] = await matchBoth(pieces, linux);
    expect(match).toBeDefined();
    expect(Array.from(match).slice(1)).toEqual(['t', 'Qa']);

    const override =
      'Write a doc. ${{here:"Pass `path`.",none:"Pass `content`."}[DOC_MODE]} Then ${HAS_MEMORY?"list memory.":""} Done.';
    const written = applyIdentifierMapping(
      override,
      identifiers,
      { 0: 'DOC_MODE', 1: 'HAS_MEMORY' },
      Array.from(match).slice(1) as string[],
      version
    );
    expect(written).toBe(
      'Write a doc. ${{here:"Pass `path`.",none:"Pass `content`."}[t]} Then ${Qa?"list memory.":""} Done.'
    );
  });
});
