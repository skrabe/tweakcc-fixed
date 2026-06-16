import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// applyInlineBlobOverrides reads override .md files from SYSTEM_PROMPTS_DIR
// (resolved via ../config) and calls showDiff (../patches/patchDiffing). Point
// the dir at a temp folder we populate per-test, and stub showDiff so the
// integration tests don't depend on debug output. vi.hoisted runs before the
// hoisted vi.mock factories, so the temp dir exists when the factory reads it.
// node builtins must be required here (top-level ESM imports aren't yet bound
// when this hoisted block runs).
const { TMP_DIR } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const o = require('node:os') as typeof os;
  const p = require('node:path') as typeof path;
  const f = require('node:fs') as typeof fs;
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { TMP_DIR: f.mkdtempSync(p.join(o.tmpdir(), 'inlineblob-test-')) };
});

vi.mock('../config', () => ({
  SYSTEM_PROMPTS_DIR: TMP_DIR,
}));
vi.mock('./patchDiffing', () => ({
  showDiff: () => {},
}));
vi.mock('../utils', () => ({
  debug: () => {},
}));

import {
  applyInlineBlobOverrides,
  parseFrontmatter,
  minifiedInterpNames,
  introducedMinifiedSlots,
} from './inlineBlobOverrides';

const writeOverride = (name: string, contents: string) => {
  fs.writeFileSync(path.join(TMP_DIR, name), contents, 'utf8');
};
const clearOverrides = () => {
  for (const f of fs.readdirSync(TMP_DIR)) {
    if (f.endsWith('.md')) fs.rmSync(path.join(TMP_DIR, f));
  }
};

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('inlineBlobOverrides: parseFrontmatter', () => {
  it('parses a single-line anchor', () => {
    const md = [
      '<!--',
      "name: 'Inline blob: x'",
      'description: x',
      'inlineBlobAnchor: "`Hello world"',
      'inlineBlobKind: template',
      'injectionGate: always on',
      'ccVersion: 2.1.178',
      '-->',
      'Hello replaced',
    ].join('\n');
    const r = parseFrontmatter('inline-x.md', md);
    expect(r).not.toBeNull();
    expect(r!.frontmatter.inlineBlobAnchor).toBe('`Hello world');
    expect(r!.frontmatter.inlineBlobKind).toBe('template');
    expect(r!.body).toBe('Hello replaced');
  });

  // Root cause C: a YAML folded (>-) multi-line anchor. The previous
  // hand-rolled parser captured only the bare ">-" indicator, producing a
  // garbage regex that matched random code and corrupted cli.js. gray-matter
  // folds the continuation lines (joined with a single space) into the full
  // pattern.
  it('parses a folded (>-) multi-line anchor by joining continuation lines', () => {
    const md = [
      '<!--',
      "name: 'Inline blob: ctx'",
      'description: x',
      'inlineBlobAnchor: >-',
      '  `# Context management\\nWhen the conversation grows long, some or all of the',
      '  current context is summarized',
      'inlineBlobKind: template',
      'injectionGate: always on',
      'ccVersion: 2.1.178',
      '-->',
      '# replaced',
    ].join('\n');
    const r = parseFrontmatter('inline-ctx.md', md);
    expect(r).not.toBeNull();
    // Folded: continuation lines joined with single space, \n stays literal.
    expect(r!.frontmatter.inlineBlobAnchor).toBe(
      '`# Context management\\nWhen the conversation grows long, some or all of the current context is summarized'
    );
    // The anchor must NOT be the bare folding indicator (the old bug).
    expect(r!.frontmatter.inlineBlobAnchor).not.toBe('>-');
    expect(r!.frontmatter.inlineBlobAnchor.length).toBeGreaterThan(20);
  });

  it('returns null when anchor or kind is missing', () => {
    const md = [
      '<!--',
      "name: 'Inline blob: x'",
      'inlineBlobKind: template',
      '-->',
      'body',
    ].join('\n');
    expect(parseFrontmatter('inline-x.md', md)).toBeNull();
  });

  it('returns null when kind is not a known value', () => {
    const md = [
      '<!--',
      'inlineBlobAnchor: "abc"',
      'inlineBlobKind: bogus',
      '-->',
      'body',
    ].join('\n');
    expect(parseFrontmatter('inline-x.md', md)).toBeNull();
  });
});

describe('inlineBlobOverrides: minified-slot detection', () => {
  it('collects short minified ${var} names, ignores ALL_CAPS and long names', () => {
    const names = minifiedInterpNames(
      'a ${G9} b ${lL8} c ${AGENT_TOOL_NAME} d ${someVeryLongName} e ${T}'
    );
    expect(names.has('G9')).toBe(true);
    expect(names.has('lL8')).toBe(true);
    expect(names.has('T')).toBe(true);
    expect(names.has('AGENT_TOOL_NAME')).toBe(false);
    expect(names.has('someVeryLongName')).toBe(false);
  });

  it('ignores escaped \\${...} (intentional literal text)', () => {
    const names = minifiedInterpNames('docs say \\${G9} verbatim');
    expect(names.has('G9')).toBe(false);
  });

  // Root cause A: the override body carries a stale minified ${K9} the binary
  // no longer binds here (pristine has ${G9}); the remap couldn't reach it
  // (nested) so it would splice an undefined var.
  it('flags a minified ${var} introduced by the replacement but absent from pristine', () => {
    const pristine = '`...${G9} tool...${G9} tool...`';
    const replacement = '`...${G9} tool...`+`...${K9} tool...`';
    expect(introducedMinifiedSlots(pristine, replacement)).toEqual(['K9']);
  });

  it('passes when the replacement reuses only vars present in pristine', () => {
    const pristine = '`...${G9}...${O}...`';
    const replacement = '`...${G9}...${O}...lobotomized...`';
    expect(introducedMinifiedSlots(pristine, replacement)).toEqual([]);
  });
});

