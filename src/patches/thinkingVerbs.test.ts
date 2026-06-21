import { describe, it, expect, vi } from 'vitest';
import { writeThinkingVerbs } from './thinkingVerbs';

// thinkingVerbs replaces two arrays: a 50+ entry present-tense "-ing" verb array
// (→ JSON.stringify(verbs)) and a 6+ entry past-tense "-ed" array
// (→ JSON.stringify(verbs.map(ing→ed))). Build a synthetic fixture matching both.
const PRESENT = `[${Array.from({ length: 50 }, (_, i) => `"Aaa${i}ing"`).join(',')}]`;
const PAST =
  '["Baked","Brewed","Churned","Cogitated","Cooked","Crunched","Sauteed","Worked"]';
const FIXTURE = `a=1;P=${PRESENT};b=2;Q=${PAST};c=3;`;

describe('writeThinkingVerbs', () => {
  it('replaces both the present- and past-tense arrays', () => {
    const out = writeThinkingVerbs(FIXTURE, ['Foo', 'Bar']);
    expect(out).not.toBeNull();
    expect(out).toContain('P=["Foo","Bar"];');
    expect(out).toContain('Q=["Foo","Bar"];');
    // the original 50-verb array is gone
    expect(out).not.toContain('"Aaa0ing"');
  });

  it('converts -ing verbs to -ed for the past-tense array', () => {
    const out = writeThinkingVerbs(FIXTURE, ['Walking', 'Running'])!;
    expect(out).toContain('P=["Walking","Running"];');
    expect(out).toContain('Q=["Walked","Runned"];');
  });

  // verbs come from config (untrusted via --config-url); JSON.stringify must
  // escape a quote/backslash so it can't break out of the array literal.
  it('JSON-escapes verbs containing quotes/backslashes', () => {
    const out = writeThinkingVerbs(FIXTURE, ['Ev"il', 'Back\\slash'])!;
    expect(out).toContain(`P=${JSON.stringify(['Ev"il', 'Back\\slash'])};`);
    expect(out).not.toContain('"Ev"il"'); // no raw breakout
    // the spliced array literal is valid JS
    const m = out.match(/P=(\[.*?\]);/)!;
    expect(() => JSON.parse(m[1])).not.toThrow();
  });

  it('returns null when the present-tense array is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeThinkingVerbs(`x=1;Q=${PAST};`, ['a'])).toBeNull();
    errSpy.mockRestore();
  });

  it('returns null when the past-tense array is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeThinkingVerbs(`x=1;P=${PRESENT};`, ['a'])).toBeNull();
    errSpy.mockRestore();
  });
});
