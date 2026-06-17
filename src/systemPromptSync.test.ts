import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  loadIdentifierMapUnion,
  clearIdentifierMapUnionCache,
} from './systemPromptSync';
import * as systemPromptDownload from './systemPromptDownload';

// Wrap findRepoPromptsDir in a controllable spy. The default implementation
// calls through to the real function so existing tests are unaffected.
// Per-test overrides (mockReturnValue(null)) simulate an npm-installed run.
vi.mock('./systemPromptDownload', async () => {
  const actual = await vi.importActual<typeof systemPromptDownload>(
    './systemPromptDownload'
  );
  return {
    ...actual,
    findRepoPromptsDir: vi.fn(() => actual.findRepoPromptsDir()),
  };
});

describe('systemPromptSync.ts', () => {
  describe('loadIdentifierMapUnion', () => {
    afterEach(async () => {
      clearIdentifierMapUnionCache();
      // Restore call-through default so tests don't bleed state into each other.
      const actual = await vi.importActual<typeof systemPromptDownload>(
        './systemPromptDownload'
      );
      vi.mocked(systemPromptDownload.findRepoPromptsDir).mockImplementation(
        () => actual.findRepoPromptsDir()
      );
    });

    it('unions identifierMap values across the bundled data/prompts/*.json', async () => {
      const union = await loadIdentifierMapUnion();

      // Reads the repo-local bundled prompt data in a checkout.
      expect(union.size).toBeGreaterThan(0);
      // A human-name present in ~all 2.1.x prompt files.
      expect(union.has('GLOB_TOOL_NAME')).toBe(true);
      // Real minified vars are never human-names, so never in the union.
      expect(union.has('HL7')).toBe(false);
    });

    it('caches the union and rebuilds it after the cache is cleared', async () => {
      const first = await loadIdentifierMapUnion();
      const second = await loadIdentifierMapUnion();
      expect(second).toBe(first); // same instance while cached

      clearIdentifierMapUnionCache();
      const third = await loadIdentifierMapUnion();
      expect(third).not.toBe(first); // fresh instance after clear
      expect(third).toEqual(first); // same contents
    });

    it('falls back to baked IDENTIFIER_UNION when findRepoPromptsDir returns null (npm-install case)', async () => {
      // Simulate npm-installed run: no repo dir on disk
      vi.mocked(systemPromptDownload.findRepoPromptsDir).mockReturnValue(null);

      const union = await loadIdentifierMapUnion();

      // The baked union must be non-empty
      expect(union.size).toBeGreaterThan(0);
      // ANGLE_REUSE was present up to 2.1.177 and removed in 2.1.178 —
      // a cross-version-removed name that would brick CC boot if a stale
      // override slips through without the guard.
      expect(union.has('ANGLE_REUSE')).toBe(true);
    });
  });
});
