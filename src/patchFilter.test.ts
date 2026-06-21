import { describe, it, expect } from 'vitest';
import { resolvePatchFilter } from './patchFilter';

// 'verbose-property' and 'read-default-lines' are stable always-applied IDs.
describe('resolvePatchFilter', () => {
  it('returns null filter (apply all) when no --patches given', () => {
    expect(resolvePatchFilter(undefined)).toEqual({ ok: true, filter: null });
    expect(resolvePatchFilter(null)).toEqual({ ok: true, filter: null });
    expect(resolvePatchFilter('')).toEqual({ ok: true, filter: null });
  });

  it('accepts valid IDs and trims/drops blanks', () => {
    expect(resolvePatchFilter('verbose-property,read-default-lines')).toEqual({
      ok: true,
      filter: ['verbose-property', 'read-default-lines'],
    });
    expect(resolvePatchFilter(' verbose-property , ')).toEqual({
      ok: true,
      filter: ['verbose-property'],
    });
  });

  it('rejects an unknown ID (a typo would otherwise silently apply nothing)', () => {
    const r = resolvePatchFilter('verbose-property,nonexistent-xyz');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('nonexistent-xyz');
  });

  it('rejects a filter that contains no usable IDs', () => {
    const r = resolvePatchFilter(' , , ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('no patch IDs');
  });
});
