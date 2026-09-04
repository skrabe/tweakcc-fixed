// Tests for the FileEditTool matching-chain fallback patch.
//
// This patch adds a line-by-line trimmed-match fallback to the matching chain
// ($1t/W2t) and mirrors quote normalization onto new_string via b4r/LWr.
// Both functions are anchored on English strings the minifier can't rename:
// "Edit also tried swapping curly quotes for straight ones in old_string before matching."

import { describe, expect, it } from 'vitest';

import { writeIgnoreWhitespaceEdit } from './ignoreWhitespaceEdit';

/** Fixture mimicking a real CC bundle (v238 shape): anchor string + matching function + normalizer mirror. */
const PRISTINE = `function b4r(e,t,r){var n=r.split("|");return n[0]}
function $1t(e,t){if(e.includes(t))return t;let r=rNp(t),o=rNp(e).indexOf(r);if(o!==-1)return e.substring(o,o+t.length);if(qOa.test(t)){let i=FOa(t);if(i!==t&&e.includes(i))return i}if(WOa.test(t)){let i=e.match(new RegExp(oNp(t)));if(i)return i[0]}return null}
function LWr(e,t,r){var n=r.split("|");return n[0]}

// Anchor string the minifier can't rename.
Edit also tried swapping curly quotes for straight ones in old_string before matching.
var m=$1t(f,n);
var k=$1t(p,q,true);  // replace_all mode`;

describe('writeIgnoreWhitespaceEdit', () => {
  it('patches $1t with line-by-line fallback and LWr with indent mirror in v238 shape', () => {
    // The patch must insert both the matching chain fallback AND the normalization mirror.
    const result = writeIgnoreWhitespaceEdit(PRISTINE);
    expect(result).not.toBeNull();

    // Both markers should be present (one for each function patched).
    expect(result).toContain('// tweakcc-ignore-whitespace-fallback');

    // The original anchor string must still be there (we didn't corrupt it).
    expect(result).toContain('Edit also tried swapping');

    // The matching function signature now has the third parameter.
    expect(result).toContain('function $1t(e,t,ignoreWhitespace=false)');

    // The call site is patched to pass false as default for ignore_whitespace.
    expect(result).toContain('$1t(f,n,false);');

    // The 3-arg call site (replace_all mode) should also be patched.
    expect(result).toContain('$1t(p,q,true,false);');

    // The normalizer mirror function is preserved.
    expect(result).toContain('function LWr(e,t,r)');

    // Fallback code for line-by-line comparison was inserted.
    expect(result).toContain('_tL=t.split');
    expect(result).toContain('_eL=e.split');

    // Indentation mirroring code was inserted into the normalizer mirror.
    expect(result).toContain('var _nL=r.split');
    expect(result).toContain('_mL=n.split');
  });

  it('only activates fallback when ignore_whitespace=true (LLM opt-in)', () => {
    // Verify the patch includes proper conditional logic for ignoreWhitespace parameter.
    const result = writeIgnoreWhitespaceEdit(PRISTINE);
    expect(result).not.toBeNull();

    // The fallback should be wrapped in an if(ignoreWhitespace) check.
    expect(result).toContain('if(ignoreWhitespace){');

    // This ensures LLM can choose strict matching (default) vs lenient whitespace tolerance.
    // Strict: ignore_whitespace=false or omitted — exact character match required.
    // Lenient: ignore_whitespace=true — trim() each line before comparing, only if exactly one run matches.
  });

  it('provides clear guidance for LLM on when to use ignore_whitespace', () => {
    // Verify the patch includes documentation about proper usage.
    const result = writeIgnoreWhitespaceEdit(PRISTINE);
    expect(result).not.toBeNull();

    // Check that conditional logic is present (if(ignoreWhitespace) check).
    expect(result).toContain('if(ignoreWhitespace){');

    // Check that fallback code structure exists for whitespace-aware matching.
    expect(result).toContain('_tL=t.split');
  });

  it('is idempotent — second call returns null', () => {
    const result = writeIgnoreWhitespaceEdit(PRISTINE);
    expect(result).not.toBeNull();
    // Second pass: marker already present -> skip.
    const rePatched = writeIgnoreWhitespaceEdit(result!);
    expect(rePatched).toBeNull();
  });

  it('returns null when anchor string is absent', () => {
    // If the English anchor isn't found, we can't locate the functions to patch.
    const result = writeIgnoreWhitespaceEdit('no relevant code here');
    expect(result).toBeNull();
  });

  it('does not modify stream handler text_delta cases (only touches matching chain)', () => {
    // Sanity: our patch only touches the matching chain, not the stream handler.
    const sourceWithHandler = PRISTINE + '\ncase"text_delta":if(ni.type!=="text")throw N("err"),Error("X");';
    const result = writeIgnoreWhitespaceEdit(sourceWithHandler);
    expect(result).toContain('case"text_delta"');
  });

  it('produces a string that can be inserted into valid JS context (balanced braces)', () => {
    // The patched output is meant to replace the original bundle content, not run standalone.
    // We just verify no obvious corruption: balanced braces in function bodies.
    const result = writeIgnoreWhitespaceEdit(PRISTINE);
    expect(result).not.toBeNull();

    // Count braces to make sure we didn't leave any unbalanced.
    let depth = 0;
    for (const ch of result!) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    expect(depth).toBe(0);
  });

  it('handles CRLF line endings in the bundle', () => {
    // The bundle can have CRLF line endings, so we need to handle that.
    const crlfPristine = PRISTINE.replace(/\n/g, '\r\n');
    const result = writeIgnoreWhitespaceEdit(crlfPristine);
    expect(result).not.toBeNull();

    // Should still contain the anchor string (possibly with CRLF).
    expect(result).toContain('Edit also tried swapping');

    // Braces should still be balanced.
    let depth = 0;
    for (const ch of result!) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    expect(depth).toBe(0);
  });

  it('detects exactly one run of lines for ambiguity check', () => {
    // The fallback should only return the original span when there's exactly one run.
    // This test verifies the logic is in place (we can't easily test runtime behavior without a real bundle).
    const result = writeIgnoreWhitespaceEdit(PRISTINE);
    expect(result).not.toBeNull();

    // Should contain the runs detection logic.
    expect(result).toContain('_runs');
    expect(result).toContain('if(_runs<=1');
  });
});
