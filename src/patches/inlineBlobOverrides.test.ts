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

  // Guard 3: content authored INSIDE a `${...}` slot is thrown away by the
  // positional remap. Splicing anyway ships a half-applied override the
  // operator believes is live — and the restored branch can break the grammar
  // of the sentence rewritten around it. Must fail, not warn-and-splice.
  it('fails (no splice) a template override with authored content inside a ${...} slot', async () => {
    clearOverrides();
    writeOverride(
      'inline-tern.md',
      [
        '<!--',
        "name: 'Inline blob: tern'",
        'description: x',
        'inlineBlobAnchor: "`You are an agent"',
        'inlineBlobKind: template',
        'injectionGate: always on',
        'ccVersion: 2.1.211',
        '-->',
        'You are an agent ${H!==null?"REWORDED BRANCH":"with tasks."} now',
      ].join('\n')
    );
    const content =
      'x=`You are an agent ${H!==null?"in a session":"with tasks."} now`;';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { content: out, results } = await applyInlineBlobOverrides(content);
    const errors = errSpy.mock.calls
      .flat()
      .filter((a): a is string => typeof a === 'string');
    errSpy.mockRestore();

    expect(results[0].applied).toBe(false);
    expect(results[0].failed).toBe(true);
    // Binary untouched — nothing half-applied.
    expect(out).toBe(content);
    expect(out).not.toContain('REWORDED BRANCH');
    expect(errors.some(e => e.includes('REWORDED BRANCH'))).toBe(true);
    expect(errors.some(e => e.includes('inline-tern.md'))).toBe(true);
    expect(errors.some(e => e.includes('AROUND the slot'))).toBe(true);
  });

  // The contrast case: a BARE placeholder slot carries no authored content, so
  // the remap loses nothing and the override applies as before.
  it('still applies a template override whose slots are bare placeholders', async () => {
    clearOverrides();
    writeOverride(
      'inline-bare.md',
      [
        '<!--',
        "name: 'Inline blob: bare'",
        'description: x',
        'inlineBlobAnchor: "`You are an agent"',
        'inlineBlobKind: template',
        'injectionGate: always on',
        'ccVersion: 2.1.211',
        '-->',
        'You are an agent ${X} REWRITTEN TAIL',
      ].join('\n')
    );
    const content = 'x=`You are an agent ${H} with tasks.`;';
    const { content: out, results } = await applyInlineBlobOverrides(content);

    expect(results[0].applied).toBe(true);
    expect(out).toContain('${H} REWRITTEN TAIL');
    expect(out).not.toContain('${X}');
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

  it('refuses a raw-passthrough array override whose slots no longer line up with the binary', async () => {
    clearOverrides();
    writeOverride(
      'inline-sys.md',
      [
        '<!--',
        "name: 'Inline blob: sys'",
        'description: x',
        'inlineBlobAnchor: \'[$\\w]+=\\["All text you output"\'',
        'inlineBlobKind: array',
        "inlineBlobRawPassthrough: 'true'",
        'injectionGate: always on',
        'ccVersion: 2.1.317',
        '-->',
        '"All text you output",itp(e,"standard"),uMy(),"tail"',
      ].join('\n')
    );
    // The binary gained `...n?[HQe]:[]` before the hooks call, so a positional
    // remap of the 3-slot override would turn uMy() into n().
    const content =
      'function O(e,n){let r=["All text you output",Bdn(e,"standard"),...n?[HQe]:[],spr(),"tail"];return r}';
    const { content: out, results } = await applyInlineBlobOverrides(content);
    expect(results[0].applied).toBe(false);
    expect(results[0].failed).toBe(true);
    expect(results[0].details).toContain('slot 3 uMy is a call');
    expect(out).toBe(content);
  });

  it('allows a raw-passthrough array override that drops trailing slots', async () => {
    clearOverrides();
    writeOverride(
      'inline-save.md',
      [
        '<!--',
        "name: 'Inline blob: save'",
        'description: x',
        'inlineBlobAnchor: \'\\["## How to save"\'',
        'inlineBlobKind: array',
        "inlineBlobRawPassthrough: 'true'",
        'injectionGate: always on',
        'ccVersion: 2.1.317',
        '-->',
        '"## How to save",...Gwe,"- short"',
      ].join('\n')
    );
    const content = 'x=["## How to save",...o3t,`- ${nr}`,...qn];';
    const { content: out, results } = await applyInlineBlobOverrides(content);
    expect(results[0].applied).toBe(true);
    expect(out).toContain('["## How to save",...o3t,"- short"]');
  });

  // memory-types-dynamic shape: the stale minified names (Fu5/lL8) live INSIDE
  // template-literal `${...}` array elements. The remap must recurse into the
  // interpolations and rewrite them to the pristine's platform-specific names
  // (to5/GE8), not leave them verbatim (which the introduced-var guard would
  // then skip-with-warning — the original "would introduce ${lL8}" bug).
  it('remaps identifiers nested inside template `${...}` array elements', async () => {
    clearOverrides();
    writeOverride(
      'inline-mem.md',
      [
        '<!--',
        "name: 'Inline blob: mem'",
        'description: x',
        'inlineBlobAnchor: \'return\\["## Types of memory"\'',
        "inlineBlobKind: 'array'",
        "inlineBlobRawPassthrough: 'true'",
        'injectionGate: always on',
        'ccVersion: 2.1.179',
        '-->',
        '"## Types of memory","",...H.map((_)=>`- **${_}** ${Fu5[_]}`),`Invoke ${lL8} skill.`',
      ].join('\n')
    );
    // Pristine carries platform-specific names to5 (was Fu5) and GE8 (was lL8).
    const content =
      'x(){return["## Types of memory","",...A.map((_)=>`- **${_}** ${to5[_]}`),`Invoke ${GE8} skill.`]}';
    const { content: out, results } = await applyInlineBlobOverrides(content);
    expect(results[0].applied).toBe(true);
    // Nested names remapped to the pristine's; no stale Fu5/lL8 survive.
    expect(out).toContain('...A.map((_)=>`- **${_}** ${to5[_]}`)');
    expect(out).toContain('`Invoke ${GE8} skill.`');
    expect(out).not.toContain('Fu5');
    expect(out).not.toContain('lL8');
  });
});
