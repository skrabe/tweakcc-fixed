import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import type { StringsFile } from './systemPromptSync';
import { PROMPT_CACHE_DIR } from './config';

// Resolve the repo-local data/prompts/ directory by walking up from this
// module's location. Lets a fork that ships its own prompt JSONs (e.g.
// tweakcc-fixed shipping a same-day prompts-X.Y.Z.json before upstream
// publishes one) skip the network fetch when run via `node dist/index.mjs`.
// Published npm builds strip data/ via .npmignore, so this returns null
// for those installs and the network path takes over.
function findRepoPromptsDir(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'data', 'prompts');
      const pkg = path.join(dir, 'package.json');
      if (fsSync.existsSync(pkg) && fsSync.existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url unavailable in unusual runtimes
  }
  return null;
}

/**
 * Downloads the strings file for a given CC version from GitHub
 * Checks cache first, then any repo-local data/prompts/ shipped alongside
 * this dist (forks may carry same-day JSONs upstream hasn't published yet),
 * then the upstream URL.
 * @param version - Version string in format "X.Y.Z" (e.g., "2.0.30")
 * @returns Promise that resolves to the parsed JSON content
 */
export async function downloadStringsFile(
  version: string
): Promise<StringsFile> {
  // Check cache first
  const cacheFilePath = path.join(PROMPT_CACHE_DIR, `prompts-${version}.json`);
  try {
    const cachedContent = await fs.readFile(cacheFilePath, 'utf-8');
    const cached = JSON.parse(cachedContent) as StringsFile;
    return cached;
  } catch {
    // Cache miss or invalid - try repo-local fallback before hitting network.
  }

  // Repo-local data/prompts fallback (only resolves for `node dist/...`
  // invocations against a checked-out repo).
  const repoDir = findRepoPromptsDir();
  if (repoDir) {
    const localPath = path.join(repoDir, `prompts-${version}.json`);
    try {
      const localContent = await fs.readFile(localPath, 'utf-8');
      return JSON.parse(localContent) as StringsFile;
    } catch {
      // Repo doesn't have this version either - fall through to network.
    }
  }

  // Construct the GitHub raw URL
  const url = `https://raw.githubusercontent.com/Piebald-AI/tweakcc/refs/heads/main/data/prompts/prompts-${version}.json`;

  try {
    // Fetch the file from GitHub
    const response = await fetch(url);

    if (!response.ok) {
      // Provide specific error messages for common HTTP errors
      let errorMessage: string;
      if (response.status === 429) {
        errorMessage =
          'Rate limit exceeded. GitHub has temporarily blocked requests. Please wait a few minutes and try again.';
      } else if (response.status === 404) {
        errorMessage = `Prompts file not found for Claude Code v${version}. This version was released within the past day or so and will be supported within a few hours.`;
      } else if (response.status >= 500) {
        errorMessage = `GitHub server error (${response.status}). Please try again later.`;
      } else {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }

      // Just throw the error - it will be caught and displayed by the caller
      throw new Error(errorMessage);
    }

    // Parse JSON directly
    const jsonData = (await response.json()) as StringsFile;

    // Save to cache
    try {
      await fs.mkdir(PROMPT_CACHE_DIR, { recursive: true });
      await fs.writeFile(
        cacheFilePath,
        JSON.stringify(jsonData, null, 2),
        'utf-8'
      );
    } catch (cacheError) {
      console.warn(
        `Failed to write to cache to ${cacheFilePath}: ${cacheError}`
      );
    }

    return jsonData;
  } catch (error) {
    if (error instanceof Error) {
      // If it's already our custom error with the message displayed, re-throw it
      if (
        error.message.includes('Rate limit') ||
        error.message.includes('not found') ||
        error.message.includes('server error') ||
        error.message.includes('HTTP')
      ) {
        throw error;
      }
      // Otherwise wrap it and throw
      const wrappedMessage = `Failed to download prompts for version ${version}: ${error.message}`;
      throw new Error(wrappedMessage);
    }
    throw error;
  }
}

/**
 * Downloads strings files for multiple versions
 * @param versions - Array of version strings
 * @returns Promise that resolves to a map of version to parsed JSON content
 */
export async function downloadMultipleStringsFiles(
  versions: string[]
): Promise<Map<string, StringsFile>> {
  const results = new Map<string, StringsFile>();

  for (const version of versions) {
    try {
      const data = await downloadStringsFile(version);
      results.set(version, data);
    } catch (error) {
      console.error(`Failed to download version ${version}:`, error);
      // Continue with other versions
    }
  }

  return results;
}
