import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  CLIJS_BACKUP_FILE,
  CONFIG_DIR,
  NATIVE_BINARY_BACKUP_FILE,
} from './config';
import { extractClaudeJsFromNativeInstallation } from './nativeInstallationLoader';
import { ClaudeCodeInstallationInfo } from './types';
import { debug } from './utils';

export interface PristineBundle {
  content: string;
  version: string;
  source: string;
}

export interface PristineBundleError {
  error: string;
}

const NATIVE_ORIG_JS = path.join(CONFIG_DIR, 'native-claudejs-orig.js');

/**
 * Every tweakcc splice leaves at least one of these markers. A binary carrying
 * them is patched, not pristine, and validating against it would compare the
 * overrides to themselves.
 */
const PATCH_MARKERS = ['__tweakcc', 'tweakcc v'];

export const looksPatched = (content: string): boolean =>
  PATCH_MARKERS.some(marker => content.includes(marker));

export const versionInBundle = (content: string): string | undefined =>
  content.match(/VERSION:"(\d+\.\d+\.\d+)"/)?.[1];

const readIfPristine = async (
  file: string,
  version: string,
  source: string
): Promise<PristineBundle | null> => {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const embedded = versionInBundle(content);
  if (embedded !== version) {
    debug(
      `${source}: version ${embedded ?? 'unknown'} != ${version}, skipping`
    );
    return null;
  }
  if (looksPatched(content)) {
    debug(`${source}: carries tweakcc markers, skipping`);
    return null;
  }
  return { content, version, source };
};

const extractIfPristine = async (
  binary: string,
  version: string,
  source: string
): Promise<PristineBundle | null> => {
  try {
    await fs.stat(binary);
  } catch {
    return null;
  }
  const { data } = await extractClaudeJsFromNativeInstallation(binary, version);
  if (!data) return null;
  const content = data.toString('utf8');
  if (versionInBundle(content) !== version) return null;
  if (looksPatched(content)) return null;
  return { content, version, source };
};

/**
 * Resolve a pristine, VERSION-MATCHED cli.js for the installed Claude Code.
 *
 * A validator that cannot see its input must fail rather than report clean, so
 * every candidate is verified to carry the expected `VERSION:"X.Y.Z"` and to be
 * free of tweakcc markers; when none qualifies the caller gets an error.
 *
 * Cheapest first: the extract `--apply` saves on every run, then the pristine
 * binary backup, then the live install (only usable when it is unpatched).
 */
export const resolvePristineBundle = async (
  ccInstInfo: ClaudeCodeInstallationInfo
): Promise<PristineBundle | PristineBundleError> => {
  const version = ccInstInfo.version;
  if (!version) {
    return { error: 'could not determine the installed Claude Code version' };
  }

  const tried: string[] = [];
  if (ccInstInfo.nativeInstallationPath) {
    const candidates: Array<[string, () => Promise<PristineBundle | null>]> = [
      [
        NATIVE_ORIG_JS,
        () => readIfPristine(NATIVE_ORIG_JS, version, NATIVE_ORIG_JS),
      ],
      [
        NATIVE_BINARY_BACKUP_FILE,
        () =>
          extractIfPristine(
            NATIVE_BINARY_BACKUP_FILE,
            version,
            NATIVE_BINARY_BACKUP_FILE
          ),
      ],
      [
        ccInstInfo.nativeInstallationPath,
        () =>
          extractIfPristine(
            ccInstInfo.nativeInstallationPath!,
            version,
            ccInstInfo.nativeInstallationPath!
          ),
      ],
    ];
    for (const [name, resolve] of candidates) {
      const bundle = await resolve();
      if (bundle) return bundle;
      tried.push(name);
    }
  } else if (ccInstInfo.cliPath) {
    for (const file of [CLIJS_BACKUP_FILE, ccInstInfo.cliPath]) {
      const bundle = await readIfPristine(file, version, file);
      if (bundle) return bundle;
      tried.push(file);
    }
  }

  return {
    error:
      `no pristine, version-matched (${version}) cli.js available. Tried: ` +
      `${tried.join(', ')}. Run --restore, or --apply once so the pristine ` +
      'extract is saved.',
  };
};

/**
 * Load a pristine bundle from an explicit path (used by tests and by
 * `--validate-system-prompts <cli.js>`), deriving the version from the file's
 * own `VERSION:"X.Y.Z"` marker.
 */
export const loadPristineBundleFromFile = async (
  file: string
): Promise<PristineBundle | PristineBundleError> => {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (err) {
    return { error: `cannot read ${file}: ${String(err)}` };
  }
  const version = versionInBundle(content);
  if (!version) {
    return { error: `${file} carries no VERSION:"X.Y.Z" marker` };
  }
  if (looksPatched(content)) {
    return { error: `${file} carries tweakcc markers — it is not pristine` };
  }
  return { content, version, source: file };
};
