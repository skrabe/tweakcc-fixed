#!/usr/bin/env node
// Merge reviewed rows into a keyed data file (an allowlist or verdict map under
// data/) without reformatting the rest of it.
//
//   node tools/appendVerdicts.mjs <data/file.json> <rows.json> [--replace]
//
// <rows.json> is an object keyed like the target ({key: row}) or an array of
// rows that each carry a `key`, `hash` or `id` field naming their key (that
// field is dropped from the stored row when it only served as the key). A key
// already in the target is refused unless --replace, so a review is never
// overwritten by accident. The result is written through prettier with the
// repo's config, which is what lint-staged would produce on commit, so the diff
// holds only the new rows.
//
// Exit: 0 written · 1 refused (duplicate key or bad row) · 2 usage/IO error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const KEY_FIELDS = ['key', 'hash', 'id'];

export const normalizeRows = rows => {
  if (Array.isArray(rows)) {
    const out = {};
    const errors = [];
    rows.forEach((row, i) => {
      const field = KEY_FIELDS.find(f => typeof row?.[f] === 'string');
      if (!field) {
        errors.push(`row ${i} has no key, hash or id`);
        return;
      }
      const k = row[field];
      if (k in out) errors.push(`row ${i} repeats key ${k}`);
      const rest = { ...row };
      if (field === 'key') delete rest.key;
      out[k] = rest;
    });
    return { rows: out, errors };
  }
  if (rows && typeof rows === 'object') return { rows, errors: [] };
  return { rows: {}, errors: ['rows must be an object or an array'] };
};

export const mergeRows = (target, rows, { replace = false } = {}) => {
  const clash = Object.keys(rows).filter(k => k in target);
  if (clash.length && !replace) return { clash };
  return { merged: { ...target, ...rows }, clash };
};

const main = async () => {
  const argv = process.argv.slice(2);
  const replace = argv.includes('--replace');
  const [targetPath, rowsPath] = argv.filter(a => !a.startsWith('--'));
  if (!targetPath || !rowsPath) {
    console.error(
      'usage: node tools/appendVerdicts.mjs <data/file.json> <rows.json> [--replace]'
    );
    process.exit(2);
  }
  let target;
  let input;
  try {
    target = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    input = JSON.parse(fs.readFileSync(rowsPath, 'utf8'));
  } catch (e) {
    console.error(`appendVerdicts: ${e.message}`);
    process.exit(2);
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    console.error(`appendVerdicts: ${targetPath} is not a keyed object`);
    process.exit(2);
  }
  const { rows, errors } = normalizeRows(input);
  if (errors.length) {
    for (const e of errors) console.error(`appendVerdicts: ${e}`);
    process.exit(1);
  }
  const { merged, clash } = mergeRows(target, rows, { replace });
  if (!merged) {
    console.error(
      `appendVerdicts: ${clash.length} key(s) already in ${targetPath} (pass --replace to overwrite): ${clash.slice(0, 10).join(', ')}`
    );
    process.exit(1);
  }
  const options = (await prettier.resolveConfig(targetPath)) ?? {};
  const text = await prettier.format(JSON.stringify(merged, null, 2), {
    ...options,
    filepath: targetPath,
  });
  fs.writeFileSync(targetPath, text);
  const added = Object.keys(rows).length - clash.length;
  console.log(
    `appendVerdicts: ${targetPath}: ${added} added, ${clash.length} replaced, ${Object.keys(merged).length} total`
  );
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
