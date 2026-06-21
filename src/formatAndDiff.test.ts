import { describe, it, expect, vi, beforeEach } from 'vitest';

// formatAndDiff lazy-imports oxfmt and caches the result module-side, so each
// scenario needs a fresh module graph (resetModules) + a per-test doMock.
describe('formatAndDiff outcomes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('reports oxfmt-unavailable when the formatter cannot be loaded', async () => {
    vi.doMock('oxfmt', () => {
      throw new Error('not installed');
    });
    const { formatAndDiff } = await import('./formatAndDiff');
    const r = await formatAndDiff('a', 'b');
    expect('reason' in r && r.reason).toBe('oxfmt-unavailable');
  });

  it('flags a format-error and which side failed (corruption signal)', async () => {
    // Only the modified side fails to parse — the corruption signal.
    vi.doMock('oxfmt', () => ({
      format: async (fileName: string, src: string) => ({
        code: src,
        errors: fileName === 'modified.js' ? [{ message: 'parse fail' }] : [],
      }),
    }));
    const { formatAndDiff } = await import('./formatAndDiff');
    const r = await formatAndDiff('good', 'bad');
    expect('reason' in r).toBe(true);
    if ('reason' in r) {
      expect(r.reason).toBe('format-error');
      expect(r.modifiedFailed).toBe(true);
      expect(r.originalFailed).toBe(false);
    }
  });

  it('returns a diff result when both sides format cleanly', async () => {
    vi.doMock('oxfmt', () => ({
      format: async (_fileName: string, src: string) => ({
        code: src,
        errors: [],
      }),
    }));
    const { formatAndDiff } = await import('./formatAndDiff');
    const r = await formatAndDiff('line1\nline2\n', 'line1\nCHANGED\n');
    expect('reason' in r).toBe(false);
    if (!('reason' in r)) {
      expect(r.changeCount).toBeGreaterThan(0);
    }
  });
});
