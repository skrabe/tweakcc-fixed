import { describe, it, expect, vi, afterEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const extractor = require('../../tools/promptExtractor.js');
const {
  mergeWithExisting,
  applyCacheNames,
  _setClassificationCacheForTests,
  cacheLookupForms,
  sha1Hex,
} = extractor;

// Fuzzy carryover keys on a prompt's normalized first 100 chars. When a
// fingerprint is shared, the index must distinguish two very different cases:
//
//   • SAME id at several sites  -> NOT ambiguous. Each JSON entry is one binary
//     splice site of one prompt, so every candidate carries identical identity.
//     Carrying it over is safe, and dropping it loses the name the moment
//     Anthropic edits the body — exactly what fuzzy carryover exists to survive.
//     Measured on the real 2.1.210 catalogue: 76 fingerprints were being thrown
//     away for this reason alone.
//
//   • DIFFERENT ids sharing an opening -> genuinely ambiguous. Carrying either
//     would be a coin flip, and a WRONG name is worse than no name (it silently
//     rebinds an override). Drop it, and say so — the prompt then extracts
//     anonymous and gets named accurately by the classification cache, but it
//     also reads as "removed" in the version-bump report, so the log line is
//     what stops a deliberate drop being triaged as a real removal.
//     (Real 2.1.211 case: system-prompt-subagent-{prompt-writing,delegation}-examples
//     share an opening; dropping was correct and the cache named the split
//     accurately.)

const mk = (
  id: string,
  content: string,
  version = '2.1.210',
  identifiers: number[] = []
) => ({
  id,
  name: id,
  description: `${id} desc`,
  pieces: [content],
  identifiers,
  identifierMap: {},
  version,
});

const OPEN =
  'Example usage: <example> user: "What is left on this branch before we can ship?" assistant: thinking about it now';

afterEach(() => {
  _setClassificationCacheForTests(null);
  vi.restoreAllMocks();
});

describe('fuzzy-carryover collision policy', () => {
  it('carries the name when one id occupies several sites (same-id multi-site)', () => {
    const old = {
      prompts: [
        mk('multi-site-prompt', OPEN + ' AAA'),
        mk('multi-site-prompt', OPEN + ' AAA'),
      ],
    };
    // Anthropic edited the body; opening unchanged -> only fuzzy can save it.
    const next = {
      prompts: [
        {
          ...mk('', OPEN + ' AAA plus a newly added tail'),
          id: undefined,
          name: '',
        },
      ],
    };
    const merged = mergeWithExisting(next, old, '2.1.211');
    expect(merged.prompts[0].id).toBe('multi-site-prompt');
    expect(merged.prompts[0].version).toBe('2.1.211');
  });

  it('drops the name when two DIFFERENT ids share the opening (real ambiguity)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const old = {
      prompts: [
        mk('prompt-alpha', OPEN + ' AAA'),
        mk('prompt-beta', OPEN + ' BBB'),
      ],
    };
    const next = {
      prompts: [
        {
          ...mk('', OPEN + ' AAA with an edited tail'),
          id: undefined,
          name: '',
        },
      ],
    };
    const merged = mergeWithExisting(next, old, '2.1.211');
    // No name is carried — a coin-flip name would silently rebind an override.
    expect(merged.prompts[0].id).toBeFalsy();
    // ...and the drop is announced, so it isn't triaged as a removal.
    expect(
      log.mock.calls.some(c => String(c[0]).includes('ambiguous fingerprint'))
    ).toBe(true);
  });

  it('names both ids in the ambiguity log so the cause is greppable', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const old = {
      prompts: [
        mk('prompt-alpha', OPEN + ' AAA'),
        mk('prompt-beta', OPEN + ' BBB'),
      ],
    };
    mergeWithExisting({ prompts: [] }, old, '2.1.211');
    const line = log.mock.calls
      .map(c => String(c[0]))
      .find(s => s.includes('ambiguous fingerprint'));
    expect(line).toContain('prompt-alpha');
    expect(line).toContain('prompt-beta');
  });

  it('does not log an ambiguity for a same-id multi-site fingerprint', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const old = {
      prompts: [
        mk('multi-site-prompt', OPEN + ' AAA'),
        mk('multi-site-prompt', OPEN + ' AAA'),
      ],
    };
    mergeWithExisting({ prompts: [] }, old, '2.1.211');
    expect(
      log.mock.calls.some(c => String(c[0]).includes('ambiguous fingerprint'))
    ).toBe(false);
  });

  it('still prefers an exact content+identifier match over fuzzy', () => {
    const old = { prompts: [mk('exact-prompt', OPEN + ' AAA', '2.1.200')] };
    const next = {
      prompts: [{ ...mk('', OPEN + ' AAA'), id: undefined, name: '' }],
    };
    const merged = mergeWithExisting(next, old, '2.1.211');
    expect(merged.prompts[0].id).toBe('exact-prompt');
    // exact match keeps the OLD version (content did not change)
    expect(merged.prompts[0].version).toBe('2.1.200');
  });

  describe('a new body sharing an established opening', () => {
    const LEAD =
      'Refused: the fixture upload source is a hard link whose other names this session has not examined';
    const OLD_BODY = LEAD + ', so nothing was uploaded.';
    const NEW_BODY = LEAD + ', so the database write was not made.';
    const anon = (content: string) => ({
      ...mk('', content),
      id: undefined,
      name: '',
    });
    const verdict = (body: string, id: string) => {
      const cache: Record<string, object> = {};
      for (const form of cacheLookupForms(body)) {
        cache[sha1Hex(form)] = { facing: 'model', id, name: id, desc: id };
      }
      return cache;
    };

    it('leaves the id with its previous body when that body is still present', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      _setClassificationCacheForTests({});
      const old = {
        prompts: [mk('tool-result-fixture-upload-hard-link', OLD_BODY)],
      };
      const merged = mergeWithExisting(
        { prompts: [anon(NEW_BODY), anon(OLD_BODY)] },
        old,
        '2.1.294'
      );
      expect(merged.prompts[1].id).toBe('tool-result-fixture-upload-hard-link');
      expect(merged.prompts[1].version).toBe('2.1.210');
      expect(merged.prompts[0].id).toBeFalsy();
    });

    it('gives a body its classifier id instead of a sibling id', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      _setClassificationCacheForTests(
        verdict(NEW_BODY, 'tool-result-fixture-db-write-hard-link')
      );
      const old = {
        prompts: [mk('tool-result-fixture-upload-hard-link', OLD_BODY)],
      };
      const merged = mergeWithExisting(
        { prompts: [anon(NEW_BODY)] },
        old,
        '2.1.294'
      );
      const named = applyCacheNames(merged.prompts);
      expect(named[0].id).toBe('tool-result-fixture-db-write-hard-link');
    });

    it('still carries the id onto an edited body the cache does not name', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      _setClassificationCacheForTests({});
      const old = {
        prompts: [mk('tool-result-fixture-upload-hard-link', OLD_BODY)],
      };
      const merged = mergeWithExisting(
        { prompts: [anon(NEW_BODY)] },
        old,
        '2.1.294'
      );
      expect(merged.prompts[0].id).toBe('tool-result-fixture-upload-hard-link');
      expect(merged.prompts[0].version).toBe('2.1.294');
    });
  });
});
