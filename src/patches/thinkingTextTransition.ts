// Patch for v233+: Gracefully handle text blocks receiving thinking deltas.
//
// In the content_block_delta switch, signature_delta and thinking_delta throw
// "Content block is not a thinking block" when the incoming block type isn't
// "thinking". During thinking-to-text transitions (the LLM finishes reasoning
// mid-stream), this causes a stream crash.
//
// Fix: inject a text-type check before each throw — if ni.type==="text", set
// the moreThinkingFlag and break out of the switch instead of throwing. Then
// replace the throw expression with just `break;`, which also removes the
// "Content block is not a thinking block" string from the bundle entirely.
//
// Anchors on stable English strings (minifier can't rename them):
//   - "thinking" in ni.type!=="thinking" / ia.type==="thinking"
//   - "tengu_streaming_error" in the error factory call
//   - ".signature" / ".thinking" after the throw for assignment site
// Captures block-check var (from nearby text_delta if) and moreThinking flag
// (from content_block_delta init) via flexible regex, so it survives per-release
// minification across v233/v234/v235+.

import { debug } from '../utils';
import { showDiff } from './index';

const THINKING_BLOCK_TEXT = 'Content block is not a thinking block';

// --- Idempotency: check whether our injection already landed ---

const ALREADY_PAT = new RegExp(
  `if\\([\\$\\w]+\\.type==="text"\\)\\{[\\$\\w]+=!0;break\\};break`
);

// --- Variable extraction helpers ---

/**
 * Find the "more thinking" flag var: `content_block_delta...:{X=!1` or similar.
 * Scans within 4000 chars before the anchor to stay scoped.
 */
