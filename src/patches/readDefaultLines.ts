// Please see the note about writing patches in ./index

import { showDiff } from './index';

/**
 * Make the Read tool's default line cap (2000) env-configurable.
 *
 * Pristine shape (English-anchored, cross-platform safe):
 *   bmH=2000,sZ9="Read a file from the local filesystem."
 *
 * After patch:
 *   bmH=(+process.env.CLAUDE_CODE_READ_DEFAULT_LINES||2000),sZ9="..."
 *
 * Falls back to 2000 if env var isn't set, so this is a no-op for users
 * who don't export it.
 */
export const writeReadDefaultLines = (oldFile: string): string | null => {
  const pattern = /=2000,([$\w]+)="Read a file from the local filesystem\./;
  const match = oldFile.match(pattern);
  if (!match || match.index === undefined) {
    if (/=\(\+process\.env\.CLAUDE_CODE_READ_DEFAULT_LINES/.test(oldFile))
      return oldFile;
    console.error(
      'patch: readDefaultLines: failed to find =2000 near Read tool prompt anchor'
    );
    return null;
  }

  const startIndex = match.index;
  const endIndex = startIndex + '=2000'.length;
  const replacement = '=(+process.env.CLAUDE_CODE_READ_DEFAULT_LINES||2000)';
  const newFile =
    oldFile.slice(0, startIndex) + replacement + oldFile.slice(endIndex);
  showDiff(
    oldFile,
    newFile,
    replacement,
    startIndex,
    startIndex + replacement.length
  );
  return newFile;
};
