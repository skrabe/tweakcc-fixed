/** Tests for thinking-to-text graceful transition patch (v234 fix).
 *
 * In some versions (notably 2.1.237), the content_block_delta switch has two cases
 * that throw when the incoming block isn't a thinking block:
 *   - case"signature_delta":if(ni.type!=="thinking")throw ...;ni.signature=...;break;
 *   - case"thinking_delta":if(ia.type==="redacted_thinking")break;if(ia.type!=="thinking")throw ...;ia.thinking+=...;break;
 *
 * When the model finishes reasoning mid-stream (transitioning to text), these throws
 * crash the session. The fix is to replace the throw expressions with break statements,
 * so the handler falls through and lets the block be processed normally.
 */

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
  it('patches v234-style source with throw-based handlers (replaces throws with breaks)', () => {
    // The patch should replace the two throw expressions in signature_delta and thinking_delta
    // with break statements, while leaving text_delta and input_json_delta untouched.
    const result = applyThinkingTextTransition(freshSource());
    expect(result).not.toBeNull();

    // Verify error strings are gone (replaced with break)
    const errors =
      result?.match(/Content block is not a thinking block/g) || [];
    expect(errors.length).toBe(0);

    // Verify the injection pattern was added for both cases.
    // Each patch adds a {flagVar}=!0;break} sequence inside the if-blocks.
    const flagPattern = (result ?? '').match(/=[!]0;/g) || [];
    expect(flagPattern.length).toBeGreaterThanOrEqual(2);

    // Size should decrease (replacing long throw expressions with short break)
    expect((result?.length ?? 0)).toBeLessThan(V234_SOURCE.length);

    // The surrounding if-conditions and assignments must stay intact.
    expect(result).toContain('ni.signature=ls.signature');
    expect(result).toContain('ni.thinking+=ls.thinking');
  });

  it('is idempotent — second application returns null', () => {
    const patched = applyThinkingTextTransition(freshSource());
    expect(patched).not.toBeNull();

    // Second pass: error string already gone -> skip.
    const rePatched = applyThinkingTextTransition(patched!);
    expect(rePatched).toBeNull();
  });

  it('patches both signature_delta and thinking_delta handlers (exactly two breaks added)', () => {
    const result = applyThinkingTextTransition(freshSource());
    expect(result).not.toBeNull();

    // Should have exactly 2 flag injection patterns (one per patched handler).
    const flagCount = result?.match(/=[!]0;/g)?.length || 0;
    expect(flagCount).toBe(2);

    // The redacted_thinking guard should still be there.
    expect(result).toContain('ni.type==="redacted_thinking"');
  });

  it('returns null when anchor not found', () => {
    const source = 'no signature_delta case here';
    const result = applyThinkingTextTransition(source);
    expect(result).toBeNull();
  });

  it('does not modify text_delta or input_json_delta cases (those must keep throwing)', () => {
    // Sanity: our patch only touches signature_delta and thinking_delta.
    const sourceWithHandler = freshSource() + '\ncase"text_delta":if(ni.type!=="text")throw N("err"),Error("X");';
    const result = applyThinkingTextTransition(sourceWithHandler);
    expect(result).toContain('case"text_delta"');

    // The text_delta throw should still be there (we didn't touch it).
    expect(result).toContain('throw N("err")');
  });

  it('handles CRLF line endings in the bundle', () => {
    // The bundle can have CRLF line endings.
    const crlfSource = V234_SOURCE.replace(/\n/g, '\r\n');
    const result = applyThinkingTextTransition(crlfSource);
    expect(result).not.toBeNull();

    // Should still contain the error string gone (replaced with break).
    const errors = result?.match(/Content block is not a thinking block/g) || [];
    expect(errors.length).toBe(0);
  });
});
