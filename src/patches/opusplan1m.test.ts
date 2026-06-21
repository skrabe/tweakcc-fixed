import { describe, it, expect, vi } from 'vitest';
import { writeOpusplan1m } from './opusplan1m';

// opusplan1m is ALWAYS_APPLIED but a no-op on CC >= 2.1.87 (opusplan[1m] is
// native there, so it self-skips). The 6 sub-patches only run on legacy CC.
// Fixture lines mirror each sub-patch's documented "Original:" shape.
const LEGACY_LINES = {
  modeSwitch: 'if(F1()==="opusplan"&&Md==="plan"&&!Ex)return G2();',
  aliases: 'Q=["sonnet","opus","haiku","sonnet[1m]","opusplan"];',
  description: 'if(D==="opusplan")return"Opus in plan mode, else Sonnet";',
  label: 'if(L==="opusplan")return"Opus Plan";',
  selector: 'if(S==="opusplan")return[...AL,Mm3()];',
  alwaysShow: 'if(C===null||LS.some((v)=>v.value===C))return LS;',
};
const LEGACY_FIXTURE = Object.values(LEGACY_LINES).join('');

describe('writeOpusplan1m', () => {
  it('skips (returns the file unchanged) when opusplan[1m] is already native', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const input = 'x=["opusplan","opusplan[1m]"];rest';
    expect(writeOpusplan1m(input)).toBe(input);
    logSpy.mockRestore();
  });

  it('applies all six legacy sub-patches in sequence', () => {
    const out = writeOpusplan1m(LEGACY_FIXTURE);

    expect(out).not.toBeNull();
    // Patch 1: mode-switch gains the ||"opusplan[1m]" arm
    expect(out).toContain('==="opusplan[1m]")&&Md==="plan"');
    // Patch 2: alias added to the model list
    expect(out).toContain('"opusplan","opusplan[1m]"]');
    // Patch 3: description case added
    expect(out).toContain('Opus in plan mode, else Sonnet (1M context)');
    // Patch 4: label case added
    expect(out).toContain('Opus Plan 1M');
    // Patch 6: always-show push injected
    expect(out).toContain('LS.push({value:"opusplan[1m]"');
  });

  it('returns null if any one sub-patch anchor is missing (all-or-nothing)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Drop the label anchor — sub-patch 4 then fails and the whole patch aborts.
    const fixtureMissingLabel =
      LEGACY_LINES.modeSwitch +
      LEGACY_LINES.aliases +
      LEGACY_LINES.description +
      LEGACY_LINES.selector +
      LEGACY_LINES.alwaysShow;
    expect(writeOpusplan1m(fixtureMissingLabel)).toBeNull();
    errSpy.mockRestore();
  });
});
