// Patch for v233+: Gracefully handle text blocks receiving thinking deltas.
//
// Two handler styles exist across CC versions:
//   - v234 (throw-based): if(ni.type!=="thinking")throw O(...),Error("...");ni.signature=...;break
//   - v235+ (_emit/tool-use): case"signature_delta":{if(n.type==="thinking")this._emit("signature",n.signature);break}
//     where non-thinking types fall through to default handler Ktu(t.delta) which throws.
//
// During thinking-to-text transitions (LLM finishes reasoning mid-stream), the
// signature/thinking delta arrives while the content block is still type="text".
// This causes a stream crash in both patterns.
//
// Fix: inject a text-type check before each handler body — if n.type==="text", set
// moreThinkingFlag and break out of the switch instead of throwing/falling through.
// Also removes "Content block is not a thinking block" string from the bundle.
//
// Anchors on stable English strings (minifier can't rename them):
//   - "thinking" in type checks
//   - "tengu_streaming_error" in throw-based handlers
//   - ".signature" / ".thinking" after handler body for assignment site
// Captures block-check var and moreThinking flag via flexible regex.

import { debug } from '../utils';
import { showDiff } from './index';

const THINKING_BLOCK_TEXT = 'Content block is not a thinking block';

// --- Idempotency: check whether our injection already landed ---

// Matches the text-check injection we add: if(var.type==="text"){flag=!0;break};break
const ALREADY_PAT = new RegExp(
  `if\\([\\$\\w]+\\.type==="text"\\)\\{[\\$\\w]+=!0;break\\};break`
);

