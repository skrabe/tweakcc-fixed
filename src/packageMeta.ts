import { createRequire } from 'node:module';

// package.json sits two levels up from src/patches/ but one level up from the
// bundled dist/*.mjs chunks, so try both — keeps the reported version pinned
// to the published one instead of a hardcoded literal that drifts.
const _require = createRequire(import.meta.url);

interface PackageMeta {
  version: string;
  supportedClaudeCode: string;
}

const PACKAGE_META: PackageMeta = (() => {
  try {
    return _require('../package.json') as PackageMeta;
  } catch {
    return _require('../../package.json') as PackageMeta;
  }
})();

/** This build's own version, and the tag that publishes it. */
export const TWEAKCC_VERSION: string = PACKAGE_META.version;

// Newest Claude Code version this release was verified against; the release
// workflows refuse a tag where it lags data/prompts.
export const TWEAKCC_SUPPORTED_CC: string = PACKAGE_META.supportedClaudeCode;
