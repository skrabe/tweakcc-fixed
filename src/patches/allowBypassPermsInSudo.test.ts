import { describe, it, expect, vi } from 'vitest';
import { writeAllowBypassPermsInSudo } from './allowBypassPermsInSudo';

// CC guards `--dangerously-skip-permissions` against root/sudo by bailing with
// a console.error + process.exit(1). The patch neutralizes that guard by
// replacing the whole `console.error(...),process.exit(1)` expression with `{}`.
// FIXTURE mirrors the minified shape the regex anchors on, wrapped in a tiny
// surrounding statement so we can assert the splice preserves the rest.
const GUARD =
  'console.error("--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons"),process.exit(1)';
const FIXTURE = `if(B5&&!j$){${GUARD}}else{q()}`;

describe('writeAllowBypassPermsInSudo', () => {
  it('replaces the root/sudo guard expression with an empty block', () => {
    const out = writeAllowBypassPermsInSudo(FIXTURE);

    expect(out).not.toBeNull();
    // The full guard expression is gone...
    expect(out).not.toContain('process.exit(1)');
    expect(out).not.toContain(
      'cannot be used with root/sudo privileges for security reasons'
    );
    // ...replaced by the empty block, with surrounding code intact.
    expect(out).toBe('if(B5&&!j$){{}}else{q()}');
  });

  it('produces parseable JS after the splice', () => {
    const out = writeAllowBypassPermsInSudo(FIXTURE)!;
    expect(() => new Function(out)).not.toThrow();
  });

  it('returns the file unchanged (no-op) when the guard anchor is absent', () => {
    // No `root/sudo privileges` literal anywhere → feature shape not present;
    // the patch leaves the file untouched rather than failing.
    const input = 'var a=1;function unrelated(){return 1}';
    const out = writeAllowBypassPermsInSudo(input);
    expect(out).toBe(input);
  });

  it('returns null (logging) when the anchor literal is present but the exact pattern drifted', () => {
    // `root/sudo privileges` shows up, but the surrounding console.error/exit
    // shape no longer matches → genuine regex drift, surfaced as a failure.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const drifted =
      'if(x){throw new Error("--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons")}';
    expect(writeAllowBypassPermsInSudo(drifted)).toBeNull();
    errSpy.mockRestore();
  });
});
