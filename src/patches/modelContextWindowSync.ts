// Please see the note about writing patches in ./index
//
// This patch ensures that when a model is selected (via /model or programmatically),
// both the context window limit AND the auto-compact buffer are updated to reflect
// the selected model's actual capabilities.
//
// The /context command currently shows "200k" hardcoded regardless of which model
// is selected. This patch hooks into the model selection logic and updates:
// 1. The context window limit used for truncation decisions
// 2. The auto-compact buffer percentage (default 90% of context window)

import { CustomModel, CUSTOM_MODELS } from './modelSelector';
import { debug } from '../utils';
import { showDiff } from './index';

/**
 * Inject CUSTOM_MODELS data into globalThis so it can be read at runtime.
 */
const injectCustomModelsData = (file: string): string | null => {
  // Find a safe injection point - typically near other globalThis assignments
  const pattern = /globalThis\.[$\w]+=/;
  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    console.error('patch: modelContextWindowSync: failed to find globalThis assignment site');
    return null;
  }

  // Inject CUSTOM_MODELS data before the first globalThis assignment
  const injectCode = `globalThis.__tweakccCustomModels=${JSON.stringify(CUSTOM_MODELS)};`;

  const newFile = file.slice(0, match.index) + injectCode + file.slice(match.index);
  showDiff(file, newFile, injectCode, match.index, match.index);

  return newFile;
};

/**
 * Hook into the model selection logic to update context window and compact buffer.
 */
const patchModelSelectionHook = (file: string): string | null => {
  // Method 1: Look for where mainLoopModel gets assigned from user selection
  const patternMethod1 = /options\.mainLoopModel\s*=\s*[$\w]+/;

  let match: RegExpMatchArray | null = file.match(patternMethod1);

  if (!match || match.index === undefined) {
    console.error('patch: modelContextWindowSync: failed to find mainLoopModel assignment');
    return null;
  }

  // Insert hook code after the match that reads from globalThis.__tweakccCustomModels
  const hookCode = `
// BEGIN __tweakcc model context sync
(function() {
  if (typeof globalThis === 'undefined') return;
  var customModels = globalThis.__tweakccCustomModels || [];

  // Function to get context window for a given model ID
  function getContextWindow(modelId) {
    var model = customModels.find(function(m) { return m.value === modelId; });
    if (model && model.contextWindow) {
      return model.contextWindow;
    }
    // Default fallback for models not in our list
    return 200000;
  }

  // Function to get auto-compact percentage (default 90%)
  function getCompactPercentage() {
    if (typeof globalThis.__tweakccCompactPercent !== 'undefined') {
      return globalThis.__tweakccCompactPercent / 100;
    }
    return 0.9; // Default to 90%
  }

  // Hook into model selection changes
  var originalSetModel = window.setMainLoopModel || function() {};
  if (typeof window !== 'undefined') {
    window.setMainLoopModel = function(modelId) {
      originalSetModel.apply(this, arguments);

      // Update context limit based on selected model
      var ctxWindow = getContextWindow(modelId);
      process.env.CLAUDE_CODE_CONTEXT_LIMIT = ctxWindow.toString();

      // Calculate and apply compact buffer (90% of context window)
      var compactBuffer = Math.floor(ctxWindow * getCompactPercentage());
      if (typeof globalThis.setCompactBuffer === 'function') {
        globalThis.setCompactBuffer(compactBuffer);
      }
    };
  }
})();
// END __tweakcc model context sync
`;

  const insertionPoint = match.index + match[0].length;
  const newFile = file.slice(0, insertionPoint) + hookCode + file.slice(insertionPoint);

  showDiff(file, newFile, hookCode.trim(), insertionPoint, insertionPoint);

  return newFile;
};

/**
 * Main entry point: Apply all model context window sync patches.
 */
export const writeModelContextWindowSync = (oldFile: string): string | null => {
  let currentFile = oldFile;

  // Step 1: Inject CUSTOM_MODELS data into globalThis
  const injectedData = injectCustomModelsData(currentFile);
  if (!injectedData) return null;
  currentFile = injectedData;

  // Step 2: Hook into model selection logic
  const patchedHook = patchModelSelectionHook(currentFile);
  if (!patchedHook) return null;
  currentFile = patchedHook;

  return currentFile;
};