// Matches the _emit injection for v235+: if(n.type==="text"){flag=!0;break} before _emit
const ALREADY_EMIT_PAT = new RegExp(
  `if\\([\\$\\w]+\\.type==="text"\\)\\{[\\$\\w]+=!0;break\\}`
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

  if (!m || m.index === undefined) {
    // v237+ may not have Error() — try the no-Error pattern first
    if (file.indexOf('Error("Content block') === -1) {
      return patchSignatureDeltaNoError(file);
    }
    return { newFile: file, applied: false };
  }

  // Find variable names from context around the anchor
  const anchorIdx = m!.index as number;
  const flagVar = findMoreThinkingFlag(file, anchorIdx);
  const blockVar = findBlockTypeVar(file, anchorIdx);

  if (!flagVar || !blockVar) {
    debug(
      'patch: thinkingTextTransition: variable extraction failed for signature_delta'
    );
    return { newFile: file, applied: false };
  }

  const oldBlock = m![0];
  // Preserve the captured type-check var (m[1]) and assignment target (m[3])
  // Inject text-check + break before the throw, keep the assignment after
  const replacement = `case"signature_delta":if(${m[1]}.type!=="thinking"){if(${blockVar}.type==="text"){${flagVar}=!0;break};break;}\n${m[1]}.signature=${m![3]}.signature;break`;

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
 * Patch signature_delta for v237+ builds where Error() is absent from the throw chain.
 * This is a standalone function because patchSignatureDelta returns early when its main
 * regex (which requires Error()) doesn't match — but v237 may have throw without Error().
 */
function patchSignatureDeltaNoError(file: string): {
  newFile: string;
  applied: boolean;
} {
  const patNoError =
    /case"signature_delta":if\(([a-zA-Z_$]+)\.type!=="thinking"\)throw\s+([$\w]+)\("tengu[^"]*"[^;]*;\s*\1\.signature=([\w$]+)\.signature;break/;
  const m2 = file.match(patNoError);

  if (!m2 || m2.index === undefined) return { newFile: file, applied: false };

  // Find variable names from context
  const anchorIdx = m2.index as number;
  const flagVar = findMoreThinkingFlag(file, anchorIdx);
  const blockVar = findBlockTypeVar(file, anchorIdx);

  if (!flagVar || !blockVar) {
    debug(
      'patch: thinkingTextTransition: variable extraction failed for signature_delta (no-error path)'
    );
    return { newFile: file, applied: false };
  }

  const oldBlock2 = m2[0];
  // Inject text-check + break before the throw, keep the assignment after
  const replacement2 = `case"signature_delta":if(${m2[1]}.type!=="thinking"){if(${blockVar}.type==="text"){${flagVar}=!0;break};break;}\n${m2[1]}.signature=${m2[3]}.signature;break`;

  const newFile =
    file.slice(0, m2.index) +
    replacement2 +
    file.slice(m2.index + oldBlock2.length);
  showDiff(
    file,
    newFile,
    `thinkingTextTransition: signature_delta (no-error)`,
    m2.index,
    m2.index + oldBlock2.length
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

  // v237+ may not have Error() — try the no-Error pattern when main match fails
  if (
    (!m || m.index === undefined) &&
    file.indexOf('Error("Content block') === -1
  ) {
    return patchThinkingDeltaNoError(file);
  }
  const anchorIdx = m!.index as number;
  const flagVar = findMoreThinkingFlag(file, anchorIdx);
  const blockVar = m![1]; // ni or ia — already captured from the regex

  if (!flagVar) {
    debug(
      'patch: thinkingTextTransition: more-thinking flag not found for thinking_delta'
    );
    return { newFile: file, applied: false };
  }

  const oldBlock = m![0];
  // Preserve redacted_thinking break, replace throw+Error with text-check + break, keep assignment
  const replacement = `if(${blockVar}.type==="redacted_thinking")break;if(${blockVar}.type!=="thinking"){if(${blockVar}.type==="text"){${flagVar}=!0;break};break;}\n${blockVar}.thinking+=${m![3]}.thinking;break`;

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

/**
 * Patch thinking_delta for v237+ builds where Error() is absent from the throw chain.
 */
function patchThinkingDeltaNoError(file: string): {
  newFile: string;
  applied: boolean;
} {
  const patNoError =
    /if\(([a-zA-Z_$]+)\.type==="redacted_thinking"\)break;if\(\1\.type!=="thinking"\)throw\s+([$\w]+)\("tengu[^"]*"[^;]*;\s*\1\.thinking\+=([\w$]+)\.thinking;break/;
  const m2 = file.match(patNoError);

  if (!m2 || m2.index === undefined) return { newFile: file, applied: false };

  // Find variable names from context
  const anchorIdx = m2.index as number;
  const flagVar = findMoreThinkingFlag(file, anchorIdx);
  const blockVar = m2[1];

  if (!flagVar) {
    debug(
      'patch: thinkingTextTransition: more-thinking flag not found for thinking_delta (no-error path)'
    );
    return { newFile: file, applied: false };
  }

  const oldBlock2 = m2[0];
  // Inject text-check + break before the throw, keep redacted_thinking guard and assignment after
  const replacement2 = `if(${blockVar}.type==="redacted_thinking")break;if(${blockVar}.type!=="thinking"){if(${blockVar}.type==="text"){${flagVar}=!0;break};break;}\n${blockVar}.thinking+=${m2[3]}.thinking;break`;

  const newFile =
    file.slice(0, m2.index) +
    replacement2 +
    file.slice(m2.index + oldBlock2.length);
  showDiff(
    file,
    newFile,
    `thinkingTextTransition: thinking_delta (no-error)`,
    m2.index,
    m2.index + oldBlock2.length
  );
  return { newFile, applied: true };
}

// --- v235+ _emit / tool-use pattern handlers ---

/**
 * Patch the signature_delta handler in _emit-based patterns (v235+).
 * Original: `case"signature_delta":{if(n.type==="thinking")this._emit("signature",n.signature);break}`
 * or:       `case"signature_delta":{if(n?.type==="thinking")r.content[t.index]={...n,signature:t.delta.signature};break}`
 *
 * Injects text-check before the thinking check so that text blocks receiving
 * signature deltas set moreThinkingFlag and break instead of falling through.
 */
function patchSignatureDeltaEmit(file: string): {
  newFile: string;
  applied: boolean;
} {
  // Find the content_block_delta switch body that contains _emit or tool-use pattern
  // Pattern 1: streaming with this._emit("signature",n.signature)
  const emitPat =
    /case"signature_delta":\{if\(([a-zA-Z_$]+)\?\.type\s*===\s*"thinking"\)([^;]*?)this\._emit\("signature",[^)]*\)/;
  // Pattern 2: tool-use with r.content[t.index]={...n,signature:t.delta.signature}
  const toolPat =
    /case"signature_delta":\{if\(([a-zA-Z_$]+)\?\.type\s*===\s*"thinking"\)([^;}]*?)r\.content\[([a-zA-Z_$]+)\.index\]=\{\.\.\.\1,signature:([a-zA-Z_$]+)\.delta\.signature\}/;

  const flagVar = findMoreThinkingFlag(
    file,
    file.indexOf('case"signature_delta":')
  );
  if (!flagVar) return { newFile: file, applied: false };

  // Try _emit pattern first
  const emitMatch = file.match(emitPat);
  if (emitMatch && emitMatch.index !== undefined) {
    const blockVar = emitMatch[1]; // n or similar
    const replacement = `case"signature_delta":{if(${blockVar}.type==="text"){${flagVar}=!0;break};${emitMatch[0]}`;
    const newFile =
      file.slice(0, emitMatch.index) +
      replacement +
      file.slice(emitMatch.index + emitMatch[0].length);
    showDiff(
      file,
      newFile,
      'thinkingTextTransition: signature_delta (_emit)',
      emitMatch.index,
      emitMatch.index + emitMatch[0].length
    );
    return { newFile, applied: true };
  }

  // Try tool-use pattern
  const toolMatch = file.match(toolPat);
  if (toolMatch && toolMatch.index !== undefined) {
    const blockVar = toolMatch[1]; // n or similar
    const replacement = `case"signature_delta":{if(${blockVar}.type==="text"){${flagVar}=!0;break};${toolMatch[0]}`;
    const newFile =
      file.slice(0, toolMatch.index) +
      replacement +
      file.slice(toolMatch.index + toolMatch[0].length);
    showDiff(
      file,
      newFile,
      'thinkingTextTransition: signature_delta (tool-use)',
      toolMatch.index,
      toolMatch.index + toolMatch[0].length
    );
    return { newFile, applied: true };
  }

  // Try default handler pattern: case"signature_delta":{if(n.type==="thinking")this._emit(...);break}default:Ktu(t.delta)
  const defaultPat =
    /case"signature_delta":\{if(([a-zA-Z_$]+)\.type\s*===\s*"thinking")([\s\S]*?)break\}:default:/;
  const defMatch = file.match(defaultPat);
  if (defMatch && defMatch.index !== undefined) {
    const blockVar = defMatch[1];
    // Inject text-check before the thinking check
    const oldBlock = defMatch[0];
    const replacement = `case"signature_delta":{if(${blockVar}.type==="text"){${flagVar}=!0;break};${oldBlock.slice(oldBlock.indexOf('{') + 1)}`;
    const newFile =
      file.slice(0, defMatch.index) +
      replacement +
      file.slice(defMatch.index + oldBlock.length);
    showDiff(
      file,
      newFile,
      'thinkingTextTransition: signature_delta (default)',
      defMatch.index,
      defMatch.index + oldBlock.length
    );
    return { newFile, applied: true };
  }

  return { newFile: file, applied: false };
}

/**
 * Patch the thinking_delta handler in _emit / tool-use patterns (v235+).
 * Original v235 streaming: case"thinking_delta":{if(n.type==="thinking")this._emit("thinking",t.delta.thinking,n.thinking);break}
 * Original v235 tool-use:  case"thinking_delta":{if(n?.type==="thinking")r.content[t.index]={...n,thinking:n.thinking+t.delta.thinking};break}
 */
function patchThinkingDeltaEmit(file: string): {
  newFile: string;
  applied: boolean;
} {
  const flagVar = findMoreThinkingFlag(
    file,
    file.indexOf('case"thinking_delta":')
  );
  if (!flagVar) return { newFile: file, applied: false };

  // Pattern for tool-use thinking_delta with redacted_thinking guard
  // case"thinking_delta":{if(n?.type==="redacted_thinking")break;if(n?.type==="thinking")r.content[t.index]={...n,thinking:n.thinking+t.delta.thinking};break}
  const toolPat =
    /case"thinking_delta":\{if\(([a-zA-Z_$]+)\?\.type\s*===\s*"redacted_thinking"\)break;if\(\1\?\.type\s*===\s*"thinking"\)([^;]*?)r\.content\[([a-zA-Z_$]+)\.index\]=\{\.\.\.\1,thinking:\1\.thinking\+([a-zA-Z_$]+)\.delta\.thinking\}/;
  const toolMatch = file.match(toolPat);
  if (toolMatch && toolMatch.index !== undefined) {
    const blockVar = toolMatch[1];
    const replacement = `case"thinking_delta":{if(${blockVar}.type==="redacted_thinking")break;if(${blockVar}.type==="text"){${flagVar}=!0;break};if(${blockVar}?.type==="thinking"${toolMatch[2]}r.content[${toolMatch[3]}.index]={...${blockVar},thinking:${blockVar}.thinking+${toolMatch[4]}.delta.thinking}}`;
    const newFile =
      file.slice(0, toolMatch.index) +
      replacement +
      file.slice(toolMatch.index + toolMatch[0].length);
    showDiff(
      file,
      newFile,
      'thinkingTextTransition: thinking_delta (tool-use emit)',
      toolMatch.index,
      toolMatch.index + toolMatch[0].length
    );
    return { newFile, applied: true };
  }

  // Pattern for streaming _emit thinking_delta
  const emitPat =
    /case"thinking_delta":\{if\(([a-zA-Z_$]+)\.type\s*===\s*"thinking"\)this\._emit\("thinking",([a-zA-Z_$]+)\.delta\.thinking,\1\.thinking\);break\}/;
  const emitMatch = file.match(emitPat);
  if (emitMatch && emitMatch.index !== undefined) {
    const blockVar = emitMatch[1];

    // Add text-check before the thinking check
    const oldBlock = emitMatch[0];
    const replacement = `case"thinking_delta":{if(${blockVar}.type==="text"){${flagVar}=!0;break};${oldBlock}`;
    const newFile =
      file.slice(0, emitMatch.index) +
      replacement +
      file.slice(emitMatch.index + oldBlock.length);
    showDiff(
      file,
      newFile,
      'thinkingTextTransition: thinking_delta (streaming emit)',
      emitMatch.index,
      emitMatch.index + oldBlock.length
    );
    return { newFile, applied: true };
  }

  // Pattern for tool-use with n?.type check and default handler
  const defPat =
    /case"thinking_delta":\{if\(([a-zA-Z_$]+)\?\.type\s*===\s*"thinking"\)([^;}]*?)r\.content\[([a-zA-Z_$]+)\.index\]=\{\.\.\.\1,thinking:\1\.thinking\+([a-zA-Z_$]+)\.delta\.thinking\};break\}default:/;
  const defMatch = file.match(defPat);
  if (defMatch && defMatch.index !== undefined) {
    const blockVar = defMatch[1];
    // Inject text-check before the thinking check
    const oldBlock = defMatch[0];
    const replacement = `case"thinking_delta":{if(${blockVar}.type==="text"){${flagVar}=!0;break};${oldBlock}`;
    const newFile =
      file.slice(0, defMatch.index) +
      replacement +
      file.slice(defMatch.index + oldBlock.length);
    showDiff(
      file,
      newFile,
      'thinkingTextTransition: thinking_delta (default)',
      defMatch.index,
      defMatch.index + oldBlock.length
    );
    return { newFile, applied: true };
  }

  return { newFile: file, applied: false };
}

// --- Combined patch function ---

/**
 * Apply the thinking-to-text graceful transition patch to minified source.
 * Handles both throw-based (v234) and _emit/tool-use (v235+) patterns.
 * Plain regex splice — no external engine required.
 * Returns patched source or null if anchors not found (not patchable).
 */
export const applyThinkingTextTransition = (oldFile: string): string | null => {
  // Check idempotency first
  if (ALREADY_PAT.test(oldFile) || ALREADY_EMIT_PAT.test(oldFile)) {
    debug('patch: thinkingTextTransition: already patched — skipping');
    return null;
  }

  let working = oldFile;
  let appliedCount = 0;

  // Patch signature_delta site (try throw-based first, then _emit/tool-use)
  const sigResult = patchSignatureDelta(working);
  if (sigResult.applied) {
    working = sigResult.newFile;
    appliedCount++;
  } else {
    const emitSigResult = patchSignatureDeltaEmit(working);
    if (emitSigResult.applied) {
      working = emitSigResult.newFile;
      appliedCount++;
    }
  }

  // Patch thinking_delta site (try throw-based first, then _emit/tool-use)
  const thinkResult = patchThinkingDelta(working);
  if (thinkResult.applied) {
    working = thinkResult.newFile;
    appliedCount++;
  } else {
    const emitThinkResult = patchThinkingDeltaEmit(working);
    if (emitThinkResult.applied) {
      working = emitThinkResult.newFile;
      appliedCount++;
    }
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
