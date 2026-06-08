import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Generalized guard for the themes-class bug (a writer reads `match[N]` from a
// regex whose Nth group is NON-capturing, so the value is undefined and the
// splice silently corrupts the binary — e.g. `hM3={...}` became `return{...}`,
// crashing /config). For every `const X = /regex/; const M = …match(X); M[N]`,
// the regex must have at least N capturing groups. One test covers every patch.

const DIR = path.dirname(fileURLToPath(import.meta.url));

function countCapturingGroups(re: string): number {
  const body = re.replace(/\\./g, '').replace(/\[[^\]]*\]/g, ''); // drop escapes + char classes
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '(') continue;
    if (body[i + 1] !== '?') {
      n++;
      continue;
    } // `(` => capturing
    // `(?<name>` is capturing; `(?<=` / `(?<!` (lookbehind) and `(?:` / `(?=` / `(?!` are not
    if (
      body[i + 1] === '?' &&
      body[i + 2] === '<' &&
      body[i + 3] !== '=' &&
      body[i + 3] !== '!'
    )
      n++;
  }
  return n;
}

describe('patch regex/capture consistency', () => {
  const files = fs
    .readdirSync(DIR)
    .filter(
      f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts'
    );

  for (const f of files) {
    it(`${f}: every match[N] reads a captured group`, () => {
      const src = fs.readFileSync(path.join(DIR, f), 'utf8');

      // regexVar -> [capturing-group count]; only UNAMBIGUOUS vars (declared once)
      // are checked — a name reused for different regexes across functions can't be
      // mapped without real scope analysis, so skip it rather than false-positive.
      const regexDecls: Record<string, number[]> = {};
      for (const m of src.matchAll(
        /(?:const|let)\s+(\w+)\s*=\s*(\/(?:\\.|\[[^\]]*\]|[^/\n])+\/[a-z]*)\s*;/g
      )) {
        (regexDecls[m[1]] ||= []).push(countCapturingGroups(m[2]));
      }
      const regexVars: Record<string, number> = {};
      for (const [k, v] of Object.entries(regexDecls))
        if (v.length === 1) regexVars[k] = v[0];

      // matchVar -> regexVar  (const M = <expr>.match(regexVar)); unambiguous only
      const matchDecls: Record<string, string[]> = {};
      for (const m of src.matchAll(
        /(?:const|let)\s+(\w+)\s*=\s*[\w.()]+\.match\((\w+)\)/g
      )) {
        (matchDecls[m[1]] ||= []).push(m[2]);
      }
      const matchVars: Record<string, string> = {};
      for (const [k, v] of Object.entries(matchDecls)) {
        if (v.length === 1 && regexVars[v[0]] !== undefined)
          matchVars[k] = v[0];
      }

      const violations: string[] = [];
      for (const m of src.matchAll(/(\w+)\[(\d+)\]/g)) {
        const mv = m[1];
        const idx = Number(m[2]);
        if (idx === 0) continue; // [0] is the full match
        const rv = matchVars[mv];
        if (rv === undefined) continue;
        if (regexVars[rv] < idx)
          violations.push(
            `${mv}[${idx}] but regex ${rv} has ${regexVars[rv]} capturing group(s)`
          );
      }

      expect(violations, violations.join('; ')).toEqual([]);
    });
  }
});
