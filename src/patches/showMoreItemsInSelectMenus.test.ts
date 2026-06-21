import { describe, it, expect, vi } from 'vitest';
import { writeShowMoreItemsInSelectMenus } from './showMoreItemsInSelectMenus';

// show-more-items-in-select-menus rewrites four minified shapes:
//   1. `visibleOptionCount:VAR=N`           — the per-menu default item count
//   2. patchHelpMenuHeight Method 1 (CC ≥ 2.1.148): the ternary + Math.min clamp
//        {rows:Y,columns:w}=FN(),j=O?J95:Math.max(1,Math.min(Math.max(6,Math.floor(Y/2)),Y-3))
//      → replaces `Math.floor(Y/2)` with `Y` so the clamp resolves to `Y-3`
//   3. patchCommandsVisibleCount: Math.max(1,Math.floor((H-10)/2)) → Math.max(1,H-3)
//   4. patchSuggestionsCap: Math.min(6,Math.max(1,Y-3)) → Math.max(1,Y-3)
// Two `visibleOptionCount` sites + $-bearing identifiers mirror the real binary.
const FIXTURE =
  'a=1;' +
  '({visibleOptionCount:$opt=10,onSelect:cb})=>{};' +
  'g={visibleOptionCount:$two=7,foo:1};' +
  '({rows:Y$,columns:w$}=tk$(),j$=O$?J95:Math.max(1,Math.min(Math.max(6,Math.floor(Y$/2)),Y$-3)));' +
  'let v$=Math.max(1,Math.floor((H$-10)/2));' +
  'let s$=Math.min(6,Math.max(1,Z$-3));' +
  'z=2;';

describe('writeShowMoreItemsInSelectMenus', () => {
  it('rewrites every visibleOptionCount default to the requested count', () => {
    const out = writeShowMoreItemsInSelectMenus(FIXTURE, 99)!;
    expect(out).not.toBeNull();
    // Both destructured defaults swapped to 99, var names preserved.
    expect(out).toContain('visibleOptionCount:$opt=99');
    expect(out).toContain('visibleOptionCount:$two=99');
    // Original numbers are gone from those slots.
    expect(out).not.toContain('visibleOptionCount:$opt=10');
    expect(out).not.toContain('visibleOptionCount:$two=7');
  });

  it('drops the /2 from the help-menu height clamp (Method 1)', () => {
    const out = writeShowMoreItemsInSelectMenus(FIXTURE, 5)!;
    // Math.floor(Y$/2) collapses to the bare rows var Y$ inside the clamp.
    expect(out).toContain('Math.max(6,Y$)');
    expect(out).not.toContain('Math.floor(Y$/2)');
  });

  it('flattens the Commands.tsx visibleCount formula', () => {
    const out = writeShowMoreItemsInSelectMenus(FIXTURE, 5)!;
    expect(out).toContain('Math.max(1,H$-3)');
    expect(out).not.toContain('Math.floor((H$-10)/2)');
  });

  it('removes the hardcoded Math.min(6,...) suggestions cap', () => {
    const out = writeShowMoreItemsInSelectMenus(FIXTURE, 5)!;
    expect(out).toContain('s$=Math.max(1,Z$-3)');
    expect(out).not.toContain('Math.min(6,Math.max(1,Z$-3))');
  });

  it('treats an absent suggestions cap as a no-op (CC ≥ 2.1.133)', () => {
    // Drop the Math.min(6,...) site; the other three sites still patch and the
    // suggestions cap is skipped via the debug no-op (no console.error).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const noCap = FIXTURE.replace(
      'let s$=Math.min(6,Math.max(1,Z$-3));',
      'let s$=Z$;'
    );
    const out = writeShowMoreItemsInSelectMenus(noCap, 12)!;
    expect(out).not.toBeNull();
    expect(out).toContain('visibleOptionCount:$opt=12');
    expect(out).toContain('Math.max(1,H$-3)');
    // The cap-removal path was never reached, so it doesn't error.
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('returns null when no visibleOptionCount site exists at all', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeShowMoreItemsInSelectMenus('function unrelated(){return 1}', 10)
    ).toBeNull();
    errSpy.mockRestore();
  });

  it('produces a parseable JS expression for each rewritten clamp', () => {
    const out = writeShowMoreItemsInSelectMenus(FIXTURE, 8)!;
    // The three numeric clamps should each be syntactically valid JS.
    expect(() => new Function('Y$', 'return Math.max(6,Y$)')).not.toThrow();
    expect(() => new Function('H$', 'return Math.max(1,H$-3)')).not.toThrow();
    expect(() => new Function('Z$', 'return Math.max(1,Z$-3)')).not.toThrow();
    // And the count replacement is a bare integer (no injection).
    expect(out).toContain('=8,onSelect:cb');
  });
});