function findMoreThinkingFlag(file: string, anchorIdx: number): string | null {
  const windowStart = Math.max(0, anchorIdx - 4000);
  const snippet = file.slice(windowStart, anchorIdx + 50);
  // Pattern: content_block_delta:{<flag>=!1 or similar init near the switch
  const m = snippet.match(/content_block_delta.{0,20}:\{([$\w]+)=!1/);
  if (m) return m[1];

  // Fallback: look for any single-letter var set to !1 right after content_block_delta:{
  const fallback = snippet.match(
    /content_block_delta.{0,50}:\{([a-zA-Z_$][\w$]*)=!1/
  );
  if (fallback) return fallback[1];

  return null;
}

/**
 * Find the block-check variable: `if(<var>.type!=="text")` or `<var>.type==="text"`
 * in nearby text_delta or signature_delta cases.
 */
function findBlockTypeVar(file: string, anchorIdx: number): string | null {
  const windowStart = Math.max(0, anchorIdx - 3000);
  const snippet = file.slice(windowStart, anchorIdx + 50);

  // Try matching the text_delta type check first (closest to signature_delta)
  const m1 = snippet.match(/if\(([$\w]+)\.type!=="text"\)/);
  if (m1) return m1[1];

  // Fallback: look for any .type==="text" pattern near the anchor
  const m2 = snippet.match(/\(([$\w]+)\)\.type\s*===\s*"text"/);
  if (m2) return m2[1];

  return null;
}

// --- Core injection patterns ---

/**
 * signature_delta: replace the throw-based handler with a break.
 * Original v234/v235+: `case"signature_delta":if(X.type!=="thinking")throw Y("tengu_streaming_error",{...}),Error("Content block is not a thinking block");X.signature=Z.signature;break;`
 * Patched: inject text-check, replace throw+Error with break (keeps assignment).
 */
function patchSignatureDelta(file: string): {
  newFile: string;
  applied: boolean;
} {
  // Match from case label through the Error("...thinking") and up to .signature= assignment.
  // The key stable anchors are "thinking" in the type check, ".signature=" after the throw,
  // and "tengu" inside the error factory call. Case-insensitive match for the Thinking text.
  const pat =
    /case"signature_delta":if\(([$\w]+)\.type!=="thinking"\)throw\s+([$\w]+)\("tengu[^"]*"[^;]*?Error\([^)]*[Tt]hinking[^)]*\);[\s\n]*\1\.signature=([\w$]+)\.signature;break/;
  const m = file.match(pat);

  if (!m || m.index === undefined) return { newFile: file, applied: false };

  // Find variable names from context around the anchor
  const anchorIdx = m.index;
  const flagVar = findMoreThinkingFlag(file, anchorIdx);
  const blockVar = findBlockTypeVar(file, anchorIdx);

  if (!flagVar || !blockVar) {
    debug(
      'patch: thinkingTextTransition: variable extraction failed for signature_delta'
    );
    return { newFile: file, applied: false };
  }

  const oldBlock = m[0];
  // Preserve the captured type-check var (m[1]) and assignment target (m[3])
  // Inject text-check + break before the throw, keep the assignment after
  const replacement = `case"signature_delta":if(${m[1]}.type!=="thinking"){if(${blockVar}.type==="text"){${flagVar}=!0;break};break;}\n${m[1]}.signature=${m[3]}.signature;break`;

  // For v237+ where Error() is absent — also try matching throw...tengu without Error
  if (file.indexOf('Error("Content block') === -1) {
    const patNoError =
      /case"signature_delta":if\(([$\w]+)\.type!=="thinking"\)throw\s+([$\w]+)\("tengu[^"]*"[^;]*;\s*\1\.signature=([\w$]+)\.signature;break/;
    const m2 = file.match(patNoError);
    if (m2 && m2.index !== undefined) {
      const oldBlock2 = m2[0];
      const replacement2 = `case"signature_delta":if(${m2[1]}.type!=="thinking"){if(${blockVar}.type==="text"){${flagVar}=!0;break};break;}\n${m2[1]}.signature=${m2[3]}.signature;break`;
      const newFile =
        file.slice(0, m2.index) +
        replacement2 +
        file.slice(m2.index + oldBlock2.length);
      showDiff(
        file,
        newFile,
        `thinkingTextTransition: signature_delta`,
        m2.index,
        m2.index + oldBlock2.length
      );
      return { newFile, applied: true };
    }
  }

  const newFile =
    file.slice(0, anchorIdx) +
    replacement +
    file.slice(anchorIdx + oldBlock.length);
  showDiff(
    file,
    newFile,
    `thinkingTextTransition: signature_delta`,
    anchorIdx,
    anchorIdx + oldBlock.length
  );
  return { newFile, applied: true };
}

/**
 * thinking_delta: replace the throw+Error with break.
 * Original: if(ni.type==="redacted_thinking")break;if(ni.type!=="thinking")throw O(...),Error("...");ni.thinking+=ls.thinking;break;
 */
function patchThinkingDelta(file: string): {
  newFile: string;
  applied: boolean;
} {
  const pat =
    /if\(([$\w]+)\.type==="redacted_thinking"\)break;if\(\1\.type!=="thinking"\)throw\s+([$\w]+)\("tengu[^"]*"[^;]*?Error\([^)]*[Tt]hinking[^)]*\);[\s\n]*\1\.thinking\+=([\w$]+)\.thinking;break/;
  const m = file.match(pat);

  if (!m || m.index === undefined) return { newFile: file, applied: false };

  const anchorIdx = m.index;
  const flagVar = findMoreThinkingFlag(file, anchorIdx);
  const blockVar = m[1]; // ni or ia — already captured from the regex

  if (!flagVar) {
    debug(
      'patch: thinkingTextTransition: more-thinking flag not found for thinking_delta'
    );
    return { newFile: file, applied: false };
  }

  const oldBlock = m[0];
  // Preserve redacted_thinking break, replace throw+Error with text-check + break, keep assignment
  const replacement = `if(${blockVar}.type==="redacted_thinking")break;if(${blockVar}.type!=="thinking"){if(${blockVar}.type==="text"){${flagVar}=!0;break};break;}\n${blockVar}.thinking+=${m[3]}.thinking;break`;

  // For v237+ where Error() is absent
  if (file.indexOf('Error("Content block') === -1) {
    const patNoError =
      /if\(([$\w]+)\.type==="redacted_thinking"\)break;if\(\1\.type!=="thinking"\)throw\s+([$\w]+)\("tengu[^"]*"[^;]*;\s*\1\.thinking\+=([\w$]+)\.thinking;break/;
    const m2 = file.match(patNoError);
    if (m2 && m2.index !== undefined) {
      const oldBlock2 = m2[0];
      const replacement2 = `if(${blockVar}.type==="redacted_thinking")break;if(${blockVar}.type!=="thinking"){if(${blockVar}.type==="text"){${flagVar}=!0;break};break;}\n${blockVar}.thinking+=${m2[3]}.thinking;break`;
      const newFile =
        file.slice(0, m2.index) +
        replacement2 +
        file.slice(m2.index + oldBlock2.length);
      showDiff(
        file,
        newFile,
        `thinkingTextTransition: thinking_delta`,
        m2.index,
        m2.index + oldBlock2.length
      );
      return { newFile, applied: true };
    }
  }

  const newFile =
    file.slice(0, anchorIdx) +
    replacement +
    file.slice(anchorIdx + oldBlock.length);
  showDiff(
    file,
    newFile,
    `thinkingTextTransition: thinking_delta`,
    anchorIdx,
    anchorIdx + oldBlock.length
  );
  return { newFile, applied: true };
}

// --- Combined patch function ---

/**
 * Apply the thinking-to-text graceful transition patch to minified source.
 * Plain regex splice — no external engine required.
 * Returns patched source or null if anchors not found (not patchable).
 */
export const applyThinkingTextTransition = (oldFile: string): string | null => {
  // Check idempotency first
  if (ALREADY_PAT.test(oldFile)) {
    debug('patch: thinkingTextTransition: already patched — skipping');
    return null;
  }

  let working = oldFile;
  let appliedCount = 0;

  // Patch signature_delta site
  const sigResult = patchSignatureDelta(working);
  if (sigResult.applied) {
    working = sigResult.newFile;
    appliedCount++;
  }

  // Patch thinking_delta site
  const thinkResult = patchThinkingDelta(working);
  if (thinkResult.applied) {
    working = thinkResult.newFile;
    appliedCount++;
  }

  if (appliedCount === 0) {
    console.log('patch: thinkingTextTransition: anchors not found — skipping');
    return null;
  }

  // Verify "Content block is not a thinking block" was removed from the bundle
  const errorStrHits = working.match(
    new RegExp(THINKING_BLOCK_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  );
  if (errorStrHits && errorStrHits.length > 0) {
    console.log(
      `patch: thinkingTextTransition: WARNING — "${THINKING_BLOCK_TEXT}" still in bundle (${errorStrHits.length} hits)`
    );
  } else {
    debug(
      `patch: thinkingTextTransition: "${THINKING_BLOCK_TEXT}" removed from bundle`
    );
  }

  return working;
};
