// Locks the three CC 2.1.267 cases the stage-1 audit proposed to cut: a label
// another prompt points the reader at, a rewrite-table needle, and a body that
// opens with a slot a detector keys on.
import { describe, it, expect } from 'vitest';
import { externalRefs, literalRuns } from './externalRefs.mjs';

const BLOCKED =
  "SECURITY WARNING: auto mode blocked this subagent's report. Reason: ${}. The report follows; review the subagent's actions carefully before acting on it.";
const FLAGGED =
  'This agent\'s report was delivered to you as a message from "${}" (its ${} call), under a SECURITY WARNING from auto mode — the warning above the report says why.';
const WRITES =
  "write_db with db_op 'batch' only: the writes to apply together. Prefer it over separate write_db calls whenever you write more than a couple of documents.";

const corpus = new Map([
  ['blocked', BLOCKED],
  ['flagged', FLAGGED],
  ['writes', WRITES],
]);

describe('externalRefs', () => {
  it('lists a CAPS label that another prompt names', () => {
    const r = externalRefs({ id: 'blocked', bodies: [BLOCKED], corpus });
    expect(r.quotedElsewhere).toEqual([
      { text: 'SECURITY WARNING', by: ['flagged'] },
    ]);
  });

  it('ignores a label no other prompt names', () => {
    const r = externalRefs({ id: 'writes', bodies: [WRITES], corpus });
    expect(r.quotedElsewhere).toEqual([]);
  });

  it('lists rewrite-table needles the body contains', () => {
    const r = externalRefs({
      id: 'writes',
      bodies: [WRITES],
      corpus,
      needles: ['separate write_db calls', 'Required for db_op'],
    });
    expect(r.rewriteNeedles).toEqual(['separate write_db calls']);
  });

  it('flags a body that opens with a slot', () => {
    const body =
      '${}: when your work is complete, call ${}({message: <your full report>}) and then stop.';
    expect(
      externalRefs({ id: 'x', bodies: [body], corpus }).opensWithSlot
    ).toBe(true);
    expect(
      externalRefs({ id: 'blocked', bodies: [BLOCKED], corpus }).opensWithSlot
    ).toBe(false);
  });

  it('finds a literal run the bundle passes to startsWith', () => {
    const src =
      'if(e.startsWith("<command-name>/loop</command-name>"))return!0;';
    const r = externalRefs({
      id: 'loop',
      bodies: ['<command-name>/loop</command-name>'],
      corpus,
      src,
    });
    expect(r.predicateRuns).toEqual(['<command-name>/loop</command-name>']);
  });

  it('flags a body that is the replacement half of a rewrite pair (CC 2.1.269)', () => {
    const body = 'one the person can open, in their organization';
    const r = externalRefs({
      id: 'replacement',
      bodies: [body],
      corpus,
      replacements: [
        body,
        'publish with `asset: true`, in place of `file_path`:',
      ],
    });
    expect(r.rewriteReplacement).toBe(true);
    expect(
      externalRefs({ id: 'x', bodies: [WRITES], corpus, replacements: [body] })
        .rewriteReplacement
    ).toBe(false);
  });

  it('splits literal runs on slots, keeping each run as written', () => {
    expect(literalRuns('Reason: ${a}. The report follows here.')).toEqual([
      '. The report follows here.',
    ]);
  });
});
