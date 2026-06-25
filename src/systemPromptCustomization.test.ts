import { describe, it, expect } from 'vitest';
import {
  reconstructContentFromPieces,
  extractOriginalWhitespace,
  applyOriginalWhitespace,
} from './systemPromptSync';

// Coverage for the live prompt-reconstruction helpers: reconstructContentFromPieces
// (interleaving human names between pieces) and the whitespace extract/apply pair.
describe('systemPromptCustomization helpers', () => {
  // A prompt whose pieces interleave with two placeholders.
  const pieces = ['Use ', ' then ', ' to finish'];
  const identifiers = [0, 1];
  const identifierMap = { '0': 'GLOB_TOOL_NAME', '1': 'READ_TOOL_NAME' };

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
