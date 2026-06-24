import { describe, it, expect, vi } from 'vitest';
import { writeTableFormat } from './tableFormat';

// Fixture mirrors the minified table-rendering shapes the patch targets:
//   - border-definition object:  {top:["┌","─","┬","┐"],middle:[...],bottom:[...]}
//   - inter-row separator logic: if(R.push(...N(S,!1)),g<A.rows.length-1)R.push(T("middle"))
//   - top/bottom border pushes:  R.push(T("top")),...   ,R.push(T("bottom")),Math
//   - compact vertical renderer: function fr(A){...let q="│";...q+=" "+e+" │"...}
//   - horizontal separator:      "─".repeat(n)
// All five appear in the same string so a single writeTableFormat call exercises them.
const FIXTURE =
  'let[g,b,Q,F]={top:["┌","─","┬","┐"],middle:["├","─","┼","┤"],bottom:["└","─","┴","┘"]}[S];' +
  'R.push(T("top")),R.push(...N(A.header,!1)),R.push(T("middle"));' +
  'A.rows.forEach((S,g)=>{if(R.push(...N(S,!1)),g<A.rows.length-1)R.push(T("middle"))}),' +
  'R.push(T("bottom")),Math.max(0,1);' +
  'function fr(A){let z=0;let q="│";for(let e of A.cells)q+=" "+e+" │";return q}' +
  'let sep="─".repeat(width);';

describe('writeTableFormat', () => {
  it('returns null for the "default" format (no patching needed)', () => {
    expect(writeTableFormat(FIXTURE, 'default')).toBeNull();
  });

  describe('ascii format', () => {
    const out = writeTableFormat(FIXTURE, 'ascii')!;

    it('is applied (non-null)', () => {
      expect(out).not.toBeNull();
    });

    it('rewrites the border-definition object to markdown pipe/dash chars', () => {
      expect(out).toContain(
        '{top:["","","",""],middle:["|","-","|","|"],bottom:["","","",""]}'
      );
      // the original box-drawing border object is gone
      expect(out).not.toContain(
        '{top:["┌","─","┬","┐"],middle:["├","─","┼","┤"],bottom:["└","─","┴","┘"]}'
      );
    });

    it('rewrites the compact vertical separator " │" to " |"', () => {
      expect(out).toContain('q+=" "+e+" |"');
      expect(out).not.toContain('q+=" "+e+" │"');
    });

    it('rewrites the horizontal "─".repeat to "-".repeat', () => {
      expect(out).toContain('"-".repeat(width)');
      expect(out).not.toContain('"─".repeat(width)');
    });

    it('removes the inter-row separator push', () => {
      expect(out).toContain('A.rows.forEach((S,g)=>{R.push(...N(S,!1))})');
      expect(out).not.toContain('g<A.rows.length-1');
    });

    it('removes the top/bottom border pushes', () => {
      expect(out).not.toContain('R.push(T("top"))');
      expect(out).not.toContain('R.push(T("bottom"))');
    });
  });

  describe('clean format', () => {
    const out = writeTableFormat(FIXTURE, 'clean')!;

    it('keeps box-drawing middle chars but blanks top/bottom in the border object', () => {
      expect(out).toContain(
        '{top:["","","",""],middle:["├","─","┼","┤"],bottom:["","","",""]}'
      );
    });

    it('removes inter-row separators and top/bottom pushes', () => {
      expect(out).not.toContain('g<A.rows.length-1');
      expect(out).not.toContain('R.push(T("top"))');
      expect(out).not.toContain('R.push(T("bottom"))');
    });

    it('leaves the horizontal separator and vertical chars untouched (clean is box-drawing)', () => {
      expect(out).toContain('"─".repeat(width)');
      expect(out).toContain('q+=" "+e+" │"');
    });
  });

  describe('clean-top-bottom format', () => {
    const out = writeTableFormat(FIXTURE, 'clean-top-bottom')!;

    it('only removes inter-row separators, keeping borders and pushes', () => {
      expect(out).not.toContain('g<A.rows.length-1');
      // borders + top/bottom pushes are preserved
      expect(out).toContain(
        '{top:["┌","─","┬","┐"],middle:["├","─","┼","┤"],bottom:["└","─","┴","┘"]}'
      );
      expect(out).toContain('R.push(T("top"))');
      expect(out).toContain('R.push(T("bottom"))');
    });
  });

  it('treats "markdown" as an alias for "ascii"', () => {
    const md = writeTableFormat(FIXTURE, 'markdown' as never)!;
    const ascii = writeTableFormat(FIXTURE, 'ascii')!;
    expect(md).toBe(ascii);
  });

  it('returns null when no table-rendering patterns are present', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeTableFormat('var x=1;function y(){return 2}', 'ascii')
    ).toBeNull();
    errSpy.mockRestore();
  });

  it('returns null for an unknown format', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeTableFormat(FIXTURE, 'nonsense' as never)).toBeNull();
    errSpy.mockRestore();
  });
});
