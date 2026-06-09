import { describe, it, expect } from 'vitest';
import {
  reconstructContentFromPieces,
  buildRegexFromPieces,
  extractUserCustomizations,
  buildHumanToRealMapping,
  extractOriginalWhitespace,
  applyOriginalWhitespace,
} from './systemPromptSync';

// These exported helpers carry the extract → map → apply pipeline that turns a
// user's edited prompt back into minified-variable form. They had no direct
// coverage; a silent regression here corrupts every customized prompt on a bump.
describe('systemPromptCustomization helpers', () => {
  // A prompt whose pieces interleave with two placeholders.
  const pieces = ['Use ', ' then ', ' to finish'];
  const identifiers = [0, 1];
  const identifierMap = { '0': 'GLOB_TOOL_NAME', '1': 'READ_TOOL_NAME' };

  describe('buildRegexFromPieces', () => {
    it('captures the user text that sits between literal pieces', () => {
      const re = buildRegexFromPieces(pieces);
      const m = 'Use Glob then Read to finish'.match(re);
      expect(m?.slice(1)).toEqual(['Glob', 'Read']);
    });

    it('escapes regex metacharacters in pieces so they match literally', () => {
      // Pieces that look like regex (and like ${...} interpolation) must be
      // treated as literal text, not as pattern syntax.
      const literalPieces = ['cost is $5.00 (USD) ', ' [end]'];
      const re = buildRegexFromPieces(literalPieces);
      const m = 'cost is $5.00 (USD) HERE [end]'.match(re);
      expect(m?.slice(1)).toEqual(['HERE']);
      // A string that differs only in the "literal" metachars must not match.
      expect('cost is $5x00 XUSDX HERE Xend]'.match(re)).toBeNull();
    });

    it('treats ${VAR}-looking text in a piece as a literal, not a capture', () => {
      const re = buildRegexFromPieces(['prefix ${NOT_A_VAR} ', '!']);
      const m = 'prefix ${NOT_A_VAR} kept!'.match(re);
      expect(m?.slice(1)).toEqual(['kept']);
    });
  });

  describe('extract → map round-trip', () => {
    it('extractUserCustomizations + buildHumanToRealMapping recover the edits', () => {
      const userContent = 'Use myGlob then myRead to finish';
      const customizations = extractUserCustomizations(userContent, pieces);
      expect(customizations).toEqual(['myGlob', 'myRead']);

      const mapping = buildHumanToRealMapping(
        identifiers,
        identifierMap,
        customizations
      );
      expect(mapping).toEqual({
        GLOB_TOOL_NAME: 'myGlob',
        READ_TOOL_NAME: 'myRead',
      });
    });

    it('extractUserCustomizations throws when the content does not match', () => {
      expect(() =>
        extractUserCustomizations('totally different text', pieces)
      ).toThrow(/does not match expected structure/);
    });
  });

  describe('buildHumanToRealMapping', () => {
    it('collapses a repeated human name when the value agrees', () => {
      const mapping = buildHumanToRealMapping([0, 0], { '0': 'TOOL' }, [
        'same',
        'same',
      ]);
      expect(mapping).toEqual({ TOOL: 'same' });
    });

    it('throws on a repeated human name with conflicting values', () => {
      expect(() =>
        buildHumanToRealMapping([0, 0], { '0': 'TOOL' }, ['a', 'b'])
      ).toThrow(/Conflicting mappings for "TOOL"/);
    });

    it('skips identifiers absent from the identifierMap', () => {
      const mapping = buildHumanToRealMapping([0, 9], { '0': 'KNOWN' }, [
        'v0',
        'v9',
      ]);
      expect(mapping).toEqual({ KNOWN: 'v0' });
    });
  });

  describe('reconstructContentFromPieces', () => {
    it('interleaves human names between pieces', () => {
      expect(
        reconstructContentFromPieces(pieces, identifiers, identifierMap)
      ).toBe('Use GLOB_TOOL_NAME then READ_TOOL_NAME to finish');
    });

    it('falls back to UNKNOWN_<idx> for an unmapped identifier', () => {
      expect(reconstructContentFromPieces(['a ', ' b'], [7], {})).toBe(
        'a UNKNOWN_7 b'
      );
    });
  });

  describe('whitespace preservation', () => {
    it('extracts leading/trailing whitespace from the boundary pieces', () => {
      expect(extractOriginalWhitespace(['\n  start', 'end  \n'])).toEqual({
        leading: '\n  ',
        trailing: '  \n',
      });
    });

    it('returns empty whitespace for an empty pieces array', () => {
      expect(extractOriginalWhitespace([])).toEqual({
        leading: '',
        trailing: '',
      });
    });

    it('re-wraps trimmed user content with the original whitespace', () => {
      const ws = extractOriginalWhitespace(['\n  start', 'end\n']);
      expect(applyOriginalWhitespace('  edited body  ', ws)).toBe(
        '\n  edited body\n'
      );
    });

    it('collapses whitespace-only user content to the empty string', () => {
      expect(
        applyOriginalWhitespace('   \n  ', { leading: '\n', trailing: '\n' })
      ).toBe('');
    });
  });
});
