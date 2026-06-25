import * as fs from 'node:fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { StringsFile, reconstructContentFromPieces } from './systemPromptSync';
import { CONFIG_DIR } from './config';
import { debug } from './utils';

/**
 * Gets the path to the system prompt hash index file
 */
const getHashIndexPath = (): string => {
  return path.join(CONFIG_DIR, 'systemPromptOriginalHashes.json');
};

/**
 * Gets the path to the system prompt applied hashes file
 * This tracks which hash was last applied to cli.js for each prompt
 */
const getAppliedHashesPath = (): string => {
  return path.join(CONFIG_DIR, 'systemPromptAppliedHashes.json');
};

/**
 * Structure of the hash index
 * Maps: "prompt-id-version" => "md5hash"
 * Example: "main-system-prompt-2.0.14" => "a1b2c3..."
 */
export interface HashIndex {
  [key: string]: string;
}

/**
 * Generates a hash key for a prompt
 * Format: "{promptId}-{version}"
 */
export const getHashKey = (promptId: string, version: string): string => {
  return `${promptId}-${version}`;
};

/**
 * Computes the MD5 hash of a string (after trimming leading/trailing whitespace)
 */
export const computeMD5Hash = (content: string): string => {
  return crypto.createHash('md5').update(content.trim(), 'utf8').digest('hex');
};

// Both indexes are regenerable caches. Read resiliently (missing OR corrupt JSON
// -> empty, so a truncated/hand-edited index rebuilds instead of crashing the
// tool, cf. F-69 for config), and write atomically (temp + rename, so a crash
// mid-write can't truncate the index, cf. F-72 for backups).
const readJsonIndexFile = async <T extends object>(
  filePath: string
): Promise<T> => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {} as T;
    }
    if (error instanceof SyntaxError) {
      debug(`${filePath} was not valid JSON — ignoring it and rebuilding.`);
      return {} as T;
    }
    throw error;
  }
};

const writeJsonIndexFileAtomic = async (
  filePath: string,
  index: Record<string, unknown>
): Promise<void> => {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  // Sort keys for consistent formatting.
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(index).sort()) sorted[key] = index[key];
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(sorted, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
  } catch (error) {
    try {
      await fs.unlink(tmp);
    } catch {
      // best-effort temp cleanup; ignore
    }
    throw error;
  }
};

/**
 * Reads the hash index from disk. Returns empty object if the file is missing
 * or corrupt (it's a regenerable cache).
 */
export const readHashIndex = async (): Promise<HashIndex> =>
  readJsonIndexFile<HashIndex>(getHashIndexPath());

/**
 * Writes the hash index to disk (atomically).
 */
export const writeHashIndex = async (index: HashIndex): Promise<void> =>
  writeJsonIndexFileAtomic(getHashIndexPath(), index);

/**
 * Main utility function: Takes the entire contents of a strings-x.y.z.json file
 * and inserts all the hashes that aren't already in the index.
 *
 * @param stringsFile - The parsed strings file (from downloadStringsFile or similar)
 * @returns The number of new hashes added
 */
export const storeHashes = async (
  stringsFile: StringsFile
): Promise<number> => {
  const index = await readHashIndex();
  let newHashCount = 0;

  for (const prompt of stringsFile.prompts) {
    const hashKey = getHashKey(prompt.id, prompt.version);

    // Only compute and store if not already present
    if (!index[hashKey]) {
      const content = reconstructContentFromPieces(
        prompt.pieces,
        prompt.identifiers,
        prompt.identifierMap
      );
      const hash = computeMD5Hash(content);
      index[hashKey] = hash;
      newHashCount++;
    }
  }

  // Write back to disk
  await writeHashIndex(index);

  return newHashCount;
};

/**
 * Gets the hash for a specific prompt version from the index
 * Returns undefined if not found
 */
export const getPromptHash = async (
  promptId: string,
  version: string
): Promise<string | undefined> => {
  const index = await readHashIndex();
  const hashKey = getHashKey(promptId, version);
  return index[hashKey];
};

/**
 * Structure of the applied hashes file
 * Maps: "prompt-id" => "md5hash" | null
 * Example: "main-system-prompt" => "a1b2c3..." or null if not applied/defaults restored
 */
export interface AppliedHashIndex {
  [promptId: string]: string | null;
}

/**
 * Reads the applied hashes index from disk. Returns empty object if file doesn't exist.
 */
export const readAppliedHashIndex = async (): Promise<AppliedHashIndex> =>
  readJsonIndexFile<AppliedHashIndex>(getAppliedHashesPath());

/**
 * Writes the applied hashes index to disk
 */
export const writeAppliedHashIndex = async (
  index: AppliedHashIndex
): Promise<void> => writeJsonIndexFileAtomic(getAppliedHashesPath(), index);

export const setAppliedHashes = async (
  updates: Record<string, string>
): Promise<void> => {
  if (Object.keys(updates).length === 0) return;
  const index = await readAppliedHashIndex();
  for (const [promptId, hash] of Object.entries(updates)) {
    index[promptId] = hash;
  }
  await writeAppliedHashIndex(index);
};

/**
 * Sets all applied hashes to null (used when restoring defaults)
 */
export const clearAllAppliedHashes = async (): Promise<void> => {
  const index = await readAppliedHashIndex();
  const clearedIndex: AppliedHashIndex = {};

  // Set all existing entries to null
  for (const key of Object.keys(index)) {
    clearedIndex[key] = null;
  }

  await writeAppliedHashIndex(clearedIndex);
};

/**
 * Checks if any system prompts have been modified since they were last applied.
 * Compares the current hash of each prompt file with the hash stored in systemPromptAppliedHashes.json.
 *
 * @param systemPromptsDir - Path to the system prompts directory
 * @returns true if any prompts have been modified, false otherwise
 */
export const hasUnappliedSystemPromptChanges = async (
  systemPromptsDir: string
): Promise<boolean> => {
  try {
    const appliedHashes = await readAppliedHashIndex();

    // If there are no applied hashes yet, nothing has been applied so no changes to track
    if (Object.keys(appliedHashes).length === 0) {
      return false;
    }

    // Read all .md files in the system prompts directory
    const files = await fs.readdir(systemPromptsDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    for (const file of mdFiles) {
      const promptId = file.replace('.md', '');
      const appliedHash = appliedHashes[promptId];

      // If this prompt doesn't have an applied hash entry, skip it
      if (appliedHash === undefined) {
        continue;
      }

      // If the applied hash is null (restored to defaults), skip comparison
      if (appliedHash === null) {
        continue;
      }

      // Read the current file and compute its hash
      const filePath = path.join(systemPromptsDir, file);
      const fileContent = await fs.readFile(filePath, 'utf8');

      // Parse the markdown to extract just the content (excluding frontmatter)
      const matter = await import('gray-matter');
      const parsed = matter.default(fileContent, {
        delimiters: ['<!--', '-->'],
      });
      const currentHash = computeMD5Hash(parsed.content);

      // If the current hash doesn't match the applied hash, changes have been made
      if (currentHash !== appliedHash) {
        return true;
      }
    }

    return false;
  } catch (error) {
    // If we can't read the directory or files, assume no changes
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};
