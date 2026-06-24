import { describe, it, expect, vi } from 'vitest';
import { writeInputBoxBorder } from './inputBorderBox';

// input-border-box is opt-in (removeBorder). It strips the PromptInput box
// border across three independent sites. This fixture mirrors all three of the
// minified shapes the patch's regexes target:
//
//  1. swarmBanner branch — top/bottom `"─".repeat(N)` lines colored `.bgColor`.
//     The top line is the `VAR.text?<Fragment>:"─".repeat(N)` ternary; the
//     bottom is the bare `"─".repeat(N)`. Both use the same Text component
//     (`Z1`), the same theme var (`T`) and width var (`W`).
//  2. main input Box — `borderColor:YB(),borderStyle:"round",...,borderText:`.
//  3. external editor Box — `borderStyle:"round",...}` near "Save and close editor".
const TOP_BORDER =
  'createElement(Z1,{color:T.bgColor},T.text?createElement(Fr,null,"─",T.text,"──"):"─".repeat(W))';
const BOTTOM_BORDER = 'createElement(Z1,{color:T.bgColor},"─".repeat(W))';
const MAIN_INPUT =
  'createElement(Bx,{borderColor:YB(),borderStyle:"round",borderLeft:!1,borderRight:!1,borderBottom:!0,width:"100%",borderText:QV(M)},rest)';
const EXTERNAL_EDITOR =
  'createElement(Bx,{borderStyle:"round",borderLeft:!1,borderRight:!1,borderBottom:!0,width:"100%"},createElement(Z1,null,"Save and close editor"))';

const FIXTURE = `a=1;K?${TOP_BORDER}:${MAIN_INPUT};b=2;${BOTTOM_BORDER};c=3;${EXTERNAL_EDITOR};d=4;`;

describe('writeInputBoxBorder', () => {
  it('returns the file unchanged when removeBorder is false (opt-in)', () => {
    const out = writeInputBoxBorder(FIXTURE, false);
    expect(out).toBe(FIXTURE);
  });

  it('blanks the swarmBanner top and bottom ─.repeat border lines', () => {
    const out = writeInputBoxBorder(FIXTURE, true);
    expect(out).not.toBeNull();
    // Both ─.repeat lines collapse to an empty Text using the same component.
    expect(out).toContain('createElement(Z1,null,"")');
    expect(out).not.toContain(BOTTOM_BORDER);
    expect(out).not.toContain(TOP_BORDER);
    expect(out).not.toContain('"─".repeat');
  });

  it('disables the main input Box round border (keeps borderColor/borderText)', () => {
    const out = writeInputBoxBorder(FIXTURE, true)!;
    expect(out).toContain(
      'borderColor:YB(),borderStyle:undefined,borderLeft:!1,borderRight:!1,borderBottom:!0,width:"100%",borderText:'
    );
    // The surrounding props are preserved verbatim.
    expect(out).toContain('borderColor:YB(),');
  });

  it('disables the external editor Box round border', () => {
    const out = writeInputBoxBorder(FIXTURE, true)!;
    expect(out).toContain(
      'borderStyle:undefined,borderLeft:!1,borderRight:!1,borderBottom:!0,width:"100%"}'
    );
    expect(out).toContain('Save and close editor');
  });

  it('removes every borderStyle:"round" once all three sites are patched', () => {
    const out = writeInputBoxBorder(FIXTURE, true)!;
    expect(out).not.toContain('borderStyle:"round"');
  });

  it('still patches when only the main input Box site is present', () => {
    const onlyMain = `x=1;${MAIN_INPUT};y=2;`;
    const out = writeInputBoxBorder(onlyMain, true);
    expect(out).not.toBeNull();
    expect(out).toContain('borderStyle:undefined,borderLeft:!1');
    expect(out).not.toContain('borderStyle:"round"');
  });

  it('returns null (logging) when no border pattern is present', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeInputBoxBorder('function unrelated(){return 1}', true)
    ).toBeNull();
    errSpy.mockRestore();
  });
});
