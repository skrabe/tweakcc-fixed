// Please see the note about writing patches in ./index
//
// This patch injects CUSTOM_MODELS data and hooks into Claude Code's context window
// calculation logic to support custom Ollama models like "qwen36-500k:35b" that aren't
// in Claude Code's internal model catalog.
//
// Models are loaded dynamically from config.json at patch-apply time, so users can
// add/remove/customize their Ollama or LM Studio models without re-patching the binary.

import { CUSTOM_MODELS as BUILT_IN_MODELS } from './modelSelector';
import type { CustomModel } from '../types';
import { debug } from '../utils';

/**
 * Inject helper functions and modify the context window calculation logic.
 *
 * Strategy: merge built-in Claude models (from modelSelector.ts) with user-defined
 * customModels from config.json, then inject the combined list into globalThis so
 * hF can look up per-model context windows at runtime.
 */
export const writeModelContextWindowSync = (
  oldFile: string,
  customModels?: CustomModel[]
): string | null => {
  if (!oldFile || oldFile.length === 0) {
    debug('patch: modelContextWindowSync: received empty file');
    return null;
  }

  // Convert input to latin1 buffer for lossless byte representation.
  // Latin1 maps each byte 0x00-0xFF to char U+0000-U+00FF (one-to-one), so
  // regex patterns match at actual byte positions in the binary.
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

  // Merge built-in Claude models with user-defined customModels.
  // User models override built-ins by value (model ID), so a user can specify
  // their own context window for any Claude model variant if needed.
  const allModels = mergeCustomModels(BUILT_IN_MODELS, customModels || []);

  // --- Idempotent re-apply: check if binary already has our injection ---
  const existingInjectionIdx = latStr.indexOf('__tweakccCustomModels=');
  const hfPattern =
    /hF=\(\+process\.env\.CLAUDE_CODE_CONTEXT_LIMIT\|\|200000\)/;
  let hfMatch = latStr.match(hfPattern);

  if (!hfMatch || hfMatch.index === undefined) {
    // hF pattern not found — binary may have been patched by a previous run.
    // Update the existing injection in-place for idempotent re-apply.
    if (existingInjectionIdx >= 0) {
      debug('patch: modelContextWindowSync: binary already patched, updating in place');

      const arrayStartIdx = latStr.indexOf('[', existingInjectionIdx);
      if (arrayStartIdx >= 0) {
        let depth = 1;
        let endIdx: number | undefined;
        for (let i = arrayStartIdx + 1; i < Math.min(latStr.length, arrayStartIdx + 30000); i++) {
          if (latStr[i] === '[') depth++;
          else if (latStr[i] === ']') { depth--; if (depth <= 0) { endIdx = i; break; } }
        }

        if (endIdx !== undefined && endIdx > arrayStartIdx) {
          const newInjectCode = `globalThis.__tweakccCustomModels=${JSON.stringify(allModels)};`;

          // Reconstruct the buffer: [before injection] + [new model data] + [after existing array]
          const patchedBuf = Buffer.concat([
            origBufLatin1.slice(0, existingInjectionIdx),
            Buffer.from(newInjectCode),
            origBufLatin1.slice(endIdx + 1) // skip past the closing bracket and semicolon
          ]);

          if (patchedBuf.length >= origBufLatin1.length - 20) {
            return patchedBuf.toString('utf8');
          } else {
            debug('patch: modelContextWindowSync: in-place update resulted in smaller buffer, falling through');
          }
        }
      }

      // If we can't find the existing injection to update, fall back.
      return origBufLatin1.toString('utf8');
    } else {
      debug('patch: modelContextWindowSync: hF pattern not found and no existing injection — skip');
      return origBufLatin1.toString('utf8'); // Return unchanged if nothing to patch
    }
  }

  // --- Original patch flow (first apply) ---

  // Build inject code and replacement text as buffers
  const injectCodeBuf = Buffer.from(
    `globalThis.__tweakccCustomModels=${JSON.stringify(allModels)};`
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

  // Apply both modifications to the original buffer using latin1 slices.
  // This preserves every byte exactly — no UTF-8 expansion/shrinkage issues.
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
 * Merge built-in Claude models with user-defined custom models.
 * User models override built-ins by value (model ID), and custom-only models are appended.
 */
function mergeCustomModels(
  builtIn: CustomModel[],
  userModels: CustomModel[]
): Record<string, unknown>[] {
  // Build a map from model value to full definition (user overrides take priority)
  const merged = new Map<string, Record<string, unknown>>();

  for (const model of builtIn) {
    if (model.value) {
      merged.set(model.value, { ...model });
    }
  }

  // Apply user models — they override built-ins by value
  for (const model of userModels) {
    const entry: Record<string, unknown> = {
      value: model.value,
      label: model.label || model.description || `Custom (${model.value})`,
      description: model.description || '',
      contextWindow: model.contextWindow ?? 200000,
      maxTokens: model.maxTokens ?? 16384,
    };

    // Preserve any additional built-in properties if the user model already existed
    const existing = merged.get(model.value);
    if (existing) {
      entry.description =
        existing.description || entry.description;
    }

    merged.set(model.value, entry);
  }

  return Array.from(merged.values());
}

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
