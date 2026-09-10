// Please see the note about writing patches in ./index
//
// Holistic approach: Hook into Claude Code's model selection logic to
// automatically update context window AND maxTokens output size when user
// changes models. This patch reads from injected CUSTOM_MODELS data and
// updates internal state variables (exceeds200kTokens, etc.) based on the
// selected model's actual capabilities.

import { CUSTOM_MODELS } from './modelSelector';
import { debug } from '../utils';
import { showDiff } from './index';

/**
 * Inject CUSTOM_MODELS data into globalThis so it can be read at runtime.
 */
const injectCustomModelsData = (file: string): string | null => {
  // Find a safe injection point - typically near other globalThis assignments
  // Match both dot notation (globalThis.foo=) and bracket notation (globalThis[expr]=)
  // Allow optional whitespace around the assignment operator
  const pattern = /globalThis(?:\.[$\w]+|\[[^\]]+\])\s*=/;
  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    console.error('patch: modelContextWindowSync: failed to find globalThis assignment site');
    return null;
  }

  // Inject CUSTOM_MODELS data before the first globalThis assignment
  const injectCode = `globalThis.__tweakccCustomModels=${JSON.stringify(CUSTOM_MODELS)};`;

  const newFile = file.slice(0, match.index) + injectCode + file.slice(match.index);
  showDiff(file, newFile, injectCode, match.index, match.index);

  return newFile || null;
};

/**
 * Hook into the model resolver function (uM pattern from fablePlan.ts).
 * This is where mainLoopModel and exceeds200kTokens are set when a model changes.
 */
const patchModelResolver = (file: string): string | null => {
  // Pattern from fablePlan.ts - matches the model resolver function signature
  const patternMethod1 = /(function ([$\w]+)\(([$\w]+)\)\{let\{permissionMode:([$\w]+),mainLoopModel:([$\w]+),exceeds200kTokens:([$\w]+)=!1\}=\3;)(if\(\4!=="plan"\)return \5;let [$\w]+=([$\w]+)\(\),)/;
  const patternMethod2 = /(function ([$\w]+)\(([$\w]+)\)\{let\{permissionMode:([$\w]+),mainLoopModel:([$\w]+),exceeds200kTokens:([$\w]+)=!1\}=\3,([$\w]+)=([$\w]+)\(\);)/;

  let match = file.match(patternMethod1) || file.match(patternMethod2);

  if (!match || !match.index) {
    debug('patch: modelContextWindowSync: failed to find model resolver function (uM pattern)');
    return null;
  }

  const prefix = match[1];

  // Build injection that looks up context window and maxTokens from CUSTOM_MODELS
  const injectionCode = `
// BEGIN __tweakcc model context sync
var __tweakccCustomModelsData=globalThis.__tweakccCustomModels||[];
function __tweakccGetContextWindow(m){var a=__tweakccCustomModelsData.find(function(e){return e.value===m});return a&&a.contextWindow?a.contextWindow:200000}
function __tweakccGetMaxTokens(m){var a=__tweakccCustomModelsData.find(function(e){return e.value===m});return a&&a.maxTokens?a.maxTokens:16384}
// END __tweakcc model context sync
`;

  const insertionPoint = match.index + prefix.length;
  return file.slice(0, insertionPoint) + injectionCode + file.slice(insertionPoint);
};

/**
 * Main entry point: Apply all model context window sync patches.
 */
export const writeModelContextWindowSync = (oldFile: string): string | null => {
  // Step 1: Inject CUSTOM_MODELS data into globalThis
  let currentFile = injectCustomModelsData(oldFile);
  if (!currentFile) return null;

  // Step 2: Hook into model resolver function (uM pattern from fablePlan.ts)
  currentFile = patchModelResolver(currentFile);
  if (!currentFile) return null;

  return currentFile;
};
