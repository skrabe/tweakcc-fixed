/**
 * Edit-tool patch: add ignore_whitespace option (defaults to false) via the LexPatcher engine.
 *
 * The `patchEditTool` function is the public API — it takes a minified source string
 * and returns patched source (or null on failure). It delegates to LexPatcher +
 * editToolPatchConfig which describe the exact patch: insert a trim() call on file content
 * before splitting, so ignore_whitespace can strip each line prior to matching.
 */

import { LexPatcher } from './lexPatcher';
import { editToolPatchConfig } from './editToolPatchConfig';
import { LocationResult, showDiff } from './index';
import { getEditToolLocation } from './ignoreWhitespaceEdit';

/**
 * Patch the edit tool to support ignore_whitespace.
 * Returns null on failure (patch already applied or source incompatible).
 */
export function patchEditTool(
  oldFile: string,
  loc?: LocationResult | null
): string | null {
  const location = loc ?? getEditToolLocation(oldFile);
  if (!location) return null;

  // Check for prior application to avoid double-patching
  const funcContent = oldFile.slice(location.startIndex, location.endIndex);
  if (funcContent.includes('additionalProperties:{ignore_whitespace')) {
    console.log('patch: editToolIgnoreWhitespace: already patched, skipping');
    return null;
  }

  // Run the LexPatcher engine against the full source
  const patcher = new LexPatcher(editToolPatchConfig);
  const patchedFile = patcher.apply(oldFile);
  if (!patchedFile) {
    console.error('patch: editToolIgnoreWhitespace: LexPatcher returned null');
    return null;
  }

  showDiff(
    oldFile,
    patchedFile,
    'edit tool: added ignore_whitespace support via LexPatcher',
    location.startIndex,
    funcContent.length
  );

  return patchedFile;
}
