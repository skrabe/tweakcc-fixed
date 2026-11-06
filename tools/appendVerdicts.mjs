#!/usr/bin/env node
// Merge reviewed rows into a keyed data file (an allowlist or verdict map under
// data/) without reformatting the rest of it.
//
//   node tools/appendVerdicts.mjs <data/file.json> <rows.json> [--replace]
//
// <rows.json> is an object keyed like the target ({key: row}) or an array of
// rows that each carry an explicit `key` (dropped from the stored row). The key
// is never inferred from `id` or `hash`: in these files those fields often name
// something else (a slot row's `id` is a prompt id, its key a hash). A key
// already in the target is refused unless --replace, so a review is never
// overwritten by accident. New keys are spliced in before the closing brace and
// formatted with prettier; existing lines are left byte for byte, so the diff
// holds only the new rows. --replace rewrites the whole file through prettier.
//
// Exit: 0 written · 1 refused (duplicate key or bad row) · 2 usage/IO error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

export const normalizeRows = rows => {
  if (Array.isArray(rows)) {
    const out = {};
    const errors = [];
    rows.forEach((row, i) => {
      if (typeof row?.key !== 'string' || row.key === '') {
        errors.push(`row ${i} has no "key" field`);
        return;
      }
      if (row.key in out) errors.push(`row ${i} repeats key ${row.key}`);
      const { key, ...rest } = row;
      out[key] = rest;
    });
    return { rows: out, errors };
  }
  if (rows && typeof rows === 'object') return { rows, errors: [] };
  return { rows: {}, errors: ['rows must be an object or an array'] };
};

// Insert `rows` (all new keys) before the target's closing brace, keeping
// every existing byte. Returns null when the text does not end in `}`.
export const spliceRows = async (text, rows, prettierOptions) => {
  const close = text.lastIndexOf('}');
  if (close === -1 || text.slice(close + 1).trim() !== '') return null;
  const head = text.slice(0, close).replace(/\s*$/, '');
  const empty = head.endsWith('{');
  const entries = Object.entries(rows).map(
    ([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v, null, 2)}`
  );
  const formatted = await prettier.format(`{${entries.join(',\n')}}`, {
    ...prettierOptions,
    parser: 'json',
  });
  const inner = formatted
    .trim()
    .slice(1, -1)
    .replace(/^\n|\n$/g, '');
  return `${head}${empty ? '' : ','}\n${inner}\n}\n`;
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
  const original = fs.readFileSync(targetPath, 'utf8');
  const text =
    (!clash.length && (await spliceRows(original, rows, options))) ||
    (await prettier.format(JSON.stringify(merged, null, 2), {
      ...options,
      filepath: targetPath,
    }));
  if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(merged)) {
    console.error(
      'appendVerdicts: merged text does not round-trip; nothing written'
    );
    process.exit(2);
  }
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
