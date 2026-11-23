import { describe, expect, it } from 'vitest';
import { writeCompactionHighEffort } from './compactionHighEffort';

const BUNDLE =
  'st=await RR({promptMessages:[Je],cacheSafeParams:r,canUseTool:sit(),querySource:"compact",forkLabel:"reactive-compact",maxTurns:1,compactionRequestKind:y});' +
  'let At=await RR({promptMessages:[n],cacheSafeParams:y,canUseTool:sit(),querySource:"compact",forkLabel:"compact",maxTurns:1,compactionRequestKind:Y});' +
  'No=Y7t({options:{toolChoice:void 0,querySource:"compact",sendSideQueryBeta:s.sendSideQueryBeta,effortValue:Rg(s)}});' +
  'x=RR({querySource:"hook_prompt",forkLabel:"plugin_model_fork",maxTurns:J9n,pinnedEffort:H?void 0:w});';

describe('writeCompactionHighEffort', () => {
  it('pins high effort on both forks and the fallback request', () => {
    const out = writeCompactionHighEffort(BUNDLE)!;
    expect(out).toContain(
      'forkLabel:"reactive-compact",maxTurns:1,pinnedEffort:"high",compactionRequestKind:y'
    );
    expect(out).toContain(
      'forkLabel:"compact",maxTurns:1,pinnedEffort:"high",compactionRequestKind:Y'
    );
    expect(out).toContain(
      'querySource:"compact",hookEffortValue:"high",sendSideQueryBeta:s.sendSideQueryBeta,effortValue:Rg(s)'
    );
    expect(out).toContain('pinnedEffort:H?void 0:w');
    expect(out.match(/"high"/g)).toHaveLength(3);
  });

  it('is idempotent', () => {
    const once = writeCompactionHighEffort(BUNDLE)!;
    expect(writeCompactionHighEffort(once)).toBe(once);
  });

  it('fails when no compaction call is present', () => {
    expect(writeCompactionHighEffort('function x(){}')).toBeNull();
  });
});
