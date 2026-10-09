import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMatcherDifferential } from './matcherDifferential.mjs';

const PROMPT = 'Report the zebra-quartz marker exactly once.';
const BEFORE = 'var v="9.9.9";\nvar s="nothing to see";\n';
const AFTER = `var v="9.9.9";\nvar s="${PROMPT}";\n`;

let dir;
let promptsFile;
let bundle;
let cacheDir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matcher-diff-test-'));
  promptsFile = path.join(dir, 'prompts-9.9.9.json');
  fs.writeFileSync(
    promptsFile,
    JSON.stringify({
      version: '9.9.9',
      prompts: [{ id: 'p', name: 'P', pieces: [PROMPT], identifiers: [] }],
    })
  );
  bundle = path.join(dir, 'cli.js');
  fs.writeFileSync(bundle, BEFORE);
  cacheDir = path.join(dir, 'cache');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = (opts = {}) =>
  runMatcherDifferential({
    promptsFile,
    bundles: [bundle],
    workers: 1,
    cacheDir,
    log: () => {},
    ...opts,
  });

describe('matcher differential runner', () => {
  it('checks and caches the bytes it hashed, not a rewrite', async () => {
    // A concurrent --apply rewrites the pristine copy between the runner
    // hashing the bundle (the cache key) and the workers checking it.
    const raced = await run({
      log: line => {
        if (/to check$/.test(line)) fs.writeFileSync(bundle, AFTER);
      },
    });
    expect(fs.readFileSync(bundle, 'utf8')).toBe(AFTER);
    expect(raced.targets[0]).toMatchObject({ checked: 1, exercised: 0 });

    // The cache for BEFORE's hash must not hold AFTER's verdict.
    fs.writeFileSync(bundle, BEFORE);
    const again = await run();
    expect(again.targets[0]).toMatchObject({
      cached: 1,
      checked: 1,
      exercised: 0,
    });

    // The prompt does match AFTER, so the race above was observable.
    fs.writeFileSync(bundle, AFTER);
    const after = await run();
    expect(after.targets[0]).toMatchObject({ cached: 0, exercised: 1 });
  }, 60_000);

  it('rejects a worker count below one instead of hanging', async () => {
    for (const workers of [-1, 0, 1.5, Number.NaN]) {
      const settled = await Promise.race([
        run({ workers }).then(
          () => 'resolved',
          err => err
        ),
        new Promise(resolve => setTimeout(() => resolve('hung'), 15_000)),
      ]);
      expect(settled).toBeInstanceOf(RangeError);
      expect(String(settled)).toMatch(/workers must be a positive integer/);
    }
  }, 90_000);
});
