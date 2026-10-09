import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { couldNotFindBlock } from './applySafetyHarness.mjs';

const TOOL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'tagPlatforms.mjs'
);

// tagPlatforms runs `node tools/applySafetyHarness.mjs … <bundle>`. A `node`
// shim first on PATH answers those calls with the canned output stored beside
// each bundle and hands every other call to the real node.
const SHIM = `#!/bin/sh
case "$1" in
  *applySafetyHarness.mjs)
    for last; do :; done
    cat "$last.harness-out"
    exit 1;;
esac
exec "${process.execPath}" "$@"
`;

const harnessOutput = (log, { cut = false } = {}) => {
  const block = couldNotFindBlock(log);
  return [
    '=== apply-safety harness ===',
    'pristine:          /tmp/cli.js',
    'apply ran:         true',
    ...(cut ? block.slice(0, -2) : block),
    ...(cut
      ? []
      : ['cannot apply safely (warns): 0', 'patched parses:    true']),
    ...(cut ? [] : ['RESULT: FAIL']),
    '',
  ].join('\n');
};

const NOT_FOUND = name =>
  `Could not find system prompt "${name}" in cli.js (using regex new RegExp("Could not find file ([\\\\w$]+)", "s"))`;

let dir;
let json;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagPlatforms-test-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'node'), SHIM, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'home'));
  json = path.join(dir, 'prompts-9.9.9.json');
  fs.writeFileSync(
    json,
    JSON.stringify({
      version: '9.9.9',
      prompts: [
        { id: 'tool-read', name: 'Tool: Read', pieces: ['a'] },
        { id: 'other', name: 'Other', pieces: ['b'] },
      ],
    })
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const bundle = (name, output) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '');
  fs.writeFileSync(`${file}.harness-out`, output);
  return file;
};

const tag = (...specs) =>
  spawnSync(process.execPath, [TOOL, json, ...specs, '--jobs=2'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      HOME: path.join(dir, 'home'),
      TWEAKCC_CONFIG_DIR: path.join(dir, 'home', '.tweakcc'),
    },
  });

describe('tagPlatforms', () => {
  it('reads a listed line that says "Could not find" twice as one prompt', () => {
    const darwin = bundle('darwin.js', harnessOutput(''));
    const linux = bundle('linux.js', harnessOutput(NOT_FOUND('Tool: Read')));
    const r = tag(`darwin=${darwin}`, `linux=${linux}`);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const prompts = JSON.parse(fs.readFileSync(json, 'utf8')).prompts;
    expect(prompts.find(p => p.id === 'tool-read').platforms).toEqual([
      'darwin',
    ]);
    expect(prompts.find(p => p.id === 'other').platforms).toBeUndefined();
  });

  it('writes no tags from a harness output cut short', () => {
    const before = fs.readFileSync(json, 'utf8');
    const darwin = bundle('darwin.js', harnessOutput(''));
    const linux = bundle(
      'linux.js',
      harnessOutput(`${NOT_FOUND('Tool: Read')}\n${NOT_FOUND('Other')}`, {
        cut: true,
      })
    );
    const r = tag(`darwin=${darwin}`, `linux=${linux}`);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/incomplete again/);
    expect(fs.readFileSync(json, 'utf8')).toBe(before);
  });
});
