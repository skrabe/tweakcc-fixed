import { describe, it, expect, vi } from 'vitest';
import { writeReadDefaultLines } from './readDefaultLines';

// Fixture mirrors the real 2.1.183 cli.js shape:
//   ...LQe=2000,Ghi="Read a file from the local filesystem.",VBr=...
// read-default-lines is ALWAYS_APPLIED, so a silent anchor drift has no other
// safety net.
const PRISTINE =
  'x=1,LQe=2000,Ghi="Read a file from the local filesystem.",VBr=2';
const PATCHED =
  'x=1,LQe=(+process.env.CLAUDE_CODE_READ_DEFAULT_LINES||2000),Ghi="Read a file from the local filesystem.",VBr=2';

describe('writeReadDefaultLines', () => {
  it('makes the Read default-line cap env-configurable while preserving the anchor', () => {
    const out = writeReadDefaultLines(PRISTINE);

    expect(out).not.toBeNull();
    expect(out).toContain(
      '=(+process.env.CLAUDE_CODE_READ_DEFAULT_LINES||2000),Ghi="Read a file from the local filesystem.'
    );
    // the bare `=2000,` literal must be gone
    expect(out).not.toContain('=2000,Ghi');
  });

  it('is idempotent — re-running on an already-patched file is a no-op', () => {
    expect(writeReadDefaultLines(PATCHED)).toBe(PATCHED);
  });

  it('returns null (without throwing) when the anchor is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeReadDefaultLines('const unrelated=2000;')).toBeNull();
    errSpy.mockRestore();
  });
});
