import { describe, it, expect, vi } from 'vitest';
import { writeHideCtrlGToEdit } from './hideCtrlGToEdit';

// hideCtrlGToEdit neutralizes the "Ctrl+G to edit" hint by rewriting the guard
// condition of the if() that fires the tengu_external_editor_hint_shown event.
// Fixture mirrors the minified shape the regex targets:
//   if(X&&Y)Z("tengu_external_editor_hint_shown", ...)
// using realistic short minified identifiers (incl. a '$'-containing name).
const FIXTURE =
  'b=2;if(v&&$P)q1("tengu_external_editor_hint_shown",{source:"prompt"});c=3;';

describe('writeHideCtrlGToEdit', () => {
  it('replaces the guard condition with false', () => {
    const out = writeHideCtrlGToEdit(FIXTURE);

    expect(out).not.toBeNull();
    // The captured condition v&&$P is rewritten to the literal false...
    expect(out).toContain('if(false)q1("tengu_external_editor_hint_shown",');
    // ...and the original condition no longer guards that call.
    expect(out).not.toContain('if(v&&$P)q1("tengu_external_editor_hint_shown"');
    // surrounding code is preserved verbatim.
    expect(out!.startsWith('b=2;if(false)')).toBe(true);
    expect(out!.endsWith('{source:"prompt"});c=3;')).toBe(true);
  });

  it('produces parseable JS (the if statement stays well-formed)', () => {
    const out = writeHideCtrlGToEdit(FIXTURE)!;
    // Strip the call to an undefined helper but keep the if-shape valid.
    expect(
      () => new Function('return 1;' + out.replace(/q1\([^)]*\)/, 'undefined'))
    ).not.toThrow();
  });

  it('returns null (logging) when the hint pattern is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeHideCtrlGToEdit('x=1;function y(){}')).toBeNull();
    errSpy.mockRestore();
  });

  it('returns null when the event name is present but not in the if-guard shape', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // No if(X&&Y) guard preceding the call → regex must not match.
    expect(
      writeHideCtrlGToEdit('q1("tengu_external_editor_hint_shown",{})')
    ).toBeNull();
    errSpy.mockRestore();
  });
});
