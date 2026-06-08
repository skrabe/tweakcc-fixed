import { describe, it, expect, afterEach } from 'vitest';
import {
  loadIdentifierMapUnion,
  clearIdentifierMapUnionCache,
} from './systemPromptSync';

describe('systemPromptSync.ts', () => {
  describe('loadIdentifierMapUnion', () => {
    afterEach(() => {
      clearIdentifierMapUnionCache();
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
  });
});
