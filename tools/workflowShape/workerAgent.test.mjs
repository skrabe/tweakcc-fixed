// The rules every content agent needs live once, in the showtime-worker agent
// definition (its system prompt), instead of in every workflow's task text. A
// rule that silently drops out of it still yields well-formed output, so only
// a test that reads the file sees it. Skips when .claude/agents is absent.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.claude/agents/showtime-worker.md');
const has = fs.existsSync(FILE);

describe.skipIf(!has)('showtime-worker carries the shared prompt-content rules', () => {
  it('declares the lean agent type', () => {
    const s = fs.readFileSync(FILE, 'utf8');
    expect(s).toMatch(/^---\nname: showtime-worker\n/);
    expect(s).toContain('omitClaudeMd: true');
  });

  it('keeps every shared rule', () => {
    const s = fs.readFileSync(FILE, 'utf8');
    for (const rule of [
      'all parts in ONE message of Read calls',
      'Never python, grep, cat or slice the 40 MB bundle',
      'Run the checker the task names until its first line reads PASS',
      '**Tripwire.** A pristine sentence is FROZEN, verbatim-or-delete',
      'never reword, compress, merge, reorder or cut part of it',
      'is mechanics: reproduce it verbatim if kept',
      'quotedElsewhere, rewriteNeedles, predicateRuns',
      'If `externalRefs.rewriteReplacement` is true',
      'If the body `opensWithSlot`',
      'for the literal AND for the const it is built from',
      'Coverage is real only if the carrier renders in the same request.',
      'An alternative arm (the other branch of a ternary, a constant chosen instead) never co-renders.',
      "whose tool is in the turnProbe capture's `tools[]`",
      'A DEFERRED tool (`shouldDefer:!0`, absent from `tools[]`)',
      'its description and its own parameter schema still co-render with each other',
      'the coverage is about to evaporate',
      'Opus-5.5-Card-Digest.md',
      'Fable-5.2-Card-Digest.md',
      'disuse alone is a trim reason, never a wipe reason',
      'except in taste prompts',
      'never cut a sentence a kept sentence refers back to',
      'Preserve every identifierMap slot at least once in a trim',
      'write around each `${…}` slot, never inside',
      "Match the file's escaping",
      'An empty body is a deliberate suppression: leave it empty.',
      'a sentence crossing the boundary is cut whole across both ids or not at all',
      'Re-derive pristine from the prompts JSON entry (id and piece) or a bundle byte offset',
    ]) expect(s, rule).toContain(rule);
  });
});
