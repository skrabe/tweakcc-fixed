// Please see the note about writing patches in ./index
//
// MCP Startup Optimization Patch
// Based on: https://cuipengfei.is-a.dev/blog/2026/01/24/claude-code-mcp-startup-optimization/
//
// This patch modifies Claude Code's MCP connection behavior:
// - MCP_CONNECTION_NONBLOCKING: Don't block startup waiting for all MCPs to connect
// - MCP_SERVER_CONNECTION_BATCH_SIZE: Connect more servers in parallel (default: 3)

import { showDiff, LocationResult } from './index';

type NonBlockingLocation = LocationResult & { replacement: string };

/**
 * Find the MCP non-blocking check location.
 *
 * The matched span is the expression that becomes the connect-nonblocking
 * flag (truthy = run MCP connect fully async). Each method's `replacement`
 * is the literal that forces that flag on for that shape.
 */
const getNonBlockingCheckLocation = (
  oldFile: string
): NonBlockingLocation | null => {
  // Method 0 — CC >= 2.1.251: `!IDENT(process.env.MCP_CONNECTION_NONBLOCKING)`
  // became `IDENT.MCP_CONNECTION_NONBLOCKING!==!1` on a parsed settings
  // object (true = nonblocking; unset defaults to true). Replace the RHS
  // with `true` so an explicit `false` in settings cannot re-enable blocking.
  const method0 =
    /=\s*[$\w]+\.MCP_CONNECTION_NONBLOCKING\s*!==?\s*(?:!1|false)/;
  const match0 = oldFile.match(method0);
  if (match0 && match0.index !== undefined) {
    return {
      startIndex: match0.index,
      endIndex: match0.index + match0[0].length,
      replacement: '=true',
    };
  }

  // Method 1: !IDENT(process.env.MCP_CONNECTION_NONBLOCKING)
  const method1 = /![$\w]+\(process\.env\.MCP_CONNECTION_NONBLOCKING\)/;
  const match1 = oldFile.match(method1);
  if (match1 && match1.index !== undefined) {
    return {
      startIndex: match1.index,
      endIndex: match1.index + match1[0].length,
      replacement: 'false',
    };
  }

  return null;
};

/**
 * Find every MCP batch-size default location.
 *
 * Each method's capture group 1 is the trailing default digit(s) — the token
 * we rewrite. Methods are ordered newest-shape-first; older ones stay as
 * zero-cost fallbacks for CC versions we still claim to support.
 *
 * The bundle contains the batch-size helper more than once (two copies of the
 * MCP client code in 2.1.219/2.1.220), so every occurrence is rewritten —
 * patching only the first would silently no-op if the other copy is the live
 * one.
 */
const BATCH_SIZE_PATTERNS: RegExp[] = [
  // Method 0 — CC >= 2.1.251: parseInt/helper + `return X>0?X:N` clamp is
  // gone. The default is now a nullish coalesce on a parsed settings object:
  //   function Dr(){return a.MCP_SERVER_CONNECTION_BATCH_SIZE??3}
  /MCP_SERVER_CONNECTION_BATCH_SIZE\s*\?\?\s*(\d+)/g,
  // Method 3 (CC ≥2.1.219): parseInt moved into a shared numeric-env helper.
  //   function iKu(){let e=Bd(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE);return e>0?e:3}
  /MCP_SERVER_CONNECTION_BATCH_SIZE\)\s*;\s*return\s*[$\w]+\s*>\s*0\s*\?\s*[$\w]+\s*:\s*(\d+)/g,
  // Method 2 (CC ≥2.1.140): inline parseInt, result clamped by a ternary.
  //   parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE||"",10);return H>0?H:3
  /MCP_SERVER_CONNECTION_BATCH_SIZE\|\|"",10\)\s*;\s*return\s*[$\w]+\s*>\s*0\s*\?\s*[$\w]+\s*:\s*(\d+)/g,
  // Method 1 (older CC): plain `||3` default.
  //   parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE||"",10)||3
  /MCP_SERVER_CONNECTION_BATCH_SIZE\|\|"",10\)\s*\|\|\s*(\d+)/g,
];

const getBatchSizeLocations = (oldFile: string): LocationResult[] => {
  const locations: LocationResult[] = [];

  for (const batchPattern of BATCH_SIZE_PATTERNS) {
    batchPattern.lastIndex = 0;
    for (const batchMatch of oldFile.matchAll(batchPattern)) {
      if (batchMatch.index === undefined) continue;
      // The default token is always the tail of the match.
      const endIndex = batchMatch.index + batchMatch[0].length;
      locations.push({
        startIndex: endIndex - batchMatch[1].length,
        endIndex,
      });
    }
  }

  if (locations.length === 0) {
    console.error(
      'patch: mcpStartup: failed to find MCP_SERVER_CONNECTION_BATCH_SIZE default'
    );
  }

  return locations.sort((a, b) => a.startIndex - b.startIndex);
};

/**
 * Apply non-blocking MCP startup by forcing the connect-nonblocking flag on.
 */
export const writeMcpNonBlocking = (oldFile: string): string | null => {
  const location = getNonBlockingCheckLocation(oldFile);
  if (!location) {
    if (!oldFile.includes('MCP_CONNECTION_NONBLOCKING')) {
      console.log(
        'patch: mcp-non-blocking: feature already promoted in this CC build — no-op'
      );
      return oldFile;
    }
    console.error(
      'patch: mcpStartup: failed to find MCP_CONNECTION_NONBLOCKING check'
    );
    return null;
  }

  const newValue = location.replacement;
  const newFile =
    oldFile.slice(0, location.startIndex) +
    newValue +
    oldFile.slice(location.endIndex);

  showDiff(oldFile, newFile, newValue, location.startIndex, location.endIndex);
  return newFile;
};

/**
 * Apply MCP batch size optimization by replacing the default value.
 */
export const writeMcpBatchSize = (
  oldFile: string,
  batchSize: number
): string | null => {
  const locations = getBatchSizeLocations(oldFile);
  if (locations.length === 0) {
    return null;
  }

  const newValue = String(batchSize);
  let newFile = oldFile;

  // Splice right-to-left so earlier indices stay valid. Slice-based splicing
  // (never String.replace) — the surrounding minified names contain `$`, which
  // replace() would interpret as a substitution pattern.
  for (const location of [...locations].reverse()) {
    const spliced =
      newFile.slice(0, location.startIndex) +
      newValue +
      newFile.slice(location.endIndex);
    showDiff(
      newFile,
      spliced,
      newValue,
      location.startIndex,
      location.endIndex
    );
    newFile = spliced;
  }

  return newFile;
};
