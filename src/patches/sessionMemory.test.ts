import { describe, it, expect, vi } from 'vitest';
import { writeSessionMemory } from './sessionMemory';

// sessionMemory force-enables CC's session-memory feature by bypassing four
// flag/threshold gates. This fixture mirrors a LEGACY CC build (~2.1.38 era)
// where all four sub-patches still have something to do:
//   1. extraction gate  -> function l28(){return $_("tengu_session_memory",!1)}
//   2. past-sessions gate (new positive-block shape) -> if(uL("tengu_coral_fern",!1)){...}
//   3. extract-mode helper -> function $z9(){if(!$Q("tengu_passport_quail",!1))return!1;return!$R()||$W("tengu_slate_thimble",!1)}
//   4. token limits   -> ...=2000,...=12000,...# Session Title...
//   5. update thresholds -> minimumMessageTokensToInit:1e4 / minimumTokensBetweenUpdate:5000 / toolCallsBetweenUpdates:3
const LEGACY_FIXTURE =
  'var a=1;' +
  'function l28(){return $_("tengu_session_memory",!1)}' +
  'function $z9(){if(!$Q("tengu_passport_quail",!1))return!1;return!$R()||$W("tengu_slate_thimble",!1)}' +
  'if(uL("tengu_coral_fern",!1)){let M=wX(YL());E.push("## Searching past context")}' +
  'var perSection=2000,total=12000,tpl="\\n# Session Title\\n_desc_";' +
  'var cfg={minimumMessageTokensToInit:1e4,minimumTokensBetweenUpdate:5000,toolCallsBetweenUpdates:3};' +
  'var z=2;';

describe('writeSessionMemory', () => {
  it('force-enables the extraction gate by inserting return true', () => {
    const out = writeSessionMemory(LEGACY_FIXTURE);
    expect(out).not.toBeNull();
    // `return true;` spliced immediately after the function's opening brace
    expect(out).toContain(
      'function l28(){return true;return $_("tengu_session_memory",!1)}'
    );
  });

  it('rewrites the past-sessions positive-block gate to if(true)', () => {
    const out = writeSessionMemory(LEGACY_FIXTURE)!;
    expect(out).toContain('if(true){let M=wX(YL())');
    // the original flag-checked conditional is gone
    expect(out).not.toContain('if(uL("tengu_coral_fern",!1)){');
  });

  it('collapses the extract-mode helper to an unconditional return!0', () => {
    const out = writeSessionMemory(LEGACY_FIXTURE)!;
    expect(out).toContain('function $z9(){return!0}');
    expect(out).not.toContain('tengu_passport_quail');
    expect(out).not.toContain('tengu_slate_thimble');
  });

  it('makes the per-section and total token limits env-configurable', () => {
    const out = writeSessionMemory(LEGACY_FIXTURE)!;
    expect(out).toContain(
      '=Number(process.env.CC_SM_PER_SECTION_TOKENS??2000)'
    );
    expect(out).toContain('=Number(process.env.CM_SM_TOTAL_FILE_LIMIT??12000)');
    // bare numeric constants for these slots are gone
    expect(out).not.toContain('perSection=2000');
    expect(out).not.toContain('total=12000');
  });

  it('makes the update thresholds env-configurable', () => {
    const out = writeSessionMemory(LEGACY_FIXTURE)!;
    expect(out).toContain(
      'minimumMessageTokensToInit:Number(process.env.CC_SM_MINIMUM_MESSAGE_TOKENS_TO_INIT??1e4)'
    );
    expect(out).toContain(
      'minimumTokensBetweenUpdate:Number(process.env.CC_SM_MINIMUM_TOKENS_BETWEEN_UPDATE??5000)'
    );
    expect(out).toContain(
      'toolCallsBetweenUpdates:Number(process.env.CC_SM_TOOL_CALLS_BETWEEN_UPDATES??3)'
    );
  });

  it('produces parseable JS (template/brace parity preserved)', () => {
    const out = writeSessionMemory(LEGACY_FIXTURE)!;
    // Wrap in a function body so the bare statements/decls are valid.
    expect(() => new Function(out)).not.toThrow();
  });

  it('treats a modern build (gates already promoted) as a clean no-op', () => {
    // CC >= ~2.1.152: none of the flag literals / anchors are present, but the
    // session-search UI event path exists, so every sub-patch no-ops and the
    // file is returned unchanged.
    const modern = 'var a=1;sendEvent("tengu_session_search_toggled");var b=2;';
    const out = writeSessionMemory(modern);
    expect(out).toBe(modern);
  });

  it('returns null when the extraction gate is present but its shape is unknown', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Flag literal exists (so it is NOT treated as a promoted no-op) but the
    // surrounding function shape and the anchor fallback are both absent.
    const broken = 'var x=lookup("tengu_session_memory");doSomethingElse();';
    expect(writeSessionMemory(broken)).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      'patch: sessionMemory: failed to find extraction gate'
    );
    errSpy.mockRestore();
  });
});
