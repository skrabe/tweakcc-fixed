import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import type { StringsFile } from './systemPromptSync';
import { PROMPT_CACHE_DIR } from './config';
import { TWEAKCC_VERSION } from './packageMeta';
import { readResponseTextCapped } from './utils';

// Cap the prompts-JSON fetch so a hung / blackholed connection (captive portal,
// firewall sinkhole) falls back to the cache below instead of stalling --apply
// forever. The catch block already treats a timeout as a network failure and
// serves the cache, but without this cap that path was unreachable.
const PROMPTS_FETCH_TIMEOUT_MS = 20_000;

// Resolve the repo-local data/prompts/ directory by walking up from this
// module's location. Lets a fork that ships its own prompt JSONs (e.g.
// tweakcc-fixed shipping a same-day prompts-X.Y.Z.json before upstream
// publishes one) skip the network fetch when run via `node dist/index.mjs`.
// Published npm builds strip data/ via .npmignore, so this returns null
// for those installs and the network path takes over.
export function findRepoPromptsDir(): string | null {
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
 * Pick the newest version among a set of prompts filenames. Matches the repo's
 * prompts-file idiom (`prompts-X.Y.Z.json`), keeps each captured version, and
 * orders them with a numeric-aware locale compare so 2.1.10 sorts after 2.1.9
 * (a plain lexicographic sort would put 2.1.9 last).
 *
 * @param fileNames - Directory entry names to scan (order irrelevant)
 * @returns The newest "X.Y.Z" version, or null when none match
 */
export function latestPromptsVersion(fileNames: string[]): string | null {
  const versions = fileNames
    .map(name => /^prompts-(\d+\.\d+\.\d+)\.json$/.exec(name)?.[1])
    .filter((v): v is string => v !== undefined)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.at(-1) ?? null;
}

/**
 * The newest Claude Code version the prompt data on disk covers, or null when
 * there is no data/prompts to read (a published npm install, whose tarball
 * ships none).
 *
 * This is the same resolution the repo's own tools use for their default
 * version argument (`arg('--json') ?? newestPromptsJson()` in
 * checkOutputContracts, and the equivalent in auditMisbinds,
 * auditCallSlots and checkEscaperWrappers): read the directory, keep the
 * `prompts-X.Y.Z.json` entries, take the numerically newest.
 */
export function newestLocalPromptsVersion(): string | null {
  const repoDir = findRepoPromptsDir();
  if (!repoDir) return null;
  try {
    return latestPromptsVersion(fsSync.readdirSync(repoDir));
  } catch {
    return null;
  }
}

/**
 * Which Claude Code version to fetch prompts for, in order of what each source
 * actually knows.
 *
 * An explicit argument is the caller's own decision and settles it.
 *
 * Otherwise the release's declared version wins, because the question a caller
 * asks with no argument is which Claude Code this build can patch, and that is
 * a fact about the patch code. Prompt data cannot answer it: the data and the
 * code move independently, a prompts commit landing before the release able to
 * patch what it describes, so the newest file on disk can name a version whose
 * shape this build does not match. Getting that wrong in the generous
 * direction is the costly one, since it installs a Claude Code that `--apply`
 * then fails on, while the cautious answer merely installs an older one that
 * works.
 *
 * The prompt data answers only when no declaration exists, which is a checkout
 * from before the field. A published install has neither and passes a version.
 *
 * @param localNewest Deferred, so the directory is read only when reached.
 */
export function resolveFetchVersion(
  requested: string | undefined,
  declared: string | undefined,
  localNewest: () => string | null
): string | null {
  return requested ?? declared ?? localNewest();
}

/**
 * Downloads the strings file for a given CC version from GitHub.
 *
 * Resolution order: repo-local data/prompts/ (when running from a checkout)
 * → user cache → network. Repo-local wins because a fork's locally-extracted
 * JSON is more authoritative than whatever was network-fetched into cache on
 * a previous run (which may be upstream's published version, not the fork's).
 * For npm-installed runs (no repo dir), order is cache → network.
 *
 * @param version - Version string in format "X.Y.Z" (e.g., "2.0.30")
 * @returns Promise that resolves to the parsed JSON content
 */
export async function downloadStringsFile(
  version: string
): Promise<StringsFile> {
  // Repo-local data/prompts wins when present (checked-out fork running
  // `node dist/...` should always use its own JSON, not whatever the user
  // happened to have cached from a prior network fetch).
  const repoDir = findRepoPromptsDir();
  if (repoDir) {
    const localPath = path.join(repoDir, `prompts-${version}.json`);
    try {
      const localContent = await fs.readFile(localPath, 'utf-8');
      return JSON.parse(localContent) as StringsFile;
    } catch {
      // Repo doesn't have this version - fall through to cache/network.
    }
  }

  // User cache (npm-installed runs that have no repo dir). The cache key is
  // version-only, so a blind cache-first read would mask an in-place correction
  // to an already-released prompts JSON (the same version is re-published with
  // fixed maps) — serving a stale map forever. So prefer the network for
  // freshness below and fall back to this cache only when the network is
  // unreachable / rate-limited, which keeps offline applies working without
  // ever serving a known-stale map.
  const cacheFilePath = path.join(PROMPT_CACHE_DIR, `prompts-${version}.json`);
  const readCache = async (): Promise<StringsFile | null> => {
    try {
      return JSON.parse(
        await fs.readFile(cacheFilePath, 'utf-8')
      ) as StringsFile;
    } catch {
      return null;
    }
  };

  // Construct the GitHub raw URL. This MUST point at the fork's own repo: the
  // npm tarball ships no data/, so npx installs resolve prompts JSONs from
  // here — upstream's JSONs use different naming conventions and would
  // silently mis-pair with this fork's overrides.
  //
  // The REF is this build's own release tag, so an npm install reads the bytes
  // that were committed when it was published — the same bytes a clone at that
  // tag reads from disk. `package.json` already knows which release this is,
  // and addressing the tag is what makes that knowledge reach the data.
  //
  // A tag cannot carry a Claude Code release that came after it, which is the
  // one case the tag legitimately has nothing to say about. `main` answers it,
  // exactly as it answers the same miss for a clone whose `data/prompts` stops
  // at its own commit. So the order here is the clone's order: this release's
  // own data first, then whatever is current.
  const tagUrl = `https://raw.githubusercontent.com/skrabe/tweakcc-fixed/refs/tags/v${TWEAKCC_VERSION}/data/prompts/prompts-${version}.json`;
  const mainUrl = `https://raw.githubusercontent.com/skrabe/tweakcc-fixed/refs/heads/main/data/prompts/prompts-${version}.json`;

  // A 404 on the tag means only "not in this release", so it advances to the
  // next candidate. Every other status is reported against the URL that
  // produced it — retrying a rate limit or a 5xx would only spend the second
  // request reaching the same answer.
  const candidates = [tagUrl, mainUrl];

  try {
    let response!: Response;
    let url!: string;
    for (let i = 0; i < candidates.length; i++) {
      url = candidates[i];
      response = await fetch(url, {
        signal: AbortSignal.timeout(PROMPTS_FETCH_TIMEOUT_MS),
      });
      if (response.status === 404 && i < candidates.length - 1) continue;
      break;
    }

    if (!response.ok) {
      // Network reachable but no usable body — serve the cache if we have one
      // (e.g. a transient 429/5xx shouldn't break an apply that has a cache).
      const cached = await readCache();
      if (cached) return cached;

      // Provide specific error messages for common HTTP errors
      let errorMessage: string;
      if (response.status === 429) {
        errorMessage =
          'Rate limit exceeded. GitHub has temporarily blocked requests. Please wait a few minutes and try again.';
      } else if (response.status === 404) {
        errorMessage = `Prompts file not found for Claude Code v${version}. The fork's version-bump pipeline hasn't published prompts for this release yet — check https://github.com/skrabe/tweakcc-fixed for status.`;
      } else if (response.status >= 500) {
        errorMessage = `GitHub server error (${response.status}). Please try again later.`;
      } else {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }

      // Just throw the error - it will be caught and displayed by the caller
      throw new Error(errorMessage);
    }

    // Parse JSON (capped read — the prompts JSON is ~2 MB; the 32 MB default is
    // generous while preventing a runaway body from a compromised/transient host).
    const jsonData = JSON.parse(
      await readResponseTextCapped(response)
    ) as StringsFile;

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
    // Network unreachable (DNS / offline / timeout): the cache is the resilient
    // fallback. (HTTP-status errors already tried the cache above; if we reach
    // here from one of those, there was no cache and this read returns null.)
    const cached = await readCache();
    if (cached) return cached;
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
