import type { PromptEntry } from './normalizeIdGroups.js';

export type { PromptEntry };

export interface ExtractResult {
  prompts: PromptEntry[];
}

export { normalizeIdGroups } from './normalizeIdGroups.js';
export default function extractStrings(
  filepath: string,
  minLength?: number
): ExtractResult;
