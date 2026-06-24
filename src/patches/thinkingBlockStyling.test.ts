import { describe, it, expect, vi } from 'vitest';
import { writeThinkingBlockStyling } from './thinkingBlockStyling';

// thinking-block-styling restyles the inner thinking text so it renders dimmed
// and italic. Two anchors must both be present in cli.js:
//   1. findTextComponent's Ink <Text> definition (the minified function whose
//      destructured props start color/backgroundColor/dimColor/bold) — here `f8`.
//   2. The thinking-render shape (mirrors CC 2.1.20): a `{thinking:J}` destructure,
//      the "∴ Thinking" label, the trailing "…", then the
//      `z3A.default.createElement(P0,null,J)` call whose `P0,null` slot the patch
//      swaps for `<<TextComponent>>,{dimColor:true,italic:true}`.
const TEXT_COMPONENT_DEF =
  'function f8({color:A,backgroundColor:Q,dimColor:B=!1,bold:G=!1,italic:Z=!1}){return null}';

const THINKING_SHAPE =
  'function Ej1(A){let K=s(17),{param:q,addMargin:Y,isTranscriptMode:z,verbose:w,hideInTranscript:H}=A,{thinking:J}=q,' +
  'G=z||w,W;if(K[1]!==J)((W="∴ Thinking"),(K[1]=J),(K[2]=W));else W=K[2];let D=W;' +
  'let M=G?1:0,j;if(K[9]!==D)((j=z3A.default.createElement(f8,{dimColor:!0,italic:!0},D,"…")),(K[9]=D),(K[10]=j));else j=K[10];' +
  'let P;if(K[11]!==J)((P=z3A.default.createElement(I,{paddingLeft:2},z3A.default.createElement(P0,null,J))),(K[11]=J),(K[12]=P));else P=K[12];return P}';

const FIXTURE = `var head=1;${TEXT_COMPONENT_DEF};mid=2;${THINKING_SHAPE};var tail=3;`;

describe('writeThinkingBlockStyling', () => {
  it('rewrites the plain thinking-text createElement to a dimmed+italic Text component', () => {
    const out = writeThinkingBlockStyling(FIXTURE);

    expect(out).not.toBeNull();
    // The patch must splice the resolved Text component (f8) + styling props in
    // place of the original `P0,null` slot.
    expect(out).toContain(
      'z3A.default.createElement(f8,{dimColor:true,italic:true},J)'
    );
    // The original un-styled createElement(P0,null,J) is gone.
    expect(out).not.toContain('z3A.default.createElement(P0,null,J)');
  });

  it('only touches the inner thinking-text call, preserving surrounding code', () => {
    const out = writeThinkingBlockStyling(FIXTURE)!;
    // Untouched bookends and unrelated createElement calls survive verbatim.
    expect(out).toContain('var head=1;');
    expect(out).toContain('var tail=3;');
    expect(out).toContain('"∴ Thinking"');
    // The "… label" sibling createElement(f8,{dimColor:!0,...},D,"…") is left alone.
    expect(out).toContain(
      'z3A.default.createElement(f8,{dimColor:!0,italic:!0},D,"…")'
    );
  });

  it('matches the \\u2234 / \\u2026 escaped-literal variant of the label and ellipsis', () => {
    // Some CC builds store the label/ellipsis as escaped unicode in the source.
    const escaped = FIXTURE.replace('∴ Thinking', '\\u2234 Thinking').replace(
      '"…"',
      '"\\u2026"'
    );
    const out = writeThinkingBlockStyling(escaped);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'z3A.default.createElement(f8,{dimColor:true,italic:true},J)'
    );
  });

  it('returns null (logging) when the Text component is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // THINKING_SHAPE alone, with no Ink <Text> definition for findTextComponent.
    const out = writeThinkingBlockStyling(`x=1;${THINKING_SHAPE};y=2;`);
    expect(out).toBeNull();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('returns null (logging) when the thinking-render shape is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Text component present, but no {thinking:...} render block.
    const out = writeThinkingBlockStyling(`x=1;${TEXT_COMPONENT_DEF};y=2;`);
    expect(out).toBeNull();
    errSpy.mockRestore();
  });
});
