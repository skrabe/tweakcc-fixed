// Please see the note about writing patches in ./index

import { debug } from '../utils';
import { LocationResult, showDiff } from './index';

const getShowMoreItemsInSelectMenusLocation = (
  oldFile: string
): LocationResult[] => {
  const results: LocationResult[] = [];

  // Find all instances of visibleOptionCount:varName=number pattern (destructured props with default values)
  const pattern = /visibleOptionCount:[\w$]+=(\d+)/g;
  let match;

  while ((match = pattern.exec(oldFile)) !== null) {
    // We want to replace just the number part
    const numberStart = match.index + match[0].indexOf('=') + 1;
    results.push({
      startIndex: numberStart,
      endIndex: numberStart + match[1].length,
    });
  }

  return results;
};

/**
 * Patch the select/help menu to use (near-)full terminal height instead of half.
 *
 * CC ≤ 2.1.147 — direct assignment in minified code:
 *   {rows:VAR,columns:VAR}=FN(),VAR=Math.floor(VAR/2)
 *
 * CC ≥ 2.1.148 — the maxHeight got folded into a ternary + Math.min clamp
 * inside the suggestions-menu component:
 *   {rows:Y,columns:w}=FN(),j=O?J95:Math.max(1,Math.min(Math.max(6,Math.floor(Y/2)),Y-3))
 *
 * In both shapes we drop the `/2` by replacing `Math.floor(ROWS/2)` with the
 * rows var, so the height resolves to (near-)full terminal height.
 */
const patchHelpMenuHeight = (file: string): string | null => {
  // Method 1 (CC ≥ 2.1.148): ternary + Math.min(Math.max(6,...),ROWS-3) clamp.
  // Replacing Math.floor(ROWS/2) with ROWS makes the clamp resolve to ROWS-3.
  const m1 =
    /\{rows:([\w$]+),columns:[\w$]+\}=[\w$]+\(\),[\w$]+=[\w$]+\?[\w$]+:Math\.max\(1,Math\.min\(Math\.max\(6,Math\.floor\(\1\/2\)\),\1-3\)\)/;
  const match1 = file.match(m1);
  if (match1 && match1.index !== undefined) {
    const rowsVar = match1[1];
    const floorStr = `Math.floor(${rowsVar}/2)`;
    const floorStart = match1.index + match1[0].indexOf(floorStr);
    const floorEnd = floorStart + floorStr.length;
    const newFile = file.slice(0, floorStart) + rowsVar + file.slice(floorEnd);
    showDiff(file, newFile, rowsVar, floorStart, floorEnd);
    return newFile;
  }

  // Method 2 (CC ≤ 2.1.150): direct assignment VAR=Math.floor(ROWS/2).
  const halfHeightPattern =
    /\{rows:([\w$]+),columns:[\w$]+\}=[\w$]+\(\),([\w$]+)=Math\.floor\(\1\/2\)/;
  const halfHeightMatch = file.match(halfHeightPattern);

  if (halfHeightMatch && halfHeightMatch.index !== undefined) {
    const assignStart =
      halfHeightMatch.index +
      halfHeightMatch[0].indexOf(halfHeightMatch[2] + '=Math.floor(');
    const assignEnd = halfHeightMatch.index + halfHeightMatch[0].length;
    const replacement = `${halfHeightMatch[2]}=${halfHeightMatch[1]}`;

    const newFile =
      file.slice(0, assignStart) + replacement + file.slice(assignEnd);

    showDiff(file, newFile, replacement, assignStart, assignEnd);
    return newFile;
  }

  // CC >= 2.1.152: function computes Math.max(1,Math.floor((rows-CONST)/modeDivisor)).
  // Keep the small subtraction for prompt chrome, but remove the mode divisor cap.
  const modeDivisorPattern =
    /Math\.max\(1,Math\.floor\(\(([\w$]+)-([\w$]+)\)\/([\w$]+)\)\)/g;
  let modeDivisorMatch: RegExpExecArray | null;

  while ((modeDivisorMatch = modeDivisorPattern.exec(file)) !== null) {
    const nearbyStart = Math.max(0, modeDivisorMatch.index - 250);
    const nearby = file.slice(nearbyStart, modeDivisorMatch.index);
    if (!nearby.includes('"expanded"?3') || !nearby.includes('"compact"?1:2')) {
      continue;
    }

    const startIndex = modeDivisorMatch.index;
    const endIndex = modeDivisorMatch.index + modeDivisorMatch[0].length;
    const replacement = `Math.max(1,${modeDivisorMatch[1]}-${modeDivisorMatch[2]})`;
    const newFile =
      file.slice(0, startIndex) + replacement + file.slice(endIndex);

    showDiff(file, newFile, replacement, startIndex, endIndex);
    return newFile;
  }

  return null;
};

