import { describe, it, expect, vi } from 'vitest';
import { writeThinkerFormat } from './thinkerFormat';

// thinker-format rewrites the spinner's verb line. The patch first anchors on a
// destructured-signature run, then within the following ~20KB finds the format
// declaration `,IDENT=(EXPR)+"…"` and rewrites it to a backtick template where
// the user's `{}` placeholder becomes `${EXPR}` (the captured spinner-verb expr).
//
// LATEST-anchor + nullish-format shape (mirrors CC >= 2.1.126):
//   …pauseStartTimeRef:X,spinnerSuffix:Y,verbose:Z,<300+ chars>… then later
//   …,N=(Q??C?.activeForm??L)+"…"…
// The `…` (U+2026) trailing literal is what the format regex anchors on.
const ANCHOR =
  'pauseStartTimeRef:pR,spinnerSuffix:sS,verbose:vB,' + 'x'.repeat(320);
const FORMAT_OLD = ',N7=(Q9??C2?.activeForm??L4)+"…"';
const FIXTURE_LATEST = `var $a=1;{${ANCHOR}};something();${FORMAT_OLD};tail()`;

// NEW-anchor + nullish-conditional spinner-verb shape (mirrors CC ~2.1.113):
//   …overrideMessage:X,spinnerSuffix:Y,verbose:Z,<300 chars>…
//   …,M=(a&&!b.isIdle?c.spinnerVerb??d:e)+"…"…
const ANCHOR_NEW =
  'overrideMessage:oM,spinnerSuffix:sS,verbose:vB,' + 'y'.repeat(320);
const FORMAT_NEW = ',M8=($w&&!$i.isIdle?$s.spinnerVerb??$f:$e)+"…"';
const FIXTURE_NEW = `pre();{${ANCHOR_NEW}};mid();${FORMAT_NEW};tail()`;

describe('writeThinkerFormat', () => {
  it('rewrites the nullish format decl to a backtick template (default {} placeholder)', () => {
    const out = writeThinkerFormat(FIXTURE_LATEST, '{}');

    expect(out).not.toBeNull();
    // {} is spliced with the captured spinner-verb expression.
    expect(out).toContain('N7=`${Q9??C2?.activeForm??L4}`');
    // The original `=(…)+"…"` declaration is gone.
    expect(out).not.toContain('=(Q9??C2?.activeForm??L4)+"…"');
    // Surrounding code is untouched.
    expect(out).toContain('something();');
    expect(out).toContain(';tail()');
  });

  it('keeps surrounding format text and substitutes the verb expr in the middle', () => {
    const out = writeThinkerFormat(FIXTURE_LATEST, '✻ {} now…')!;
    expect(out).toContain('N7=`\\u273b ${Q9??C2?.activeForm??L4} now\\u2026`');
  });

  it('handles the isIdle/spinnerVerb conditional shape via the NEW anchor', () => {
    const out = writeThinkerFormat(FIXTURE_NEW, '{}');
    expect(out).not.toBeNull();
    expect(out).toContain('M8=`${$w&&!$i.isIdle?$s.spinnerVerb??$f:$e}`');
    expect(out).not.toContain('=($w&&!$i.isIdle?$s.spinnerVerb??$f:$e)+"…"');
  });

  it('escapes backticks, backslashes and ${ in the user format (F-84 injection guard)', () => {
    // A malicious/remote format must not break the template literal nor inject
    // an executable ${...} expression. {} is the only real interpolation.
    const evil = 'a`b\\c${globalThis.x}{}';
    const out = writeThinkerFormat(FIXTURE_LATEST, evil)!;

    // Literal backtick/backslash/${ are escaped so they survive the template.
    expect(out).toContain('a\\`b');
    expect(out).toContain('b\\\\c');
    expect(out).toContain('\\${globalThis.x}');
    // The only un-escaped interpolation is the spinner-verb splice from {}.
    expect(out).toContain('}${Q9??C2?.activeForm??L4}`');
    // The patched format declaration is valid JS (template literal parses).
    const decl = out.slice(out.indexOf('N7=`'), out.indexOf('`;tail()') + 1);
    expect(
      () => new Function('Q9,C2,L4,globalThis', `return ${decl}`)
    ).not.toThrow();
  });

  it('returns null (logging) when no anchor/format shape is present', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeThinkerFormat('function unrelated(){return 1}', '{}')
    ).toBeNull();
    errSpy.mockRestore();
  });

  it('returns null when the anchor is present but the format decl is missing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const noFormat = `pre();{${ANCHOR_NEW}};mid();noFormatHere();tail()`;
    expect(writeThinkerFormat(noFormat, '{}')).toBeNull();
    errSpy.mockRestore();
  });
});
