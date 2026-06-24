import { describe, it, expect, vi } from 'vitest';
import { writeWorktreeMode } from './worktreeMode';

// worktree-mode force-enables the EnterWorktree tool by bypassing the
// `tengu_worktree_mode` GrowthBook gate. Fixture mirrors the CC 2.1.42 shape
// `function ef6(){return r8("tengu_worktree_mode",!1)}` that the regex targets;
// the `$`-bearing names exercise the patch's `[$\w]+` identifier tolerance.
const FIXTURE =
  'a=1;function ef6(){return r8("tengu_worktree_mode",!1)}var z$x=2;';

describe('writeWorktreeMode', () => {
  it('injects `return !0;` at the top of the gate function to force-enable', () => {
    const out = writeWorktreeMode(FIXTURE);

    expect(out).not.toBeNull();
    // The bypass is spliced in right after the opening brace, before the
    // original GrowthBook lookup (which is preserved as dead code).
    expect(out).toContain(
      'function ef6(){return !0;return r8("tengu_worktree_mode",!1)}'
    );
    // Nothing outside the gate function is disturbed.
    expect(out).toContain('a=1;');
    expect(out).toContain('var z$x=2;');
  });

  it('tolerates minified `$`-bearing identifiers in the gate function', () => {
    const input = 'function $g6(){return $r("tengu_worktree_mode",!1)}';
    const out = writeWorktreeMode(input);
    expect(out).toBe(
      'function $g6(){return !0;return $r("tengu_worktree_mode",!1)}'
    );
  });

  it('treats a native worktree build (EnterWorktree present, no gate) as already satisfied', () => {
    // Modern CC ships worktree isolation natively without the old gate; the
    // patch should no-op (return the file unchanged) rather than fail.
    const native = 'class Q{name="EnterWorktree";call(){return 1}}';
    const out = writeWorktreeMode(native);
    expect(out).toBe(native);
  });

  it('returns null (logging) when neither the gate nor EnterWorktree is present', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeWorktreeMode('function unrelated(){return 1}')).toBeNull();
    errSpy.mockRestore();
  });
});