/**
 * Patch Commands.tsx visibleCount formula.
 *
 * Original: Math.max(1,Math.floor((maxHeight-10)/2))
 * Patched:  Math.max(1,maxHeight-3)
 *
 * The original divides by 2 again, severely limiting visible items.
 */
const uncappedCommandsListPattern =
  /\{commands:[\w$]+\}=[\w$]+,\{headerFocused:[\w$]+,focusHeader:[\w$]+\}=[\w$]+\(\)[^]{0,600}?maxVisibleCount:Infinity,onUpFromFirstItem:/;

const patchCommandsVisibleCount = (file: string): string | null => {
  const pattern = /Math\.max\(1,Math\.floor\(\(([\w$]+)-10\)\/2\)\)/;
  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    if (uncappedCommandsListPattern.test(file)) {
      debug(
        'patch: showMoreItemsInSelectMenus: commands list already uncapped (maxVisibleCount:Infinity) — no-op'
      );
      return file;
    }
    return null;
  }

  const maxHeightVar = match[1];
  const replacement = `Math.max(1,${maxHeightVar}-3)`;

  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);

  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );

  return newFile;
};

/**
 * Patch the slash command autocomplete suggestions cap.
 *
 * Original: Math.min(6, Math.max(1, rows - 3))
 * Patched:  Math.max(1, rows - 3)
 *
 * The Math.min(6,...) hardcaps visible suggestions to 6.
 *
 * CC ≥ 2.1.133 removed this hardcap — the literal `Math.min(6,Math.max(1,`
 * no longer appears in cli.js. When that happens, treat the patch as a
 * no-op. Only fail loud when the anchor exists but the surrounding shape is new.
 */
const patchSuggestionsCap = (file: string): string | null => {
  if (!file.includes('Math.min(6,Math.max(1,')) {
    debug(
      'patch: showMoreItemsInSelectMenus: suggestions cap already removed in this CC build — no-op'
    );
    return file;
  }

  const pattern = /Math\.min\(6,Math\.max\(1,([\w$]+)-3\)\)/;
  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    return null;
  }

  const rowsVar = match[1];
  const replacement = `Math.max(1,${rowsVar}-3)`;

  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);

  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );

  return newFile;
};

export const writeShowMoreItemsInSelectMenus = (
  oldFile: string,
  numberOfItems: number
): string | null => {
  const locations = getShowMoreItemsInSelectMenusLocation(oldFile);
  if (locations.length === 0) {
    console.error(
      'patch: writeShowMoreItemsInSelectMenus: failed to find locations'
    );
    return null;
  }

  // Sort locations by start index in descending order to apply from end to beginning
  const sortedLocations = locations.sort((a, b) => b.startIndex - a.startIndex);

  let newFile = oldFile;
  for (const location of sortedLocations) {
    const newContent = numberOfItems.toString();
    const updatedFile =
      newFile.slice(0, location.startIndex) +
      newContent +
      newFile.slice(location.endIndex);

    showDiff(
      newFile,
      updatedFile,
      newContent,
      location.startIndex,
      location.endIndex
    );
    newFile = updatedFile;
  }

  // Also patch the help/command menu height cap (rows/2 → rows)
  const heightPatched = patchHelpMenuHeight(newFile);
  if (heightPatched) {
    newFile = heightPatched;
  } else {
    console.error(
      'patch: writeShowMoreItemsInSelectMenus: failed to find help menu height pattern'
    );
  }

  // Also patch the visibleCount formula in Commands.tsx
  // Math.max(1,Math.floor((maxHeight-10)/2)) → Math.max(1,maxHeight-3)
  // The /2 halves the already-limited height again unnecessarily
  const visibleCountPatched = patchCommandsVisibleCount(newFile);
  if (visibleCountPatched) {
    newFile = visibleCountPatched;
  } else {
    console.error(
      'patch: writeShowMoreItemsInSelectMenus: failed to find visibleCount pattern'
    );
  }

  // Also patch the slash command autocomplete suggestions cap when present.
  // Math.min(6,Math.max(1,rows-3)) → Math.max(1,rows-3)
  // CC 2.1.138 removed this obsolete non-overlay fallback, so absence is OK.
  const suggestionsPatched = patchSuggestionsCap(newFile);
  if (suggestionsPatched) {
    newFile = suggestionsPatched;
  }

  return newFile;
};
