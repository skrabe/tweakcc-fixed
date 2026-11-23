import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'tagPlatforms.mjs'
);

let dir;
let json;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagPlatforms-test-'));
  json = path.join(dir, 'prompts-9.9.9.json');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = prompts =>
  fs.writeFileSync(json, JSON.stringify({ version: '9.9.9', prompts }));
// A real bundle stamps its version; an empty one stays empty.
const bundle = (name, content, stamp = 'VERSION:"9.9.9";') => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content && stamp + content);
  return file;
};
const tag = (...specs) =>
  spawnSync(process.execPath, [TOOL, json, '--jobs=2', ...specs], {
    encoding: 'utf8',
  });
const prompts = () => JSON.parse(fs.readFileSync(json, 'utf8')).prompts;

describe('tagPlatforms', () => {
  it('tags Data entries and sibling entries sharing a display name independently', () => {
    write([
      {
        id: 'screenshot-unsupported',
        name: 'Data: Screenshot',
        pieces: ['Screenshot unsupported'],
      },
      {
        id: 'screenshot-invisible',
        name: 'Data: Screenshot',
        pieces: ['Screenshot invisible'],
      },
      { id: 'shared', name: 'Shared', pieces: ['Shared text'] },
    ]);
    const darwin = bundle(
      'darwin.js',
      'a="Screenshot unsupported";b="Screenshot invisible";c="Shared text";'
    );
    const linux = bundle(
      'linux.js',
      'a="Screenshot invisible";b="Shared text";'
    );
    const r = tag(`darwin=${darwin}`, `linux=${linux}`, '--set=missing');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(prompts().map(p => p.platforms)).toEqual([
      ['darwin'],
      undefined,
      undefined,
    ]);
  });

  it('generalizes minified names in a piece using the shared matcher', () => {
    write([{ id: 'computed', pieces: ['Pick ${', '[String(O)]}'] }]);
    const darwin = bundle('darwin.js', 'a=`Pick ${p[String(O)]}`;');
    const linux = bundle('linux.js', 'a=`Pick ${z[String(M)]}`;');
    expect(tag(`darwin=${darwin}`, `linux=${linux}`).status).toBe(0);
    expect(prompts()[0].platforms).toBeUndefined();
  });

  it('keeps an inline expression carried when apply wildcards its changed structure', () => {
    write([
      {
        id: 'inline-expression',
        pieces: ['Pick ${', '[`${k.foo()}`]} done'],
        platforms: ['darwin'],
      },
    ]);
    const darwin = bundle('darwin.js', 'x=`Pick ${p[`${k.foo()}`]} done`;');
    const linux = bundle('linux.js', 'x=`Pick ${q[`${m.bar()}`]} done`;');
    const r = tag(`darwin=${darwin}`, `linux=${linux}`);
    expect(r.status).toBe(0);
    expect(prompts()[0].platforms).toBeUndefined();
  });

  it('requires every build of a platform to carry the entry', () => {
    write([{ id: 'mac', pieces: ['Mac text'] }]);
    const darwin = bundle('darwin.js', 'a="Mac text";');
    const x64 = bundle('x64.js', 'a="Mac text";');
    const arm64 = bundle('arm64.js', 'a="Different text";');
    expect(
      tag(`darwin=${darwin}`, `linux=${x64}`, `linux=${arm64}`).status
    ).toBe(0);
    expect(prompts()[0].platforms).toEqual(['darwin']);
  });

  it('clears obsolete tags but preserves drift missing everywhere', () => {
    write([
      { id: 'shared', pieces: ['Shared text'], platforms: ['darwin'] },
      { id: 'gone', pieces: ['Gone text'], platforms: ['darwin'] },
    ]);
    const darwin = bundle('darwin.js', 'a="Shared text";');
    const linux = bundle('linux.js', 'b="Shared text";');
    expect(tag(`darwin=${darwin}`, `linux=${linux}`).status).toBe(0);
    expect(prompts().map(p => p.platforms)).toEqual([undefined, ['darwin']]);
  });

  it('writes no tags when a bundle is unreadable or empty', () => {
    write([{ id: 'mac', pieces: ['Mac text'] }]);
    const before = fs.readFileSync(json, 'utf8');
    const darwin = bundle('darwin.js', 'a="Mac text";');
    const linux = bundle('linux.js', '');
    expect(tag(`darwin=${darwin}`, `linux=${linux}`).status).toBe(2);
    expect(tag(`darwin=${darwin}`, `linux=${dir}/nope.js`).status).toBe(2);
    const unstamped = bundle('unstamped.js', 'a="Mac 1.2.3 text";', '');
    const r = tag(`darwin=${darwin}`, `linux=${unstamped}`);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no VERSION');
    expect(fs.readFileSync(json, 'utf8')).toBe(before);
  });

  it('writes no tags when an entry cannot build its apply matcher', () => {
    write([{ id: 'invalid', pieces: [null], platforms: ['darwin'] }]);
    const before = fs.readFileSync(json, 'utf8');
    const darwin = bundle('darwin.js', 'a="Mac text";');
    const linux = bundle('linux.js', 'a="Linux text";');
    const r = tag(`darwin=${darwin}`, `linux=${linux}`);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not writing tags');
    expect(fs.readFileSync(json, 'utf8')).toBe(before);
  });

  it('does not count a short fragment found only inside unrelated text', () => {
    write([
      { id: 'tail', pieces: ["isn't."] },
      {
        id: 'long',
        pieces: ['A much longer sentence that is carried verbatim.'],
      },
    ]);
    const darwin = bundle(
      'darwin.js',
      'a="call request_access first if it "+"isn\'t.";b="A much longer sentence that is carried verbatim.";'
    );
    const linux = bundle(
      'linux.js',
      'a="when the conversation isn\'t. Default to grading";b="A much longer sentence that is carried verbatim.";'
    );
    const r = tag(`darwin=${darwin}`, `linux=${linux}`);
    expect(r.status).toBe(0);
    expect(prompts().map(p => p.platforms)).toEqual([['darwin'], undefined]);
  });

  it('keeps a short fragment carried when a build holds it as its own literal', () => {
    write([{ id: 'tail', pieces: ["isn't."] }]);
    const darwin = bundle('darwin.js', 'a="x "+"isn\'t.";');
    const linux = bundle('linux.js', "a=`isn't.`;");
    expect(tag(`darwin=${darwin}`, `linux=${linux}`).status).toBe(0);
    expect(prompts()[0].platforms).toBeUndefined();
  });

  it('bounds a longer short fragment to its own literal in every build', () => {
    write([
      { id: 'own', pieces: ['Default to grading'] },
      { id: 'inside', pieces: ['Default to grading'], name: 'twin' },
    ]);
    const darwin = bundle('darwin.js', 'a="Default to grading";');
    const linux = bundle(
      'linux.js',
      'a="when the conversation is done. Default to grading it";'
    );
    expect(tag(`darwin=${darwin}`, `linux=${linux}`).status).toBe(0);
    expect(prompts().map(p => p.platforms)).toEqual([['darwin'], ['darwin']]);
  });

  it('rejects an unknown platform', () => {
    write([]);
    expect(tag('not-platform=/dev/null').status).toBe(2);
  });

  it('rejects an invalid worker limit without writing tags', () => {
    write([]);
    const before = fs.readFileSync(json, 'utf8');
    expect(tag('--jobs=0', 'darwin=/dev/null').status).toBe(2);
    expect(fs.readFileSync(json, 'utf8')).toBe(before);
  });
});
