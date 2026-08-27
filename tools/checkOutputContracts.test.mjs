import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TOOL = path.join(REPO, 'tools/checkOutputContracts.mjs');

// A pristine bundle stub: the tag vocabulary comes from REGEX LITERALS, and the gate
// must distinguish a real parser from prose that merely looks like one. `<block>` and
// `<summary>` are extracted between escaped close tags (real); `<out_dir>` and
// `<name>` appear only in prose inside a template literal (noise that produced 14 of
// 22 findings before the escaped-close rule).
const CLI = `var version="9.9.9";
function OGt(e){return [...e.matchAll(/<block>(yes|no)\\b/gi)]}
function pick(e){return /<summary>([\\s\\S]*?)<\\/summary>/.exec(e)}
var docs = \`pass --out-dir <out_dir> to choose where files land, and name it <name>.\`;
`;

const PROMPTS = {
  prompts: [
    {
      id: 'classifier',
      version: '9.9.9',
      pieces: ['Reply with <block>yes</block> or <block>no</block>.'],
      identifiers: [],
      identifierMap: {},
    },
    {
      id: 'summarizer',
      version: '9.9.9',
      pieces: ['Wrap it in <summary></summary> tags.'],
      identifiers: [],
      identifierMap: {},
    },
    {
      id: 'mentions-out-dir',
      version: '9.9.9',
      pieces: ['Pass <out_dir> and <name> when you call it.'],
      identifiers: [],
      identifierMap: {},
    },
  ],
};

function scaffold(overrides) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
  fs.writeFileSync(path.join(root, 'cli.js'), CLI);
  fs.writeFileSync(path.join(root, 'prompts-9.9.9.json'), JSON.stringify(PROMPTS));
  const set = path.join(root, 'lcc', 'system-prompts-opus-5');
  fs.mkdirSync(set, { recursive: true });
  for (const [id, body] of Object.entries(overrides)) {
    fs.writeFileSync(path.join(set, `${id}.md`), `<!--\nname: '${id}'\n-->\n${body}\n`);
  }
  return root;
}

function run(root) {
  try {
    const out = execFileSync(
      process.execPath,
      [
        TOOL,
        '--cli', path.join(root, 'cli.js'),
        '--json', path.join(root, 'prompts-9.9.9.json'),
        '--lcc', path.join(root, 'lcc'),
      ],
      { encoding: 'utf8' }
    );
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

describe('checkOutputContracts', () => {
  it('flags an override that drops a tag the binary parses out of the reply', () => {
    // The real failure: the classifier override kept prose but deleted every
    // <block> instruction, so the parser returned null and auto mode blocked
    // every action while every other gate stayed green.
    const root = scaffold({ classifier: 'Judge the action by its full effect.' });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain('classifier');
    expect(out).toContain('<block>');
  });

  it('passes when the override keeps the tag', () => {
    const root = scaffold({ classifier: 'Judge it, then answer <block>yes</block> or <block>no</block>.' });
    const { code, out } = run(root);
    expect(code).toBe(0);
    expect(out).toContain('PASS');
  });

  it('does not flag a tag that only appears in prose, not in a real regex', () => {
    // <out_dir> and <name> live in a template literal, never in a parser. An
    // override is free to drop them.
    const root = scaffold({ 'mentions-out-dir': 'Call it however you like.' });
    const { code } = run(root);
    expect(code).toBe(0);
  });

  it('ignores a deliberate full suppression (empty body)', () => {
    const root = scaffold({ classifier: '' });
    const { code } = run(root);
    expect(code).toBe(0);
  });

  it('ignores an id with no override at all, since pristine then applies', () => {
    const root = scaffold({});
    const { code } = run(root);
    expect(code).toBe(0);
  });

  it('exits 2 rather than 0 when it cannot find a pristine bundle to read', () => {
    const root = scaffold({});
    fs.rmSync(path.join(root, 'cli.js'));
    const { code } = run(root);
    expect(code).toBe(2);
  });
});
