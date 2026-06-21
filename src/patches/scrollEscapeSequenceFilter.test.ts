import { describe, it, expect } from 'vitest';
import { writeScrollEscapeSequenceFilter } from './scrollEscapeSequenceFilter';

// filter-scroll-escape-sequences is a prepend patch, not a regex-anchored one:
// it splices an stdout.write wrapper that strips SU/SD/DECSTBM escape sequences
// near the TOP of cli.js, after any shebang + version/(c) comment so those stay
// first. The fixture mirrors the real cli.js header shape (shebang line, a
// version banner comment, then minified code).
const HEADER_FIXTURE =
  '#!/usr/bin/env node\n// Version 2.1.183 (c) Anthropic\nvar A$=1,B$=2;process.stdout.write("hi");';

// A body with no skippable prefix (no shebang / banner / leading blanks): the
// injection index falls back to 0, so the filter prepends at the very start.
const BARE_FIXTURE = 'var A$=1,B$=2;process.stdout.write("hi");';

describe('writeScrollEscapeSequenceFilter', () => {
  it('injects the stdout.write scroll-filter wrapper with its marker comments', () => {
    const out = writeScrollEscapeSequenceFilter(HEADER_FIXTURE);

    expect(out).not.toBeNull();
    expect(out).toContain('// SCROLLING FIX PATCH START');
    expect(out).toContain('// SCROLLING FIX PATCH END');
    expect(out).toContain('const _origStdoutWrite=process.stdout.write;');
    expect(out).toContain('process.stdout.write=function(chunk,encoding,cb){');
  });

  it('filters SU/SD/DECSTBM scroll sequences but not cursor positioning', () => {
    const out = writeScrollEscapeSequenceFilter(HEADER_FIXTURE)!;

    // Scroll up (SU), scroll down (SD), set/reset scroll region (DECSTBM).
    expect(out).toContain(String.raw`.replace(/\x1b\[\d*S/g,'')`);
    expect(out).toContain(String.raw`.replace(/\x1b\[\d*T/g,'')`);
    expect(out).toContain(String.raw`.replace(/\x1b\[\d*;?\d*r/g,'')`);

    // It must NOT strip cursor position (CUP, ...H) or cursor up (CUU, ...A),
    // which ink relies on — no filter targeting those is emitted.
    expect(out).not.toContain(String.raw`\x1b\[\d*H/g`);
    expect(out).not.toContain(String.raw`\x1b\[\d*A/g`);
  });

  it('keeps the shebang + version banner first and injects the filter after them', () => {
    const out = writeScrollEscapeSequenceFilter(HEADER_FIXTURE)!;

    // Shebang stays the literal first bytes of the file.
    expect(out.startsWith('#!/usr/bin/env node\n')).toBe(true);
    // The version banner precedes the injected wrapper...
    const bannerIdx = out.indexOf('// Version 2.1.183 (c) Anthropic');
    const patchIdx = out.indexOf('// SCROLLING FIX PATCH START');
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    expect(patchIdx).toBeGreaterThan(bannerIdx);
    // ...and the original body survives the splice unchanged.
    expect(out).toContain('var A$=1,B$=2;process.stdout.write("hi");');
  });

  it('prepends at index 0 when there is no shebang/banner prefix', () => {
    const out = writeScrollEscapeSequenceFilter(BARE_FIXTURE)!;

    expect(out.startsWith('// SCROLLING FIX PATCH START')).toBe(true);
    expect(out.endsWith(BARE_FIXTURE)).toBe(true);
  });

  it('produces parseable JS (does not break the template literal)', () => {
    const out = writeScrollEscapeSequenceFilter(BARE_FIXTURE)!;
    expect(() => new Function(out)).not.toThrow();
  });

  it('always returns a string (this prepend patch has no no-match/null path)', () => {
    expect(typeof writeScrollEscapeSequenceFilter('')).toBe('string');
    expect(typeof writeScrollEscapeSequenceFilter('x=1;')).toBe('string');
  });
});
