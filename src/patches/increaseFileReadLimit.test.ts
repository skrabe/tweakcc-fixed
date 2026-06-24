import { describe, it, expect, vi } from 'vitest';
import { writeIncreaseFileReadLimit } from './increaseFileReadLimit';

// increaseFileReadLimit bumps the per-read 25000-token cap to 1000000.
// It locates "=25000," only when a known anchor sits nearby, so we can't be
// fooled by an unrelated 25000 elsewhere in the bundle.

// Path 1 (CC >=2.1.83 config region): CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS
// appears, then within 1200 chars the "=25000," default, then tengu_amber_wren.
const FIXTURE_CONFIG_REGION =
  'var x=process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;let $a=25000,b=1;I("tengu_amber_wren",{});tail=2;';

// Path 2a (CC <2.1.83): "=25000," directly followed (within 700 chars) by the
// "<system-reminder>" anchor.
const FIXTURE_SYSTEM_REMINDER =
  'let Qz=25000,more=0;Z9=`<system-reminder>The file is large</system-reminder>`;rest';

// Path 2b: "=25000," followed by the tengu_amber_wren anchor (no config region).
const FIXTURE_TENGU_ANCHOR =
  'const $k9=25000,pad=1;EV("tengu_amber_wren",{count:1});rest';

describe('writeIncreaseFileReadLimit', () => {
  it('raises 25000 to 1000000 in the config-region shape (>=2.1.83)', () => {
    const out = writeIncreaseFileReadLimit(FIXTURE_CONFIG_REGION);
    expect(out).not.toBeNull();
    // Only the anchored value is rewritten; the "=" is preserved.
    expect(out).toContain('$a=1000000,b=1');
    expect(out).not.toContain('=25000,');
    // Anchors and surrounding code are untouched.
    expect(out).toContain('CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS');
    expect(out).toContain('tengu_amber_wren');
  });

  it('raises 25000 via the <system-reminder> anchor (CC <2.1.83)', () => {
    const out = writeIncreaseFileReadLimit(FIXTURE_SYSTEM_REMINDER);
    expect(out).not.toBeNull();
    expect(out).toContain('Qz=1000000,more=0');
    expect(out).not.toContain('=25000,');
    expect(out).toContain('<system-reminder>');
  });

  it('raises 25000 via the tengu_amber_wren anchor (no config region)', () => {
    const out = writeIncreaseFileReadLimit(FIXTURE_TENGU_ANCHOR);
    expect(out).not.toBeNull();
    expect(out).toContain('$k9=1000000,pad=1');
    expect(out).not.toContain('=25000,');
  });

  it('only rewrites the 5-char value, leaving the rest of the slice intact', () => {
    const out = writeIncreaseFileReadLimit(FIXTURE_TENGU_ANCHOR)!;
    // exact splice: prefix + 1000000 + suffix, nothing else moved
    expect(out).toBe(
      'const $k9=1000000,pad=1;EV("tengu_amber_wren",{count:1});rest'
    );
  });

  it('returns null (logging) when 25000 has no nearby anchor', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 25000 present but no anchor within range -> no match.
    expect(
      writeIncreaseFileReadLimit('let z=25000,b=1;somethingUnrelated()')
    ).toBeNull();
    errSpy.mockRestore();
  });

  it('returns null when neither 25000 nor an anchor is present', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeIncreaseFileReadLimit('function unrelated(){return 1}')
    ).toBeNull();
    errSpy.mockRestore();
  });
});
