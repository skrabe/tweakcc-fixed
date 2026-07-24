import { describe, expect, it } from 'vitest';
import {
  harnessVerdict,
  introducedRawNonAscii,
  introducedUnresolvedSlots,
} from './applySafetyHarness.mjs';

const clean = {
  cnf: 0,
  cannotApply: 0,
  introduced: [],
  rawNonAscii: [],
  parses: true,
  wfScriptErrors: [],
};

describe('applySafetyHarness: harnessVerdict', () => {
  it('passes only when every check is clean', () => {
    expect(harnessVerdict(clean)).toBe(true);
  });

  it('fails on a "cannot apply safely" warning', () => {
    expect(harnessVerdict({ ...clean, cannotApply: 1 })).toBe(false);
  });

  it('fails on introduced raw non-ASCII', () => {
    expect(harnessVerdict({ ...clean, rawNonAscii: ['U+2014(+1)'] })).toBe(
      false
    );
  });

  it('still fails on the pre-existing checks', () => {
    expect(harnessVerdict({ ...clean, cnf: 1 })).toBe(false);
    expect(harnessVerdict({ ...clean, introduced: ['K9(+1)'] })).toBe(false);
    expect(harnessVerdict({ ...clean, parses: false })).toBe(false);
    expect(harnessVerdict({ ...clean, wfScriptErrors: ['x.md: boom'] })).toBe(
      false
    );
  });
});

// Every injection surface escapes non-ASCII to \uXXXX before splicing; a raw
// codepoint that survives into the patched binary mojibakes under Bun's Latin-1
// module storage (2.0.13 incident). The check is a per-codepoint DELTA so the
// pristine's own non-ASCII can never trip it.
describe('applySafetyHarness: introducedRawNonAscii', () => {
  it('reports nothing when the patch escaped its non-ASCII', () => {
    const pristine = 'x=`use a — dash`;';
    const patched = 'x=`use a \\u2014 dash`;';
    expect(introducedRawNonAscii(pristine, patched)).toEqual([]);
  });

  it('reports nothing when patched and pristine are identical', () => {
    const s = 'x=`“quoted” — ✓`;';
    expect(introducedRawNonAscii(s, s)).toEqual([]);
  });

  it('does not flag pristine non-ASCII that merely moved', () => {
    const pristine = 'a=`— ✓`;b=`plain`;';
    const patched = 'a=`plain`;b=`✓ —`;';
    expect(introducedRawNonAscii(pristine, patched)).toEqual([]);
  });

  it('does not flag a patch that REMOVES non-ASCII', () => {
    const pristine = 'x=`— — ✓`;';
    const patched = 'x=`—`;';
    expect(introducedRawNonAscii(pristine, patched)).toEqual([]);
  });

  it('flags a raw non-ASCII codepoint the patch introduced', () => {
    const pristine = 'x=`plain ascii`;';
    const patched = 'x=`plain — ascii`;';
    expect(introducedRawNonAscii(pristine, patched)).toEqual(['U+2014(+1)']);
  });

  it('counts only the surplus when pristine already carried the codepoint', () => {
    const pristine = 'x=`—`;';
    const patched = 'x=`— — —`;';
    expect(introducedRawNonAscii(pristine, patched)).toEqual(['U+2014(+2)']);
  });

  it('reports each introduced codepoint, sorted', () => {
    const pristine = 'x=`ascii`;';
    const patched = 'x=`— ✓`;';
    expect(introducedRawNonAscii(pristine, patched)).toEqual([
      'U+2014(+1)',
      'U+2713(+1)',
    ]);
  });

  it('handles astral codepoints as single units', () => {
    const pristine = 'x=`ascii`;';
    const patched = 'x=`\u{1F600}`;';
    expect(introducedRawNonAscii(pristine, patched)).toEqual(['U+1F600(+1)']);
  });

  it('ignores ASCII-only differences entirely', () => {
    expect(introducedRawNonAscii('abc', 'abc def \n\t')).toEqual([]);
  });
});

// A `${shortvar}` slot is a K9-class UNRESOLVED binary ident only when nothing binds
// it in its OWN enclosing scope. The bind-discount is scoped per-slot (a window that
// reaches the enclosing function params / module const), NOT counted file-wide —
// counting file-wide nets out on common names like `q`/`e` and either hides a leak or
// cries wolf on a legitimately-bound `${q}` (the 2.1.218 false positive).
describe('applySafetyHarness: introducedUnresolvedSlots', () => {
  const flags = (o, p) =>
    [...introducedUnresolvedSlots(o, p)].map(([v, n]) => `${v}(+${n})`);

  it('does not flag a slot bound by a destructured arrow param (2.1.218 ${q})', () => {
    const orig = 'x=1;';
    const patched = 'Object.entries(t).map(([q,K])=>`# ${q}\n${K}`).join(`\n`);';
    expect(flags(orig, patched)).toEqual([]);
  });

  it('does not flag a slot bound by a preceding let (2.1.218 ${q} task list)', () => {
    const orig = 'x=1;';
    const patched =
      'let q=e.content.map((O)=>O.id).join(`\n`);return `Tasks:\n\n${q}`;';
    expect(flags(orig, patched)).toEqual([]);
  });

  it('does not flag a slot bound by a far function param (${e} in a big body)', () => {
    const filler = 'a'.repeat(900);
    const orig = 'x=1;';
    const patched = `function build(e,r,t){${filler}return \`\${e}/v1/oauth/token\`}`;
    expect(flags(orig, patched)).toEqual([]);
  });

  it('does not flag a slot bound by a far module const (${CIu})', () => {
    const filler = 'z'.repeat(900);
    const orig = 'x=1;';
    const patched = `var CIu=524288;${filler}C(\`skipping: exceeds \${CIu} byte limit\`);`;
    expect(flags(orig, patched)).toEqual([]);
  });

  it('flags a slot whose ident is bound NOWHERE within reach (real leak)', () => {
    const orig = 'x=`plain`;';
    const patched = 'x=`hello ${zz} world`;';
    expect(flags(orig, patched)).toEqual(['zz(+1)']);
  });

  it('does not flag when the same unbound slot already existed in pristine', () => {
    const s = 'x=`hello ${zz} world`;';
    expect(flags(s, s)).toEqual([]);
  });

  it('ignores ALLCAPS override placeholders (checked by the driver leak-guard)', () => {
    const orig = 'x=1;';
    const patched = 'x=`see ${SHELL_TOOL_NAME}`;';
    expect(flags(orig, patched)).toEqual([]);
  });
});
