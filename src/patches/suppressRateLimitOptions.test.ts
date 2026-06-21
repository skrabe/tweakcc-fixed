import { describe, it, expect, vi } from 'vitest';
import { writeSuppressRateLimitOptions } from './suppressRateLimitOptions';

// suppressRateLimitOptions neutralizes CC's onOpenRateLimitOptions callback by
// replacing the prop's value var with a no-op (`()=>{}`), so the rate-limit
// options entrypoint can't be opened.
//
// FIXTURE_P1 mirrors the lenient first alternation:
//   .createElement(... ,showAllInTranscript:X,agentDefinitions:Y,onOpenRateLimitOptions:CB
const FIXTURE_P1 =
  'Q.createElement(K$,{foo:bar,baz:qux,showAllInTranscript:Z9,agentDefinitions:aD,onOpenRateLimitOptions:hQ8,extra:1})';

// FIXTURE_P2 mirrors the full second alternation (explicit prop list, with
// agentDefinitions appearing BEFORE showAllInTranscript so only pattern 2 hits):
const FIXTURE_P2 =
  'y.createElement($n,{messages:mm,tools:tt,commands:cc,verbose:!0,toolJSX:null,inProgressToolUseIDs:ip,isMessageSelectorVisible:!1,conversationId:cv,screen:sc,agentDefinitions:ad,streamingToolUses:st,showAllInTranscript:sa,onOpenRateLimitOptions:rL9,x:1})';

describe('writeSuppressRateLimitOptions', () => {
  it('replaces the callback var with a no-op in the lenient (pattern 1) shape', () => {
    const out = writeSuppressRateLimitOptions(FIXTURE_P1);

    expect(out).not.toBeNull();
    expect(out).toContain('onOpenRateLimitOptions:()=>{}');
    // the original callback identifier is gone as a prop value
    expect(out).not.toContain('onOpenRateLimitOptions:hQ8');
    // surrounding props are preserved untouched
    expect(out).toContain('showAllInTranscript:Z9,agentDefinitions:aD');
    expect(out).toContain(',extra:1})');
  });

  it('replaces the callback var with a no-op in the full prop-list (pattern 2) shape', () => {
    const out = writeSuppressRateLimitOptions(FIXTURE_P2);

    expect(out).not.toBeNull();
    expect(out).toContain('onOpenRateLimitOptions:()=>{}');
    expect(out).not.toContain('onOpenRateLimitOptions:rL9');
    // trailing prop after the callback is preserved
    expect(out).toContain('()=>{},x:1})');
  });

  it('neutralizes both alternation shapes present in the same file', () => {
    // Distinct, non-overlapping shapes (pattern 1 + pattern 2) coexist in cli.js
    // on different render paths; both callbacks must be replaced.
    const input = FIXTURE_P1 + ';' + FIXTURE_P2;
    const out = writeSuppressRateLimitOptions(input);

    expect(out).not.toBeNull();
    expect(out).not.toContain('onOpenRateLimitOptions:hQ8');
    expect(out).not.toContain('onOpenRateLimitOptions:rL9');
    expect(out!.match(/onOpenRateLimitOptions:\(\)=>\{\}/g)).toHaveLength(2);
  });

  it('returns null (logging) when the onOpenRateLimitOptions pattern is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeSuppressRateLimitOptions('x=1;Q.createElement(K$,{foo:bar})')
    ).toBeNull();
    errSpy.mockRestore();
  });
});
