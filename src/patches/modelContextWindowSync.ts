// Please see the note about writing patches in ./index
//
// This patch injects CUSTOM_MODELS data and hooks into Claude Code's context window
// calculation logic to support custom Ollama models like "ornith1-505k:35b" that aren't
// in Claude Code's internal model catalog.

import { CUSTOM_MODELS } from './modelSelector';
import { debug } from '../utils';

/**
 * Inject helper functions and modify the context window calculation logic.
 *
 * Strategy: convert input to latin1 buffer (byte-exact), search patterns in latin1,
 * then find matching byte sequences in original binary to get correct offsets.
 * Apply modifications directly on original buffer slices.
 */
export const writeModelContextWindowSync = (oldFile: string): string | null => {
  if (!oldFile || oldFile.length === 0) {
    debug('patch: modelContextWindowSync: received empty file');
    return null;
  }

  // Convert input to latin1 buffer for lossless byte representation
  const origBufLatin1 = Buffer.from(oldFile, 'latin1');
  const latStr = origBufLatin1.toString('latin1');

  // --- Step 1: Find injection site via latin1 string ---
  const globalThisPattern = /globalThis(?:\.\w+|\[[^\]]+\])\s*=/;
  const globalThisMatch = latStr.match(globalThisPattern);

  if (!globalThisMatch || globalThisMatch.index === undefined) {
    console.error(
      'patch: modelContextWindowSync: failed to find globalThis assignment site'
    );
    return null;
  }

  // --- Step 2: Find hF pattern via latin1 string ---
  const hfPattern =
    /hF=\(\+process\.env\.CLAUDE_CODE_CONTEXT_LIMIT\|\|200000\)/;
  const hfMatch = latStr.match(hfPattern);

  if (!hfMatch || hfMatch.index === undefined) {
    debug('patch: modelContextWindowSync: hF pattern not found');
    return null;
  }

  // Build inject code and replacement text as buffers
  const injectCodeBuf = Buffer.from(
    `globalThis.__tweakccCustomModels=${JSON.stringify(CUSTOM_MODELS)};`
  );
  const hfOriginalBytes = Buffer.from(hfMatch[0]);
  const replacementCodeBuf = Buffer.from(
    `hF=(function(){var e=+process.env.CLAUDE_CODE_CONTEXT_LIMIT;if(e>0)return e;var m=globalThis.__tweakccCustomModels||[];for(var i=0;i<m.length;i++){if(m[i].value===BE("model"))return m[i].contextWindow||200000}return 200000})()`
  );

  // Find actual byte offsets in origBufLatin1 by scanning near the latin1 string offset.
  // The key: findExactByteOffset scans a window around refPos to handle UTF-8 multi-byte shifts.

  const injOffsetInBuf = findExactByteOffset(
    origBufLatin1,
    injectCodeBuf.slice(0, 4),
    globalThisMatch.index
  );

  // For hF: scan from the latin1 string's hfMatch index position
  let hfOffsetInBuf = findExactByteOffset(
    origBufLatin1,
    hfOriginalBytes,
    hfMatch.index
  );

  if (injOffsetInBuf === -1) {
    console.error(
      'patch: modelContextWindowSync: failed to locate injection point in buffer'
    );
    return null;
  }
  if (
    hfOffsetInBuf === -1 ||
    hfOffsetInBuf < injOffsetInBuf + injectCodeBuf.length
  ) {
    debug(
      'patch: modelContextWindowSync: hF pattern not found near expected position in buffer'
    );
    // Search more broadly from latin1 offset
    hfOffsetInBuf = findExactByteOffset(
      origBufLatin1,
      hfOriginalBytes,
      Math.max(0, origBufLatin1.length - 500)
    );
    if (hfOffsetInBuf === -1) {
      debug(
        'patch: modelContextWindowSync: hF pattern not found in buffer at all'
      );
      return null;
    }
  }

  // Apply both modifications to the original buffer
  const patchedBuf = Buffer.concat([
    origBufLatin1.slice(0, injOffsetInBuf),
    injectCodeBuf,
    origBufLatin1.slice(
      injOffsetInBuf + globalThisMatch[0].length,
      hfOffsetInBuf
    ),
    replacementCodeBuf,
    origBufLatin1.slice(hfOffsetInBuf + hfOriginalBytes.length),
  ]);

  // Verify size increase is reasonable (~inject code length + net hF change)
  const expectedMinSize = origBufLatin1.length - 20;
  if (patchedBuf.length < expectedMinSize) {
    console.error(
      `patch: modelContextWindowSync: patched file (${patchedBuf.length}) is smaller than original (${origBufLatin1.length}), possible truncation`
    );
    return null;
  }

  // Verify injections are present at correct positions
  const injCheck = patchedBuf
    .slice(injOffsetInBuf - 20, injOffsetInBuf + injectCodeBuf.length)
    .toString('latin1');
  if (!injCheck.includes('__tweakccCustomModels')) {
    debug(
      'patch: modelContextWindowSync: injection not found at expected offset in result'
    );
    return null;
  }

  // Convert back to string format expected by caller (UTF-8 compatible)
  return patchedBuf.toString('utf8');
};

/**
 * Find the byte offset of a needle buffer within orig, starting search near a given reference position.
 * Falls back to scanning forward/up to ~500 bytes from refPos if exact match not found at refPos.
 */
function findExactByteOffset(
  orig: Buffer,
  needle: Buffer,
  refPos: number
): number {
  // First try exact offset
  if (refPos >= 0 && refPos + needle.length <= orig.length) {
    const slice = orig.slice(refPos, refPos + needle.length);
    if (slice.equals(needle)) return refPos;
  }

  // Scan forward from refPos up to 500 bytes
  const searchStart = Math.max(0, refPos - 20);
  for (
    let i = searchStart;
    i < orig.length - needle.length + 1 && i < searchStart + 600;
    i++
  ) {
    if (orig[i] === needle[0]) {
      let match = true;
      for (let j = 1; j < needle.length && match; j++) {
        if (orig[i + j] !== needle[j]) match = false;
      }
      if (match) return i;
    }
  }

  // Last resort: search entire buffer from refPos onward
  for (let i = Math.max(0, refPos); i < orig.length - needle.length + 1; i++) {
    if (orig[i] === needle[0]) {
      let match = true;
      for (let j = 1; j < needle.length && match; j++) {
        if (orig[i + j] !== needle[j]) match = false;
      }
      if (match) return i;
    }
  }

  return -1;
}
