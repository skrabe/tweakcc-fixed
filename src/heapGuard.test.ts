import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:v8', () => ({
  getHeapStatistics: () => ({ heap_size_limit: Number.MAX_SAFE_INTEGER }),
}));

const { shouldRaiseHeap, HEAP_RAISED_ENV, TARGET_HEAP_MB } = await import(
  './heapGuard'
);

const MB = 1024 * 1024;
const defaultLimit = 4144 * MB;

describe('shouldRaiseHeap', () => {
  it('relaunches when the default heap is below the apply peak', () => {
    expect(shouldRaiseHeap(defaultLimit, {}, [])).toBe(true);
  });

  it('does not relaunch a process it already relaunched', () => {
    expect(shouldRaiseHeap(defaultLimit, { [HEAP_RAISED_ENV]: '1' }, [])).toBe(
      false
    );
  });

  it('does not relaunch when the heap is already large enough', () => {
    expect(shouldRaiseHeap(TARGET_HEAP_MB * MB, {}, [])).toBe(false);
  });

  it('respects a heap size the user chose on the command line', () => {
    expect(
      shouldRaiseHeap(defaultLimit, {}, ['--max-old-space-size=2048'])
    ).toBe(false);
  });

  it('respects a heap size the user chose in NODE_OPTIONS', () => {
    expect(
      shouldRaiseHeap(
        defaultLimit,
        { NODE_OPTIONS: '--enable-source-maps --max_old_space_size=3000' },
        []
      )
    ).toBe(false);
  });

  it('ignores unrelated NODE_OPTIONS', () => {
    expect(
      shouldRaiseHeap(
        defaultLimit,
        { NODE_OPTIONS: '--enable-source-maps' },
        []
      )
    ).toBe(true);
  });

  it('does not relaunch under Bun, where the heap flag has no effect', () => {
    expect(shouldRaiseHeap(defaultLimit, {}, [], true)).toBe(false);
  });

  it('does not relaunch a process started with a debugger attached', () => {
    expect(shouldRaiseHeap(defaultLimit, {}, ['--inspect-brk'])).toBe(false);
    expect(
      shouldRaiseHeap(defaultLimit, { NODE_OPTIONS: '--inspect=9230' }, [])
    ).toBe(false);
  });
});
