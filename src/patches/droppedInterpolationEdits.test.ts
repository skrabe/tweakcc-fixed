import { describe, it, expect } from 'vitest';
import { droppedInterpolationEdits } from './inlineBlobOverrides';

// Regression cover for the CC 2.1.211 silent-drop trap: an inline-blob override's
// `${...}` interpolations are re-emitted VERBATIM from the binary, so any content
// authored inside a slot is discarded — apply reports ✓, nothing warns, smoke
// passes, and the override is silently absent (and the sentence can stay fluent
// while carrying Anthropic's text instead of yours).
//
// The detector must fire on authored prose but stay silent on the identifier
// renames the remap exists to perform — a false positive here would train the
// reader to ignore the warning, which is worse than the bug.
describe('droppedInterpolationEdits', () => {
  it("does NOT flag a plain identifier rename (the remap's normal job)", () => {
    // override authored against an older build (`H`), binary now says `e`
    expect(droppedInterpolationEdits('a ${H} b', ['e'])).toEqual([]);
  });

  it('does NOT flag a rename inside a ternary whose literals are unchanged', () => {
    const body = 'x ${GJH?`hi ${A}`:""} y';
    const pristine = ['aX_?`hi ${z}`:""'];
    expect(droppedInterpolationEdits(body, pristine)).toEqual([]);
  });

  it('flags a reworded ternary branch — the real 2.1.211 intro case', () => {
    const body =
      'You are an interactive agent working ${H!==null?\'according to your "Output Style" below.\':"alongside the user as a peer-level senior engineer."} Use the tools.';
    const pristine = [
      'e!==null?\'according to your "Output Style" below.\':"with software engineering tasks."',
    ];
    expect(droppedInterpolationEdits(body, pristine)).toEqual([0]);
  });

  it('reports the slot index, and only the edited slot', () => {
    const body = 'a ${X} b ${Y?"mine":""} c ${Z?"same":""}';
    const pristine = ['q', 'r?"theirs":""', 's?"same":""'];
    expect(droppedInterpolationEdits(body, pristine)).toEqual([1]);
  });

  it('flags multiple edited slots', () => {
    const body = '${A?"one":""} and ${B?"two":""}';
    const pristine = ['a?"uno":""', 'b?"dos":""'];
    expect(droppedInterpolationEdits(body, pristine)).toEqual([0, 1]);
  });

  it('ignores slots the override dropped (fewer than pristine)', () => {
    expect(droppedInterpolationEdits('only ${A}', ['a', 'b?"x":""'])).toEqual(
      []
    );
  });

  it('handles escaped quotes inside a literal without desyncing', () => {
    const body = '${A?"say \\"hi\\"":""}';
    const pristine = ['a?"say \\"hi\\"":""'];
    expect(droppedInterpolationEdits(body, pristine)).toEqual([]);
  });

  it('flags a changed literal that differs only in trailing punctuation', () => {
    expect(droppedInterpolationEdits('${A?"go":""}', ['a?"go.":""'])).toEqual([
      0,
    ]);
  });

  it('is a no-op when there are no interpolations at all', () => {
    expect(droppedInterpolationEdits('plain text', [])).toEqual([]);
  });

  // Regression: a bare placeholder must never be flagged. The real
  // inline-loop-tool-constraints case — the override writes `${x4}` and pristine
  // carries `c.map((N)=>`- ${N}`).join('\n')`. The override authored nothing
  // inside the slot, so the remap loses nothing; flagging it would be a false
  // positive on a CORRECT override, which trains the reader to ignore the guard.
  it('does NOT flag a bare placeholder against a literal-bearing pristine expr', () => {
    const body = 'Sessions since last consolidation (${c7}):\n${x4}';
    const pristine = ['c.length', "c.map((N)=>`- ${N}`).join('\\n')"];
    expect(droppedInterpolationEdits(body, pristine)).toEqual([]);
  });

  it('still flags when the override authored literals the remap will drop', () => {
    const body = '${A?"mine":""}';
    const pristine = ["a.map((N)=>`- ${N}`).join('\\n')"];
    expect(droppedInterpolationEdits(body, pristine)).toEqual([0]);
  });
});
