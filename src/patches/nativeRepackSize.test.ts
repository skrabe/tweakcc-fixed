import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readContent, writeContent } from '../lib/content';
import type { Installation } from '../lib/types';

const PRISTINE = process.env.TWEAKCC_PRISTINE_BINARY;
const run = PRISTINE && fs.existsSync(PRISTINE) ? describe : describe.skip;

run('native repack size regression', () => {
  let scratch: string;
  let work: string;
  let pristineSize: number;

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-size-'));
    work = path.join(scratch, 'claude-copy');
    fs.copyFileSync(PRISTINE!, work);
    fs.chmodSync(work, 0o755);
    pristineSize = fs.statSync(work).size;
  });

  const inst = (): Installation => ({
    kind: 'native',
    path: work,
    version: '0.0.0',
  });

  it('grows the binary only by the injected-JS delta, not a whole blob copy', async () => {
    const { content, clearBytecode } = await readContent(inst());
    const patched = content + '\n// __tweakcc_size_test__\n';
    await writeContent(inst(), patched, clearBytecode);
    const afterApply = fs.statSync(work).size;

    const grewBy = afterApply - pristineSize;
    expect(grewBy).toBeGreaterThanOrEqual(0);
    expect(grewBy).toBeLessThan(8 * 1024 * 1024);
    expect(grewBy).toBeLessThan(pristineSize / 4);
  });

  it('does not accumulate across repeated write passes (downstream writer)', async () => {
    const sizeBefore = fs.statSync(work).size;
    const { content, clearBytecode } = await readContent(inst());
    await writeContent(inst(), content, clearBytecode);
    const sizeAfter = fs.statSync(work).size;
    expect(sizeAfter).toBe(sizeBefore);
  });

  it('returns to ~pristine size when the original JS is written back', async () => {
    const freshCopy = path.join(scratch, 'claude-fresh');
    fs.copyFileSync(PRISTINE!, freshCopy);
    fs.chmodSync(freshCopy, 0o755);
    const { content: pristineJs } = await readContent({
      kind: 'native',
      path: freshCopy,
      version: '0.0.0',
    });

    const { clearBytecode } = await readContent(inst());
    await writeContent(inst(), pristineJs, clearBytecode);
    const restored = fs.statSync(work).size;

    expect(Math.abs(restored - pristineSize)).toBeLessThan(1024 * 1024);
  });
});
