// Every workflow script under .claude/workflows must PARSE.
//
// On CC 2.1.238 two of nine scripts — `audit-new-prompts-stage1` and
// `audit-new-prompts-stage3-verify` — carried one extra `)` on their
// `parallel(groups.map(...))` line. Both threw `SyntaxError: Unexpected token
// ')'` before a single agent started. Nothing caught it earlier because
// `.claude/` is gitignored, so these scripts are unversioned, absent from CI,
// and exercised only when a bump actually runs them: stage 1 failed at the
// moment it was needed, and stage 3 would have failed AFTER stage 2 had already
// written files to disk.
//
// A parse check cannot see a wrong prompt or a bad barrier — `pipelineShape`
// and `retrySalvage` cover those for the scripts they name. This one covers the
// whole directory for the cheapest possible defect, which is the one that
// actually shipped. It skips cleanly when the directory is absent (a fresh
// clone, or CI) rather than failing on a file it cannot see.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const WF = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.claude/workflows'
);

const scripts = fs.existsSync(WF)
  ? fs.readdirSync(WF).filter(f => f.endsWith('.js')).sort()
  : [];

describe('.claude/workflows scripts parse', () => {
  it.skipIf(!scripts.length)('finds at least one workflow script', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  for (const file of scripts) {
    it(`${file} parses`, () => {
      const src = fs.readFileSync(path.join(WF, file), 'utf8');
      // The runner injects its globals and awaits the body, so wrap the same
      // way it does — a bare parse would reject top-level `await`.
      const wrapped =
        '(async()=>{' + src.replace(/^export const meta/m, 'const meta') + '})()';
      expect(() => new vm.Script(wrapped, { filename: file })).not.toThrow();
    });

    it(`${file} declares a literal meta with a name`, () => {
      const src = fs.readFileSync(path.join(WF, file), 'utf8');
      // `meta` must be a pure literal — the control plane reads it without
      // executing the script, so an interpolated value is silently lost.
      const m = src.match(/^export const meta = \{[\s\S]*?\n\};?/m);
      expect(m, `${file}: no top-level "export const meta = {…}"`).toBeTruthy();
      expect(m[0]).toMatch(/name:\s*'[^']+'|name:\s*"[^"]+"/);
      expect(m[0], `${file}: meta must not interpolate`).not.toMatch(/\$\{/);
    });
  }
});
