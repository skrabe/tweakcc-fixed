// Please see the note about writing patches in ./index

import { LocationResult, showDiff } from './index';

/**
 * Find the file read token limit (25000) that's associated with file reading.
 *
 * Approach: Find "=25000," and verify a known anchor appears nearby to ensure
 * we're targeting the correct value. Supports multiple anchors across CC versions:
 * - "<system-reminder>" (CC <2.1.83)
 * - "tengu_amber_wren" (CC >=2.1.83)
 */
const getFileReadLimitLocation = (oldFile: string): LocationResult | null => {
  // Method 0 (CC >=2.1.268): the tengu_amber_wren gate is gone and the limits
  // are a plain default object, so bind through its maxTokens fallback:
  //   e.defaultFileReadingLimits??={maxSizeBytes:MSe,maxTokens:FSo()??LSo}
  const defaultsIdent = oldFile.match(
    /defaultFileReadingLimits\?\?=\{maxSizeBytes:[$\w]+,maxTokens:[$\w]+\(\)\?\?([$\w]+)\}/
  );
  if (defaultsIdent) {
    const ident = defaultsIdent[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const decl = oldFile.match(new RegExp(`[^$\\w]${ident}=25000[,;}]`));
    if (decl && decl.index !== undefined) {
      const startIndex = decl.index + decl[0].indexOf('25000');
      return { startIndex, endIndex: startIndex + 5 };
    }
  }

  // Method 1 (CC >=2.1.232): the limit moved OUT of the gate's neighbourhood
  // into its own `var psb=25000` further down, so every anchor-then-value and
  // value-then-anchor window misses it. Bind through the identifier the gate
  // actually falls back to instead of through proximity:
  //   ...t.maxTokens>0?t.maxTokens:psb) ... var psb=25000,
  const fallbackIdent = oldFile.match(
    /tengu_amber_wren[\s\S]{0,800}?\bmaxTokens\s*:\s*([$\w]+)\s*\)/
  );
  if (fallbackIdent) {
    const ident = fallbackIdent[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The declaration is `var psb=25000,fZs=128,` — the char before the
    // identifier is a space after `var`, not punctuation, so exclude only
    // identifier characters rather than listing separators.
    const decl = oldFile.match(new RegExp(`[^$\\w]${ident}=25000[,;}]`));
    if (decl && decl.index !== undefined) {
      const startIndex = decl.index + decl[0].indexOf('25000');
      return { startIndex, endIndex: startIndex + 5 };
    }
  }

  const newConfigRegion = oldFile.match(
    /CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS[\s\S]{0,1200}tengu_amber_wren/
  );
  if (newConfigRegion && newConfigRegion.index !== undefined) {
    const tokenLimitMatch = newConfigRegion[0].match(/=25000,/);
    if (tokenLimitMatch && tokenLimitMatch.index !== undefined) {
      const startIndex = newConfigRegion.index + tokenLimitMatch.index + 1;
      return { startIndex, endIndex: startIndex + 5 };
    }
  }

  // Try anchors in order of preference
  const anchors = ['<system-reminder>', 'tengu_amber_wren'];

  let match: RegExpMatchArray | null = null;
  for (const anchor of anchors) {
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`=25000,([\\s\\S]{0,700})${escaped}`);
    match = oldFile.match(pattern);
    if (match && match.index !== undefined) break;
  }

  if (!match || match.index === undefined) {
    console.error(
      'patch: increaseFileReadLimit: failed to find 25000 token limit near known anchor'
    );
    return null;
  }

  // The "25000" starts at match.index + 1 (after the "=")
  const startIndex = match.index + 1;
  const endIndex = startIndex + 5; // "25000" is 5 characters

  return {
    startIndex,
    endIndex,
  };
};

export const writeIncreaseFileReadLimit = (oldFile: string): string | null => {
  const location = getFileReadLimitLocation(oldFile);
  if (!location) {
    return null;
  }

  const newValue = '1000000';
  const newFile =
    oldFile.slice(0, location.startIndex) +
    newValue +
    oldFile.slice(location.endIndex);

  showDiff(oldFile, newFile, newValue, location.startIndex, location.endIndex);
  return newFile;
};