describe('inlineBlobOverrides: applyInlineBlobOverrides (integration)', () => {
  beforeAll(() => clearOverrides());

  it('applies a folded-anchor template override to the correct site (no corruption)', async () => {
    clearOverrides();
    // The folded anchor must resolve to the long pattern and splice the real
    // template literal — not the unrelated `typeof global=="object"` at the top.
    writeOverride(
      'inline-ctx.md',
      [
        '<!--',
        "name: 'Inline blob: ctx'",
        'description: x',
        'inlineBlobAnchor: >-',
        '  `# Context management\\nWhen the conversation grows',
        '  long',
        'inlineBlobKind: template',
        'injectionGate: always on',
        'ccVersion: 2.1.178',
        '-->',
        '# Context management LOBOTOMIZED',
      ].join('\n')
    );
    // Decoy core code that the old bug corrupted, plus the real target.
    const content =
      'var ct6=L(()=>{F71=typeof global=="object"&&global});' +
      'function ctx(){return`# Context management\nWhen the conversation grows long, wrap up.`}';
    const { content: out, results } = await applyInlineBlobOverrides(content);
    expect(results[0].applied).toBe(true);
    // Core code untouched.
    expect(out).toContain('typeof global=="object"&&global');
    // Real template replaced.
    expect(out).toContain('# Context management LOBOTOMIZED');
    expect(out).not.toContain('When the conversation grows long, wrap up');
  });

  // Root cause A: the agent-launch shape. The override has MORE top-level
  // ${...} slots than the pristine, so its NESTED `${cond?`…${K9}…`}` is left
  // verbatim by the positional top-level remap. ${K9} is stale (binary binds
  // ${G9}); splicing it would reference an undefined var. Must skip-with-warning.
  it('skips (no splice) a template override whose nested stale ${var} survives the remap', async () => {
    clearOverrides();
    writeOverride(
      'inline-agent.md',
      [
        '<!--',
        "name: 'Inline blob: agent'",
        'description: x',
        'inlineBlobAnchor: "`Launch an agent"',
        'inlineBlobKind: template',
        'injectionGate: always on',
        'ccVersion: 2.1.139',
        '-->',
        // Two top-level slots ${J}${M} then a nested conditional carrying ${K9}.
        'Launch an agent.${J}${M}${T?`When using the ${K9} tool.`:`Use ${K9}.`}',
      ].join('\n')
    );
    // Pristine: one leading slot then ONE conditional (binds ${G9} inside).
    const content =
      'x=`Launch an agent.${f}${O?`When using the ${G9} tool.`:`Use ${G9}.`}`;';
    const { content: out, results } = await applyInlineBlobOverrides(content);
    expect(results[0].applied).toBe(false);
    expect(results[0].skipped).toBe(true);
    expect(results[0].failed).toBe(false);
    // Binary left pristine — no introduced ${K9}.
    expect(out).toBe(content);
    expect(out).not.toContain('${K9}');
  });

  // Guard 1: a kind=template override whose anchor matches a "..." string with
  // an embedded backtick. The walker would start the template at that inner
  // backtick, outside the anchor span. Must skip, not corrupt.
  it('skips when the anchor matches outside its target literal', async () => {
    clearOverrides();
    writeOverride(
      'inline-shell.md',
      [
        '<!--',
        "name: 'Inline blob: shell'",
        'description: x',
        'inlineBlobAnchor: "\\"Run a command like"',
        'inlineBlobKind: template',
        'injectionGate: always on',
        'ccVersion: 2.1.141',
        '-->',
        'replaced',
      ].join('\n')
    );
    // The text lives in a double-quoted string that itself contains a backtick.
    const content = 'x="Run a command like `git status` please";';
    const before = content;
    const { content: out, results } = await applyInlineBlobOverrides(content);
    expect(results[0].applied).toBe(false);
    expect(results[0].skipped).toBe(true);
    // No corruption.
    expect(out).toBe(before);
  });

  it('applies a raw-passthrough array override, remapping bare identifiers positionally', async () => {
    clearOverrides();
    writeOverride(
      'inline-arr.md',
      [
        '<!--',
        "name: 'Inline blob: arr'",
        'description: x',
        'inlineBlobAnchor: \'[$\\w]+=\\["## Types of memory"\'',
        'inlineBlobKind: array',
        "inlineBlobRawPassthrough: 'true'",
        'injectionGate: always on',
        'ccVersion: 2.1.178',
        '-->',
        '"## Types of memory","",...AAA.map((_)=>`- ${_}`)',
      ].join('\n')
    );
    // Pristine array's bare identifiers are H and _ (inside the .map arrow).
    const content =
      'zz=["## Types of memory","","old",...H.map((_)=>`- **${_}**`)];rest';
    const { content: out, results } = await applyInlineBlobOverrides(content);
    expect(results[0].applied).toBe(true);
    // The override's AAA must be remapped to the pristine's first bare id (H).
    expect(out).toContain('...H.map((_)=>`- ${_}`)');
    expect(out).not.toContain('AAA');
  });
});
