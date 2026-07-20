#!/usr/bin/env node
// Loopback liveness capture — CLI entry.
//
// Proves what actually reaches the model, rather than what we think we spliced:
// runs the patched, installed Claude Code against a capture-only loopback
// server and asserts blocking canaries over a normalized projection of the
// outbound request.
//
// Usage:
//   node tools/liveness/run.mjs [--row <id>] [--out <dir>] [--list]
//                               [--timeout <ms>] [--allow-unpatched]
//
// Exit codes: 0 all canaries pass · 1 a canary failed · 2 could not capture.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LivenessError,
  buildProjection,
  evaluateCanaries,
  renderProjection,
} from './projection.mjs';
import { captureRow, isPatched, resolveBinary } from './capture.mjs';
import { SELECTOR_ROWS, enabledRows, findRow } from './selectors.mjs';

const EXIT_CANARY_FAILED = 1;
const EXIT_CANNOT_CAPTURE = 2;

const parseArgs = argv => {
  const opts = {
    out: null,
    row: null,
    list: false,
    timeoutMs: 120000,
    allowUnpatched: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') opts.list = true;
    else if (arg === '--allow-unpatched') opts.allowUnpatched = true;
    else if (arg === '--row') opts.row = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--timeout') opts.timeoutMs = Number(argv[++i]);
    else throw new LivenessError(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new LivenessError('--timeout must be a positive number of ms');
  }
  return opts;
};

const listRows = () => {
  for (const row of SELECTOR_ROWS) {
    const state = row.enabled ? 'enabled ' : 'disabled';
    const verified = row.verified ? '' : ' (unverified)';
    console.log(`${state}  ${row.id}${verified}`);
    console.log(`          ${row.summary}`);
    console.log(`          canaries: ${row.canaries.length}`);
  }
};

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    listRows();
    return 0;
  }

  const rows = opts.row ? [findRow(opts.row)] : enabledRows();
  if (opts.row && !rows[0]) {
    throw new LivenessError(`no such selector row: ${opts.row}`);
  }
  if (rows.length === 0) {
    throw new LivenessError('no enabled selector rows to capture');
  }

  const binary = resolveBinary();
  if (!opts.allowUnpatched && !isPatched(binary)) {
    throw new LivenessError(
      `${binary} carries no tweakcc patch marker — it is a pristine Claude ` +
        'Code, so there are no overrides to verify. Run --apply first, or ' +
        'pass --allow-unpatched to capture anyway.'
    );
  }

  const outDir = opts.out ?? path.join(os.tmpdir(), 'tweakcc-liveness');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`liveness: binary ${binary}`);
  console.log(`liveness: artifacts ${outDir}`);

  let failures = 0;
  for (const row of rows) {
    console.log(`\nliveness: capturing row ${row.id} — ${row.summary}`);
    const captured = await captureRow(row, {
      binary,
      timeoutMs: opts.timeoutMs,
    });
    const projection = buildProjection(captured.body);
    const artifact = path.join(outDir, `${row.id}.projection.txt`);
    fs.writeFileSync(artifact, renderProjection(row, projection));
    console.log(
      `liveness: model=${projection.model} ` +
        `system=${projection.system.length} tools=${projection.tools.length} ` +
        `-> ${artifact}`
    );

    for (const result of evaluateCanaries(row, projection)) {
      if (result.pass) {
        console.log(`  PASS  ${result.id} [${result.scope}]`);
        continue;
      }
      failures++;
      console.error(`  FAIL  ${result.id} [${result.scope}]`);
      console.error(`        ${result.detail}`);
      console.error(`        would mean: ${result.why}`);
    }
  }

  if (failures > 0) {
    console.error(`\nliveness: ${failures} canary failure(s)`);
    return EXIT_CANARY_FAILED;
  }
  console.log('\nliveness: all canaries passed');
  return 0;
};

main().then(
  code => process.exit(code),
  err => {
    if (err instanceof LivenessError) {
      console.error(`liveness: cannot capture: ${err.message}`);
    } else {
      console.error(`liveness: unexpected failure: ${err?.stack ?? err}`);
    }
    process.exit(EXIT_CANNOT_CAPTURE);
  }
);
