export interface PromptEntry {
  id: string;
  name?: string;
  description?: string;
  pieces: string[];
  identifiers: (number | string)[];
  identifierMap: Record<string, string>;
  version?: string;
  start: number;
  end: number;
}

export declare function normalizeIdGroups(
  prompts: PromptEntry[]
): PromptEntry[];
