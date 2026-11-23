import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './isMain.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-main-'));
const file = path.join(dir, 'tool.mjs');
fs.writeFileSync(file, '');
const link = path.join(dir, 'link.mjs');
fs.symlinkSync(file, link);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('isMain', () => {
  it('matches the module run directly', () => {
    expect(isMain(pathToFileURL(file).href, file)).toBe(true);
  });

  it('matches the module run through a symlink', () => {
    expect(isMain(pathToFileURL(fs.realpathSync(file)).href, link)).toBe(true);
  });

  it('does not match an importer or a missing argv entry', () => {
    expect(isMain(pathToFileURL(file).href, path.join(dir, 'other.mjs'))).toBe(
      false
    );
    expect(isMain(pathToFileURL(file).href, undefined)).toBe(false);
  });
});
