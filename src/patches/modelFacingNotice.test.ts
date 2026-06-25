// Guards the model-facing patch metadata that drives the `--apply` notice
// (printModelFacingNotice in src/index.tsx). The notice surfaces default-on
// behavioral patches so they are never applied silently — these assertions
// pin which patches count as model-facing and verify the filter the notice
// uses (applied && modelFacing).
import { describe, expect, it } from 'vitest';

import { getAllPatchDefinitions, PatchGroup, PatchResult } from './index';

const MODEL_FACING_IDS = [
  'fix-summarize-from-here',
  'fix-rewind-summary-header',
  'max-effort-default',
  'autonomous-operation-all-models',
  'auto-mode-classifier-model',
  'complexity-router',
  'dream-mode',
  'lean-memory-types',
  'suppress-deferred-tools',
  'claudemd-context-once-per-conversation',
];

describe('model-facing patch metadata', () => {
  const defs = getAllPatchDefinitions();
  const byId = new Map(defs.map(d => [d.id, d]));

  it('marks exactly the expected patches as model-facing', () => {
    const flagged = defs
      .filter(d => d.modelFacing)
      .map(d => d.id)
      .sort();
    expect(flagged).toEqual([...MODEL_FACING_IDS].sort());
  });

  it('leaves cosmetic / correctness-only patches unflagged', () => {
    // Pure output styling and tool-cap tweaks must not trip the behavioral
    // notice, or it becomes noise the user learns to ignore.
    for (const id of [
      'verbose-property',
      'thinking-block-styling',
      'statusline-update-throttle',
      'read-default-lines',
      'swap-ripgrep-for-fff',
    ] as const) {
      expect(byId.get(id)?.modelFacing).toBeFalsy();
    }
  });

  it('the notice filter selects only applied model-facing results', () => {
    const results: PatchResult[] = [
      {
        id: 'claudemd-context-once-per-conversation',
        name: 'claudeMd context: once per conversation',
        group: PatchGroup.SYSTEM_REMINDERS,
        applied: true,
        modelFacing: true,
      },
      {
        id: 'dream-mode',
        name: 'Dream mode',
        group: PatchGroup.FEATURES,
        applied: false, // not applied -> excluded
        modelFacing: true,
      },
      {
        id: 'verbose-property',
        name: 'Verbose property',
        group: PatchGroup.ALWAYS_APPLIED,
        applied: true, // applied but cosmetic -> excluded
        modelFacing: false,
      },
    ];

    const surfaced = results
      .filter(r => r.applied && r.modelFacing)
      .map(r => r.id);
    expect(surfaced).toEqual(['claudemd-context-once-per-conversation']);
  });
});
