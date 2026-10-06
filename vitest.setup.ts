import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// The prompt extractor's site cache defaults to the user's cache dir; a test
// must never read or write it.
const extractCacheDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'tweakcc-test-extract-cache-')
);
process.env.TWEAKCC_EXTRACT_CACHE_DIR = extractCacheDir;
afterAll(() => {
  fs.rmSync(extractCacheDir, { recursive: true, force: true });
});

// Tests must never touch the network: a real request makes timing depend on
// DNS/TLS and fails offline. Plain assignment (not vi.stubGlobal) so an
// unstubGlobals setting cannot restore the real fetch.
globalThis.fetch = (input: string | URL | Request): Promise<Response> =>
  Promise.reject(
    new Error(
      `network is disabled in tests; mock fetch (requested ${String(
        input instanceof Request ? input.url : input
      )})`
    )
  );
