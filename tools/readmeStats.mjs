#!/usr/bin/env node
// Regenerates the README coverage table from the catalogues, so its figures
// have one derivation instead of being carried forward by hand.
//
//   node tools/readmeStats.mjs X.Y.Z [--write]
//
// Prompt sites: entries in data/prompts/prompts-X.Y.Z.json (one per binary
// site). Unique prompt IDs: distinct ids among them. Patches: entries in
// PATCH_DEFINITIONS.
import fs from 'node:fs';
import * as prettier from 'prettier';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [version] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const write = process.argv.includes('--write');
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: readmeStats.mjs X.Y.Z [--write]');
  process.exit(2);
}

const git = (...args) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
const promptCounts = text => {
  const prompts = JSON.parse(text).prompts;
  return {
    sites: prompts.length,
    ids: new Set(prompts.map(p => p.id).filter(Boolean)).size,
  };
};
const patchCount = source => {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  });
  const declarations = ast.program.body.flatMap(node => {
    const declaration =
      node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    return declaration?.type === 'VariableDeclaration'
      ? declaration.declarations
      : [];
  });
  let value = declarations.find(
    node => node.id.name === 'PATCH_DEFINITIONS'
  )?.init;
  while (
    value?.type === 'TSAsExpression' ||
    value?.type === 'TSSatisfiesExpression'
  )
    value = value.expression;
  if (value?.type !== 'ArrayExpression')
    throw new Error('PATCH_DEFINITIONS array not found');
  const ids = value.elements.map(node => {
    const id =
      node?.type === 'ObjectExpression' &&
      node.properties.find(
        property =>
          property.type === 'ObjectProperty' &&
          (property.key.name ?? property.key.value) === 'id'
      );
    if (!id || id.value.type !== 'StringLiteral')
      throw new Error('Patch definition has no literal ID');
    return id.value.value;
  });
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate patch IDs');
  return ids.length;
};

const ours = {
  ...promptCounts(
    fs.readFileSync(
      path.join(ROOT, 'data/prompts', `prompts-${version}.json`),
      'utf8'
    )
  ),
  patches: patchCount(
    fs.readFileSync(path.join(ROOT, 'src/patches/index.ts'), 'utf8')
  ),
};

const upstreamCommit = git('rev-parse', 'upstream/main').trim();
const upstreamVersions = git(
  'ls-tree',
  '--name-only',
  upstreamCommit,
  'data/prompts/'
)
  .split('\n')
  .map(l => /prompts-(\d+\.\d+\.\d+)\.json$/.exec(l)?.[1])
  .filter(Boolean);
if (!upstreamVersions.includes(version)) {
  console.error(
    `upstream/main has no exact Claude Code ${version} catalogue; run git fetch upstream main or choose a version present in both repositories`
  );
  process.exit(1);
}
const upstreamVersion = version;
const upstream = {
  ...promptCounts(
    git(
      'show',
      `${upstreamCommit}:data/prompts/prompts-${upstreamVersion}.json`
    )
  ),
  patches: patchCount(git('show', `${upstreamCommit}:src/patches/index.ts`)),
};

const fmt = n => n.toLocaleString('en-US');
const cell = (s, w) => {
  const pad = w - s.length;
  return ' '.repeat(Math.floor(pad / 2)) + s + ' '.repeat(Math.ceil(pad / 2));
};
const row = (label, a, b) =>
  `| ${label.padEnd(28)} | ${cell(a, 13)} | ${cell(b, 9)} |`;
const table = [
  `|                              | tweakcc-fixed | upstream  |`,
  `| ---------------------------- | :-----------: | :-------: |`,
  row(`Prompt sites (CC ${version})`, fmt(ours.sites), fmt(upstream.sites)),
  row('Unique prompt IDs', fmt(ours.ids), fmt(upstream.ids)),
  row('Patches', String(ours.patches), String(upstream.patches)),
].join('\n');
const block = `${table}\n\nSame Claude Code ${version} catalogue, compared with [upstream ${upstreamCommit.slice(0, 8)}](https://github.com/Piebald-AI/tweakcc/tree/${upstreamCommit}). Counts describe source inventory; active prompts depend on model, tools and settings.`;

if (!write) {
  console.log(block);
  process.exit(0);
}
const readmePath = path.join(ROOT, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const re = /<!-- coverage:start -->[\s\S]*?<!-- coverage:end -->/;
if (!re.test(readme)) {
  console.error('README coverage table not found');
  process.exit(1);
}
// The refresh hint below the table names the version it was generated for.
const refreshRe = /(node tools\/readmeStats\.mjs )\d+\.\d+\.\d+( --write)/;
const next = readme
  .replace(re, `<!-- coverage:start -->\n\n${block}\n\n<!-- coverage:end -->`)
  .replace(refreshRe, `$1${version}$2`);
const options = (await prettier.resolveConfig(readmePath)) ?? {};
fs.writeFileSync(
  readmePath,
  await prettier.format(next, { ...options, filepath: readmePath })
);
console.log(
  `README coverage table: CC ${version}, upstream ${upstreamVersion}`
);
