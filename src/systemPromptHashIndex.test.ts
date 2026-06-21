import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { readHashIndex, writeHashIndex } from './systemPromptHashIndex';
import { createEnoent } from './tests/testHelpers';

// Auto-mock fs so the namespace is spy-able under ESM (mirrors config.test.ts).
vi.mock('node:fs/promises');

// Both hash indexes are regenerable caches: reads must tolerate a corrupt file
// (rebuild, not crash) and writes must be atomic (no truncation on a crash).
describe('systemPromptHashIndex persistence', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('readHashIndex rebuilds (returns {}) on a corrupt index instead of throwing', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue('{ not valid json');
    await expect(readHashIndex()).resolves.toEqual({});
  });

  it('readHashIndex returns {} when the file is missing', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(createEnoent());
    await expect(readHashIndex()).resolves.toEqual({});
  });

  it('readHashIndex parses a valid index', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(
      JSON.stringify({ 'main-1.0.0': 'abc123' })
    );
    await expect(readHashIndex()).resolves.toEqual({ 'main-1.0.0': 'abc123' });
  });

  it('writeHashIndex writes atomically (temp file then rename)', async () => {
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const writeSpy = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    const renameSpy = vi.spyOn(fs, 'rename').mockResolvedValue(undefined);

    await writeHashIndex({ 'b-2.0.0': 'h2' });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [tmpPath, content] = writeSpy.mock.calls[0];
    expect(String(tmpPath)).toContain('.tmp-');
    expect(JSON.parse(content as string)).toEqual({ 'b-2.0.0': 'h2' });
    // ...then renamed onto the real index path (the temp minus the .tmp suffix).
    const finalPath = String(tmpPath).replace(/\.tmp-\d+$/, '');
    expect(renameSpy).toHaveBeenCalledWith(tmpPath, finalPath);
  });
});
