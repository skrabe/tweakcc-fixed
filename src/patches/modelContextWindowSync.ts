// Please see the note about writing patches in ./index
//
// This patch modifies Claude Code's hF (context window limit) calculation to read
// per-model context windows from globalThis.__tweakccCustomModels. At startup, our
// writeModelCustomizations injection populates this array by reading ~/.claude/settings.json
// — so custom Ollama/LM Studio models are loaded dynamically at runtime with no patching needed.

import { debug } from '../utils';

/**
 * Modify hF to read context window from the dynamic __tweakccCustomModels array
 * that writeModelCustomizations populates at startup by reading settings.json.
 */
export const writeModelContextWindowSync = (oldFile: string): string | null => {
  if (!oldFile || oldFile.length === 0) {
    debug('patch: modelContextWindowSync: received empty file');
    return null;
  }

  // Convert input to latin1 buffer for lossless byte representation.
  const origBufLatin1 = Buffer.from(oldFile, 'latin1');
  const latStr = origBufLatin1.toString('latin1');

  // Find hF pattern via latin1 string (byte-exact matching)
  const hfPattern =
    /hF=\(\+process\.env\.CLAUDE_CODE_CONTEXT_LIMIT\|\|200000\)/;
  const hfMatch = latStr.match(hfPattern);

  if (!hfMatch || hfMatch.index === undefined) {
    debug('patch: modelContextWindowSync: hF pattern not found');
    return null;
  }

  // Build the replacement that checks dynamic __tweakccCustomModels first,
  // then falls back to built-in Claude models. The dynamic array is populated
  // at startup by the settings reader injected in writeModelCustomizations.
  const replacementCode = Buffer.from(
    `hF=(function(){var e=+process.env.CLAUDE_CODE_CONTEXT_LIMIT;if(e>0)return e;var m=globalThis.__tweakccCustomModels||[];for(var i=0;i<m.length;i++){if(m[i].value===BE("model"))return m[i].contextWindow||200000}return 200000})()`
  );

  // Find actual byte offset in buffer by scanning near the latin1 string position
  const hfOffsetInBuf = findExactByteOffset(
    origBufLatin1,
    Buffer.from(hfMatch[0]),
    hfMatch.index
  );

  if (hfOffsetInBuf === -1) {
    debug('patch: modelContextWindowSync: hF pattern not found in buffer');
    return null;
  }

  // Apply the modification directly on the original buffer
  const patchedBuf = Buffer.concat([
    origBufLatin1.slice(0, hfOffsetInBuf),
    replacementCode,
    origBufLatin1.slice(hfOffsetInBuf + Buffer.from(hfMatch[0]).length),
  ]);

  // Verify size increase is reasonable (just the hF replacement delta)
  const expectedMinSize = origBufLatin1.length - 20;
  if (patchedBuf.length < expectedMinSize) {
    console.error(
      `patch: modelContextWindowSync: patched file (${patchedBuf.length}) is smaller than original (${origBufLatin1.length}), possible truncation`
    );
    return null;
  }

  // Verify the replacement is correct by checking it contains __tweakccCustomModels lookup
  const checkStr = patchedBuf.toString('latin1');
  if (!checkStr.includes('__tweakccCustomModels')) {
    debug('patch: modelContextWindowSync: hF replacement not found at expected offset in result');
    return null;
  }

  // Convert back to string format expected by caller (UTF-8 compatible)
  return patchedBuf.toString('utf8');
};

/**
 * Find the byte offset of a needle buffer within orig, starting search near a given reference position.
 */
function findExactByteOffset(
  orig: Buffer,
  needle: Buffer,
  refPos: number
): number {
  // First try exact offset (latin1 string position matches binary byte position for ASCII text)
  if (refPos >= 0 && refPos + needle.length <= orig.length) {
    const slice = orig.slice(refPos, refPos + needle.length);
    if (slice.equals(needle)) return refPos;
  }

  // Scan forward from refPos up to ~500 bytes for the pattern
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
