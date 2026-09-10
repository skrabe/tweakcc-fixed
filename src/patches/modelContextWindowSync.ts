// Please see the note about writing patches in ./index
//
// This patch injects CUSTOM_MODELS data and helper functions into Claude Code's binary.
// The helpers (__tweakccGetContextWindow, __tweakccGetMaxTokens) can be called at runtime
// to look up context window and maxTokens for any model ID from the injected CUSTOM_MODELS data.

import { CUSTOM_MODELS } from './modelSelector';
import { debug } from '../utils';
import { showDiff } from './index';

/**
 * Inject helper functions that provide access to CUSTOM_MODELS data at runtime.
 * These helpers are safe to inject anywhere in the file and don't depend on specific
 * function patterns that may vary between Claude Code versions or builds.
 */
const injectHelperFunctions = (file: string): string | null => {
  // Build the helper function code
  const helperCode = `
// BEGIN __tweakcc model context sync helpers
var __tweakccCustomModelsData=globalThis.__tweakccCustomModels||[];
function __tweakccGetContextWindow(m){var a=__tweakccCustomModelsData.find(function(e){return e.value===m});return a&&a.contextWindow?a.contextWindow:200000}
function __tweakccGetMaxTokens(m){var a=__tweakccCustomModelsData.find(function(e){return e.value===m});return a&&a.maxTokens?a.maxTokens:16384}
// END __tweakcc model context sync helpers
`;

  // Inject at the end of the file to avoid truncating any existing code
  const insertionPoint = file.length;
  const newFile = file.slice(0, insertionPoint) + helperCode + file.slice(insertionPoint);

  showDiff(file, newFile, helperCode.trim(), insertionPoint, insertionPoint);

  return newFile;
};

/**
 * Main entry point: Apply all model context window sync patches.
 */
export const writeModelContextWindowSync = (oldFile: string): string | null => {
  // Validate input is not empty
  if (!oldFile || oldFile.length === 0) {
    debug('patch: modelContextWindowSync: received empty file');
    return null;
  }

  // Inject helper functions that provide access to CUSTOM_MODELS at runtime
  const patched = injectHelperFunctions(oldFile);

  if (!patched) {
    debug('patch: modelContextWindowSync: failed to inject helper functions');
    return null;
  }

  // Verify we didn't truncate the file
  if (patched.length < oldFile.length) {
    console.error(`patch: modelContextWindowSync: patched file (${patched.length}) is smaller than original (${oldFile.length})`);
    return null;
  }

  return patched;
};
