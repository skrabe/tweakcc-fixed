import { describe, it, expect } from 'vitest';
import { buildSearchRegexFromPieces } from './systemPromptSync';

describe('systemPromptSync.ts', () => {
  describe('buildSearchRegexFromPieces — member-access keys', () => {
    // Pieces for system-prompt-code-review-inline-command: the 3rd interpolation
    // is a member access ${OBJ[f]}, stored as a literal "[f]}…" in piece index 3.
    const pieces = ['${', '}${', '}${', '[f]}${', '?', ':""}${', '?', ':""}'];

    it('generalizes a minified member-access key instead of pinning the Mac key', () => {
      const pattern = buildSearchRegexFromPieces(pieces, '2.1.179');
      expect(pattern).toContain('\\[[\\w$]+\\]');
      expect(pattern).not.toContain('\\[f\\]');
    });

    it('matches the member key under both Mac and Linux minification', () => {
      const re = new RegExp(buildSearchRegexFromPieces(pieces, '2.1.179'), 's');
      // Mac build keys the member [f]; Linux minifies the same key differently.
      expect(re.test('${a0}${b1}${c2[f]}${d3?e4:""}${f5?g6:""}')).toBe(true);
      expect(re.test('${a0}${b1}${c2[q]}${d3?e4:""}${f5?g6:""}')).toBe(true);
    });

    it('leaves a literal bracket in prompt text untouched', () => {
      // [note] is mid-piece prose, not a member access closing an interpolation.
      const prose = ['before [note] ${', '} after'];
      const pattern = buildSearchRegexFromPieces(prose, '2.1.179');
      expect(pattern).toContain('\\[note\\]');
      expect(pattern).not.toContain('\\[[\\w$]+\\]');
    });
  });
});
