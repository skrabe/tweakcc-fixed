import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Golden lock over the extractor's output for a pinned, in-matrix CC version.
// The committed prompts-X.Y.Z.json IS the extractor's output; pinning a digest
// of it means a future version bump cannot silently drop, rename, or re-shape a
// prompt (or the human-readable identifier surface that overrides bind to)
// without this snapshot flipping in review.
const PINNED_VERSION = '2.1.169';

type Prompt = {
  name: string;
  id: string;
  description?: string;
  pieces: string[];
  identifiers: (number | string)[];
  identifierMap?: Record<string, string>;
  version?: string;
};

const promptsFile = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        `../../data/prompts/prompts-${PINNED_VERSION}.json`,
        import.meta.url
      )
    ),
    'utf8'
  )
) as { version: string; prompts: Prompt[] };

describe(`prompts golden — ${PINNED_VERSION}`, () => {
  const { prompts } = promptsFile;

  it('pins the bundle version', () => {
    expect(promptsFile.version).toBe(PINNED_VERSION);
  });

  it('every prompt has the expected structural shape', () => {
    for (const p of prompts) {
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.name).toBe('string');
      expect(Array.isArray(p.pieces)).toBe(true);
      expect(Array.isArray(p.identifiers)).toBe(true);
      if (p.identifierMap !== undefined) {
        expect(typeof p.identifierMap).toBe('object');
      }
    }
  });

  it('matches the pinned structural digest', () => {
    const ids = prompts.map(p => p.id);
    const uniqueIds = [...new Set(ids)].sort();

    // Ids that occur more than once (the extractor emits a few; locked here so
    // a change in the multiplicity is visible rather than silent).
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    const duplicateIds = [...counts]
      .filter(([, c]) => c > 1)
      .map(([id]) => id)
      .sort();

    // Prompts that reference an identifier index with no identifierMap entry —
    // these reconstruct as UNKNOWN_<idx>. Pinned so the set can only change
    // deliberately (see the inventory note on candidate extraction findings).
    const unmappedIdentifierPrompts = prompts
      .filter(p =>
        p.identifiers.some(idx => !(String(idx) in (p.identifierMap ?? {})))
      )
      .map(p => p.id)
      .sort();

    // The human-readable identifier surface that lobotomized overrides bind to.
    const identifierValues = [
      ...new Set(prompts.flatMap(p => Object.values(p.identifierMap ?? {}))),
    ].sort();

    const digest = {
      version: promptsFile.version,
      promptCount: prompts.length,
      uniqueIdCount: uniqueIds.length,
      idListSha256: createHash('sha256')
        .update(uniqueIds.join('\n'))
        .digest('hex'),
      duplicateIds,
      unmappedIdentifierPrompts,
      identifierValues,
    };

    expect(digest).toMatchSnapshot();
  });
});
