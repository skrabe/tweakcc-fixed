/**
 * Tests for the version-provenance assertion in versionBumpReport.cjs.
 *
 * Verifies that the script fails loud when the cli.js binary's embedded version
 * does not match the requested target version, and proceeds when they match.
 *
 * Runs versionBumpReport.cjs as a subprocess to exercise real process.exit()
 * behaviour and stderr output — not the internals.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPORT_SCRIPT = path.resolve(__dirname, '../tools/versionBumpReport.cjs');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vbr-test-'));
}

/** Write a minimal cli.js fixture that embeds the given version string. */
function writeCliFixture(dir: string, version: string): string {
  const p = path.join(dir, 'cli.js');
  fs.writeFileSync(p, `var t={VERSION:"${version}",other:"stuff"};`);
  return p;
}

/** Run versionBumpReport.cjs with the given args, returning exit code + stderr. */
function runReport(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [REPORT_SCRIPT, ...args], {
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

describe('versionBumpReport cli-version assertion', () => {
  it('exits non-zero with a binary-vs-target message when cli version does not match target', () => {
    const dir = makeTempDir();
    try {
      const cliPath = writeCliFixture(dir, '2.1.176');
      // Explicit target of 2.1.177 — binary embeds 2.1.176 → mismatch
      const { status, stderr } = runReport([
        '--cli',
        cliPath,
        '--new',
        '2.1.177',
        '--no-extract',
      ]);
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/2\.1\.176/);
      expect(stderr).toMatch(/2\.1\.177/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not fail due to the version assertion when cli version matches target', () => {
    const dir = makeTempDir();
    try {
      const cliPath = writeCliFixture(dir, '2.1.177');
      // Matching cli — assertion must pass; the script may still fail for
      // unrelated reasons (no old prompts data), but not with a version-mismatch
      // exit from the assertion block.
      const { stderr } = runReport([
        '--cli',
        cliPath,
        '--new',
        '2.1.177',
        '--no-extract',
      ]);
      // The mismatch message must NOT appear in stderr.
      expect(stderr).not.toMatch(/cli\.js version mismatch/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads as .cjs under the type:module tools package (ESM-CJS regression guard)', () => {
    // Invoking with --help must exit 0 and not throw a module-loader error.
    // This proves the file executes as CJS even though tools/package.json sets
    // "type": "module".
    const { status, stderr } = runReport(['--help']);
    expect(stderr).not.toMatch(/ERR_REQUIRE_ESM|SyntaxError|Cannot use import/);
    expect(status).toBe(0);
  });
});
