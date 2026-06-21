import { getAllPatchDefinitions } from './patches/index';

export type PatchFilterResult =
  | { ok: true; filter: string[] | null }
  | { ok: false; error: string };

/**
 * Resolve and validate a comma-separated `--patches` argument against the known
 * patch IDs.
 *
 * The apply path matches the filter by inclusion, so an unknown ID (a typo)
 * would silently match nothing — the patch the caller meant to apply is skipped
 * with no warning. Agents drive `--patches` at showtime, so this validates
 * up-front and fails fast instead.
 *
 * @returns `{ filter }` with the cleaned IDs (or null = apply all), or an
 *   `{ error }` describing an unknown / empty filter.
 */
export function resolvePatchFilter(
  patchesArg: string | undefined | null
): PatchFilterResult {
  if (!patchesArg) return { ok: true, filter: null };

  const requested = patchesArg
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  if (requested.length === 0) {
    return {
      ok: false,
      error: '--patches was provided but contained no patch IDs.',
    };
  }

  const validIds = new Set<string>(getAllPatchDefinitions().map(d => d.id));
  const unknown = requested.filter(id => !validIds.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `unknown patch ID(s) in --patches: ${unknown.join(', ')}`,
    };
  }

  return { ok: true, filter: requested };
}
