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

// CC 2.1.273 anchor + conditional-ellipsis format shape:
//   …overrideMessage:X,isCompacting:…,compactingHintText:…,compactingStartTime:…,
//     spinnerSuffix:Y,verbose:Z,<300 chars>…
//   …,ue=Mn.test(vt)?vt:vt+"…"…
// The label is resolved into `vt` before the declaration and the ellipsis is
// only appended when it isn't already there, so no earlier pattern matches.
const ANCHOR_2273 =
  'overrideMessage:gn,isCompacting:uo,compactingHintText:mo,' +
  'compactingStartTime:fo,spinnerSuffix:sS,verbose:vB,' +
  'z'.repeat(320);
const FORMAT_COND = ',ue=Mn.test(vt)?vt:vt+"\\u2026"';
const FIXTURE_2273 = `pre();{${ANCHOR_2273}};mid();${FORMAT_COND};tail()`;

describe('writeThinkerFormat — CC 2.1.273 conditional ellipsis', () => {
  it('rewrites the conditional-ellipsis decl, binding {} to the label var', () => {
    const out = writeThinkerFormat(FIXTURE_2273, '{}');

    expect(out).not.toBeNull();
    expect(out).toContain(',ue=`${vt}`');
    expect(out).not.toContain('Mn.test(vt)');
    expect(out).toContain('tail()');
  });

  it('keeps a custom format around the bound label', () => {
    const out = writeThinkerFormat(FIXTURE_2273, '>> {} <<');

    expect(out).toContain(',ue=`>> ${vt} <<`');
  });
});

// CC 2.1.277: the ellipsis is a `suffix` prop, skipped only when it is the
// default and the label already ends in one:
//   …,Kt=O===we&&_n.test(Vt)?Vt:Vt+O;…
const FORMAT_SUFFIX = ',Kt=O===we&&_n.test(Vt)?Vt:Vt+O';
const FIXTURE_2277 = `pre();{${ANCHOR_2273}};mid();${FORMAT_SUFFIX};tail()`;

describe('writeThinkerFormat — CC 2.1.277 suffix prop', () => {
  it('rewrites the suffix-prop decl, binding {} to the label var', () => {
    const out = writeThinkerFormat(FIXTURE_2277, '{}');

    expect(out).not.toBeNull();
    expect(out).toContain(',Kt=`${Vt}`;');
    expect(out).not.toContain('_n.test(Vt)');
    expect(out).toContain('tail()');
  });
});

// CC 2.1.326: isResponseHeld sits between isCompacting and compactingHintText,
// and a sibling spinner sharing pauseStartTimeRef/spinnerSuffix/verbose lies
// far before the format-bearing function.
const SIBLING_2326 =
  'function S1i({pauseStartTimeRef:b,spinnerSuffix:d,verbose:O,columns:v}){}' +
  'q'.repeat(30000);
const ANCHOR_2326 =
  'function Ye({mode:i,pauseStartTimeRef:t,overrideShimmerColor:u,' +
  'overrideMessage:g,isCompacting:T,isResponseHeld:f,compactingHintText:p,' +
  'compactingStartTime:C,spinnerSuffix:S,verbose:R,hasActiveTools:w=!1,' +
  'afterReplyText:v=!1,suffix:W}){let ue=g??P';
const FORMAT_2326 = ',et=W===G&&BHt.test(ue)?ue:ue+W';
const FIXTURE_2326 = `pre();${SIBLING_2326};${ANCHOR_2326}${FORMAT_2326};tail()`;

describe('writeThinkerFormat — CC 2.1.326 widened destructure', () => {
  it('anchors on the format-bearing destructure, not the distant sibling', () => {
    const out = writeThinkerFormat(FIXTURE_2326, '{}');

    expect(out).not.toBeNull();
    expect(out).toContain(',et=`${ue}`;tail()');
    expect(out).not.toContain('BHt.test(ue)');
    expect(out).toContain('isResponseHeld:f,compactingHintText:p');
    expect(out).toContain('function S1i({pauseStartTimeRef:b');
  });
});
