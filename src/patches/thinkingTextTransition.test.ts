/** Tests for thinking-to-text graceful transition patch (v234 fix). */

import { describe, it, expect } from 'vitest';
import { applyThinkingTextTransition } from './thinkingTextTransition';

// Structured to match real v234 handler ordering:
// 1. content_block_delta (sets moreThinkingFlag Cn) comes BEFORE signature_delta
// 2. signature_delta has throw-based handler with O/Ce/ge variables after anchor
// 3. thinking_delta follows after sigDelta, has "redacted_thinking")break; anchor
const V234_SOURCE = `case"content_block_delta":{Cn=!1;let n=r.content.at(-1);switch(t.delta.type){case"text_delta":if(n.type!=="text")throw O("tengu_streaming_error",{error_type:Ce("content_block_type_mismatch_text"),expected_type:Ce("text"),actual_type:ge(n.type)}),n.text+=ls.text;break;case"signature_delta":if(ni.type!=="thinking")throw O("tengu_streaming_error",{error_type:Ce("content_block_type_mismatch_thinking_signature"),expected_type:Ce("thinking"),actual_type:ge(ni.type)}),Error("Content block is not a thinking block");ni.signature=ls.signature;break;case"thinking_delta":if(ni.type==="redacted_thinking")break;if(ni.type!=="thinking")throw O("tengu_streaming_error",{error_type:Ce("content_block_type_mismatch_thinking_delta"),expected_type:Ce("thinking"),actual_type:ge(ni.type)}),Error("Content block is not a thinking block");ni.thinking+=ls.thinking;break;`;

function freshSource() {
  return V234_SOURCE;
}

describe('applyThinkingTextTransition', () => {
  it('patches v234-style source with throw-based handlers', () => {
    const result = applyThinkingTextTransition(freshSource());
    expect(result).not.toBeNull();

    // Verify two text-check injections were added (one per anchor)
    expect(
      (result ?? '').match(/type==="text"\)/g)?.length
    ).toBeGreaterThanOrEqual(2);

    // "Content block is not a thinking block" removed from bundle entirely
    const errors =
      result?.match(/Content block is not a thinking block/g) || [];
    expect(errors.length).toBe(0);

    // Text-check injections present at both sites
    const textChecks = (result ?? '').match(/type==="text"\)/g);
    expect(textChecks?.length).toBeGreaterThanOrEqual(2);

    // Size may shrink (we remove error strings) or grow slightly; key is two injections applied
    expect((result?.length ?? 0) - V234_SOURCE.length).toBeGreaterThan(-500);
  });

  it('is idempotent', () => {
    const patched = applyThinkingTextTransition(freshSource());
    expect(patched).not.toBeNull();

    // Second application should return null (already patched)
    const rePatched = applyThinkingTextTransition(patched!);
    expect(rePatched).toBeNull();
  });

  it('patches both signature_delta and thinking_delta handlers', () => {
    const result = applyThinkingTextTransition(freshSource());
    expect(result).not.toBeNull();

    // Both injections contain the text-check pattern before each throw.
    const checkCount = result?.match(/type==="text"\)/g);
    expect(checkCount?.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null when anchor not found', () => {
    const source = 'no signature_delta case here';
    const result = applyThinkingTextTransition(source);
    expect(result).toBeNull();
  });
});
