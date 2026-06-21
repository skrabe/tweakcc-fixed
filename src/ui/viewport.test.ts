import { describe, it, expect } from 'vitest';
import { getCenteredViewportSlice } from './viewport';

// Oracle = the exact inline formula the views used before extraction, so this
// proves the refactor is behaviour-identical.
const oracle = (sel: number, len: number, mv: number) => {
  const startIndex = Math.max(0, sel - Math.floor(mv / 2));
  const endIndex = Math.min(len, startIndex + mv);
  const adjustedStartIndex = Math.max(0, endIndex - mv);
  return { start: adjustedStartIndex, end: endIndex };
};

describe('getCenteredViewportSlice', () => {
  it('matches the original inline formula across the index range', () => {
    for (const mv of [8, 12]) {
      for (const len of [0, 1, 5, 8, 20, 50]) {
        for (let sel = 0; sel < Math.max(1, len); sel++) {
          expect(getCenteredViewportSlice(sel, len, mv)).toEqual(
            oracle(sel, len, mv)
          );
        }
      }
    }
  });

  it('returns an empty window for an empty list', () => {
    expect(getCenteredViewportSlice(0, 0, 8)).toEqual({ start: 0, end: 0 });
  });

  it('shows the whole list when it is shorter than the window', () => {
    expect(getCenteredViewportSlice(2, 5, 8)).toEqual({ start: 0, end: 5 });
  });

  it('pins to the top near the start', () => {
    expect(getCenteredViewportSlice(0, 20, 8)).toEqual({ start: 0, end: 8 });
  });

  it('keeps the selected row inside a full-width window in the middle', () => {
    const { start, end } = getCenteredViewportSlice(10, 20, 8);
    expect(end - start).toBe(8);
    expect(10).toBeGreaterThanOrEqual(start);
    expect(10).toBeLessThan(end);
  });

  it('pins to the bottom near the end (window never overruns)', () => {
    const { start, end } = getCenteredViewportSlice(19, 20, 8);
    expect(end).toBe(20);
    expect(end - start).toBe(8);
    expect(19).toBeLessThan(end);
  });
});
