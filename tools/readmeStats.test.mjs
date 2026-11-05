import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A git hook exports GIT_INDEX_FILE and GIT_DIR; inherited, they point the
// fixture's git at the real repository's index.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const fixture = (upstreamVersion = '2.1.317') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-stats-'));
  directories.push(root);
  const write = (name, text) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'README test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  write(
    `data/prompts/prompts-${upstreamVersion}.json`,
    JSON.stringify({ prompts: [{ id: 'upstream' }] })
  );
  write('src/patches/index.ts', "const PATCH_DEFINITIONS = [{ id: 'one' }];");
  git('add', '.');
  git('commit', '--quiet', '-m', 'fixture');
  const upstreamCommit = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/upstream/main', upstreamCommit);
  write(
    'data/prompts/prompts-2.1.317.json',
    JSON.stringify({ prompts: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] })
  );
  write(
    'src/patches/index.ts',
    'export const PATCH_DEFINITIONS: unknown[] = [{ "id": "one" }, { id: "two" }] satisfies unknown[];'
  );
  const readme =
    '# Before\n<!-- coverage:start -->\n<!-- coverage:end -->\nAfter\n';
  write('README.md', readme);
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.copyFileSync(
    path.join(import.meta.dirname, 'readmeStats.mjs'),
    path.join(root, 'tools/readmeStats.mjs')
  );
  fs.symlinkSync(
    path.join(import.meta.dirname, '../node_modules'),
    path.join(root, 'node_modules'),
    'dir'
  );
  const run = () =>
    spawnSync(
      process.execPath,
      ['tools/readmeStats.mjs', '2.1.317', '--write'],
      {
        cwd: root,
        encoding: 'utf8',
        env,
        timeout: 10_000,
      }
    );
  return { root, write, readme, upstreamCommit, run };
};

describe('README statistics', () => {
  it('writes same-version counts and provenance into an empty marker block', () => {
    const { root, upstreamCommit, run } = fixture();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme).toMatch(/Prompt sites \(CC 2\.1\.317\)\s*\|\s*3\s*\|\s*1/);
    expect(readme).toMatch(/Unique prompt IDs\s*\|\s*2\s*\|\s*1/);
    expect(readme).toMatch(/Patches\s*\|\s*2\s*\|\s*1/);
    expect(readme).toContain(`/tree/${upstreamCommit}`);
    expect(readme.startsWith('# Before\n')).toBe(true);
    expect(readme.endsWith('\nAfter\n')).toBe(true);
    expect(run().status).toBe(0);
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(readme);
  });

  it('rejects an older upstream catalogue without changing the README', () => {
    const { root, readme, run } = fixture('2.1.316');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no exact Claude Code 2.1.317 catalogue');
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(readme);
  });

  it('rejects duplicate patch IDs rather than inflating coverage', () => {
    const { root, readme, write, run } = fixture();
    write(
      'src/patches/index.ts',
      "const PATCH_DEFINITIONS = [{ id: 'same' }, { id: 'same' }];"
    );
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Duplicate patch IDs');
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(readme);
  });
});
