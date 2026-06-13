import { describe, it, expect } from 'vitest';
import { normalizeIdGroups } from '../../tools/promptExtractor.js';

type Entry = {
  id: string;
  pieces: string[];
  identifiers: (number | string)[];
  identifierMap: Record<string, string>;
  version?: string;
  start: number;
  end: number;
};

const entry = (over: Partial<Entry>): Entry => ({
  id: 'p',
  pieces: ['content'],
  identifiers: [],
  identifierMap: {},
  version: '2.1.169',
  start: 0,
  end: 100,
  ...over,
});

// The extractor emits one entry per code-site, and identical prompts at
// disjoint ranges are each patched at --apply — so disjoint same-id twins
// must survive. Only two same-id shapes are bugs: a nested range (the
// re-extracted ${"…"} interior of the same template site) and mixed version
// stamps (which make the .md sync restamp ccVersion to a stale value).
describe('normalizeIdGroups', () => {
  it('drops a same-id entry nested inside another entry of the group', () => {
    const outer = entry({ start: 100, end: 800, identifiers: [0, 1, 2] });
    const inner = entry({ start: 114, end: 794 });
    const standalone = entry({ start: 900, end: 1500 });
    const result = normalizeIdGroups([outer, inner, standalone]);
    expect(result).toHaveLength(2);
    expect(result).toContain(outer);
    expect(result).toContain(standalone);
  });

  it('keeps a nested entry when the ids differ', () => {
    const outer = entry({ id: 'parent', start: 100, end: 800 });
    const inner = entry({ id: 'child', start: 114, end: 794 });
    expect(normalizeIdGroups([outer, inner])).toHaveLength(2);
  });

  it('keeps byte-identical same-id entries at disjoint ranges', () => {
    const a = entry({ start: 0, end: 600 });
    const b = entry({ start: 700, end: 1300 });
    expect(normalizeIdGroups([a, b])).toHaveLength(2);
  });

  it('stamps every entry of an id-group with the group max version', () => {
    const fresh = entry({ start: 0, end: 600, version: '2.1.169' });
    const stale1 = entry({ start: 700, end: 1300, version: '2.1.167' });
    const stale2 = entry({ start: 1400, end: 2000, version: '2.1.167' });
    const result = normalizeIdGroups([fresh, stale1, stale2]);
    expect(result.map((p: Entry) => p.version)).toEqual([
      '2.1.169',
      '2.1.169',
      '2.1.169',
    ]);
  });

  it('compares versions numerically per segment, not lexicographically', () => {
    const a = entry({ start: 0, end: 600, version: '2.1.99' });
    const b = entry({ start: 700, end: 1300, version: '2.1.100' });
    const result = normalizeIdGroups([a, b]);
    expect(result.map((p: Entry) => p.version)).toEqual(['2.1.100', '2.1.100']);
  });

  it('does not drop the nested entry version from the max computation', () => {
    // A dropped nested entry must not pull the group version up or down.
    const outer = entry({ start: 100, end: 800, version: '2.1.169' });
    const inner = entry({ start: 114, end: 794, version: '2.1.167' });
    const result = normalizeIdGroups([outer, inner]);
    expect(result).toEqual([outer]);
    expect(outer.version).toBe('2.1.169');
  });

  it('leaves unnamed entries untouched', () => {
    const a = entry({ id: '', start: 0, end: 600 });
    const b = entry({ id: '', start: 14, end: 594 });
    expect(normalizeIdGroups([a, b])).toHaveLength(2);
  });
});
