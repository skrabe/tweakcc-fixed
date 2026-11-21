import { describe, expect, it } from 'vitest';
import { heapPlan } from './heapLimit';

const base = {
  limitMb: 4144,
  totalMemMb: 32768,
  execArgv: [] as string[],
  nodeOptions: '',
  alreadyReexeced: false,
};

describe('heapPlan', () => {
  it('raises a default 4 GB heap to 8 GB on a large machine', () => {
    expect(heapPlan(base)).toBe(8192);
  });

  it('caps the target at three quarters of physical memory', () => {
    expect(heapPlan({ ...base, totalMemMb: 8192 })).toBe(6144);
  });

  it('leaves a heap that is already large enough alone', () => {
    expect(heapPlan({ ...base, limitMb: 8240 })).toBeNull();
    expect(heapPlan({ ...base, totalMemMb: 4096 })).toBeNull();
  });

  it('respects a heap size the caller chose', () => {
    expect(
      heapPlan({ ...base, nodeOptions: '--max-old-space-size=4096' })
    ).toBeNull();
    expect(
      heapPlan({ ...base, execArgv: ['--max-old-space-size=3000'] })
    ).toBeNull();
  });

  it('never re-executes twice', () => {
    expect(heapPlan({ ...base, alreadyReexeced: true })).toBeNull();
  });
});
