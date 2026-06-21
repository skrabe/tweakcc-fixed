// Please see the note about writing patches in ./index

import { showDiff } from './index';
import { SubagentModelsConfig } from '../types';

/**
 * Patches the Plan agent model.
 *
 * ```diff
 *  agentType: "Plan",
 *  ...
 * -model: "claude-sonnet-4-20250514"
 * +model: "custom-model"
 * ```
 */
const patchPlanAgent = (file: string, model: string): string | null => {
  const pattern =
    /(agentType\s*:\s*"Plan"\s*,[\s\S]{1,2500}?\bmodel\s*:\s*")[^"]+(")/;

  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    console.error('patch: subagentModels: failed to find Plan agent pattern');
    return null;
  }

  // JSON.stringify so a quote/backslash in the (possibly remote --config-url)
  // model value can't break out of the model:"..." literal (F-84/F-88 class).
  // match[1] ends with the opening quote; drop it and let JSON supply both.
  const replacement = match[1].slice(0, -1) + JSON.stringify(model);

  const startIndex = match.index;
  const endIndex = startIndex + match[0].length;

  const newFile =
    file.slice(0, startIndex) + replacement + file.slice(endIndex);

  showDiff(file, newFile, replacement, startIndex, endIndex);

  return newFile;
};

/**
 * Patches the Explore agent model.
 *
 * ```diff
 *  agentType: "Explore",
 *  ...
 * -model: "claude-sonnet-4-20250514"
 * +model: "custom-model"
 * ```
 */
const patchExploreAgent = (file: string, model: string): string | null => {
  const pattern =
    /(\{agentType\s*:\s*"Explore"\s*,[\s\S]{1,2500}?\bmodel\s*:\s*")[^"]+(")/;

  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    console.error(
      'patch: subagentModels: failed to find Explore agent pattern'
    );
    return null;
  }

  // JSON.stringify so a quote/backslash in the (possibly remote --config-url)
  // model value can't break out of the model:"..." literal (F-84/F-88 class).
  // match[1] ends with the opening quote; drop it and let JSON supply both.
  const replacement = match[1].slice(0, -1) + JSON.stringify(model);

  const startIndex = match.index;
  const endIndex = startIndex + match[0].length;

  const newFile =
    file.slice(0, startIndex) + replacement + file.slice(endIndex);

  showDiff(file, newFile, replacement, startIndex, endIndex);

  return newFile;
};

/**
 * Patches the general-purpose agent model.
 * This agent may or may not have a model field already defined.
 *
 * ```diff
 *  agentType: "general-purpose",
 *  ...
 * +model: "custom-model"
 *  }
 * ```
 *
 * or if model already exists:
 *
 * ```diff
 *  agentType: "general-purpose",
 *  ...
 * -model: "claude-sonnet-4-20250514"
 * +model: "custom-model"
 *  }
 * ```
 */
const patchGeneralPurposeAgent = (
  file: string,
  model: string
): string | null => {
  const pattern =
    /([^$\w][$\w]+\s*=\s*\{agentType\s*:\s*"general-purpose"[\s\S]{0,2500}?)(\})/;

  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    console.error(
      'patch: subagentModels: failed to find general-purpose agent pattern'
    );
    return null;
  }

  const beforeClosingBrace = match[1];
  const closingBrace = match[2];

  let replacement: string;

  if (beforeClosingBrace.includes('model:')) {
    // Model field exists, replace it. Function replacer (not a $-string) so a
    // `$` in the config model can't trigger replacement-pattern substitution,
    // and JSON.stringify so a quote/backslash can't break out of model:"..."
    // (F-84/F-88 class). The regex captures `model:` without its quote.
    replacement =
      beforeClosingBrace.replace(
        /(model\s*:\s*)"[^"]+"/,
        (_m, prefix) => prefix + JSON.stringify(model)
      ) + closingBrace;
  } else {
    // Model field doesn't exist, add it. JSON.stringify supplies the quotes and
    // escapes any quote/backslash so the config value can't break the literal.
    const separator = beforeClosingBrace.trim().endsWith(',') ? '' : ',';
    replacement =
      beforeClosingBrace +
      `${separator}model:` +
      JSON.stringify(model) +
      closingBrace;
  }

  const startIndex = match.index;
  const endIndex = startIndex + match[0].length;

  const newFile =
    file.slice(0, startIndex) + replacement + file.slice(endIndex);

  showDiff(file, newFile, replacement, startIndex, endIndex);

  return newFile;
};

export const writeSubagentModels = (
  oldFile: string,
  config: SubagentModelsConfig
): string | null => {
  let currentFile = oldFile;

  if (config.plan) {
    const afterPlan = patchPlanAgent(currentFile, config.plan);
    if (afterPlan === null) {
      return null;
    }
    currentFile = afterPlan;
  }

  if (config.explore) {
    const afterExplore = patchExploreAgent(currentFile, config.explore);
    if (afterExplore === null) {
      return null;
    }
    currentFile = afterExplore;
  }

  if (config.generalPurpose) {
    const afterGeneralPurpose = patchGeneralPurposeAgent(
      currentFile,
      config.generalPurpose
    );
    if (afterGeneralPurpose === null) {
      return null;
    }
    currentFile = afterGeneralPurpose;
  }

  return currentFile;
};
