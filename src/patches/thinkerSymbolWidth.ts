// Please see the note about writing patches in ./index

import { LocationResult, showDiff } from './index';

const getThinkerSymbolWidthLocation = (
  oldFile: string
): (LocationResult & { prefix: string }) | null => {
  // 2.1.172 added an "aria-hidden":!0 property before flexWrap; keep the
  // bare shape as a fallback for older CC versions.
  const widthPattern =
    /\{("aria-hidden":!0,)?flexWrap:"wrap",height:1,width:2\}/;
  const match = oldFile.match(widthPattern);

  if (!match || match.index == undefined) {
    console.error('patch: thinker symbol width: failed to find match');
    return null;
  }

  return {
    startIndex: match.index,
    endIndex: match.index + match[0].length,
    prefix: match[1] ?? '',
  };
};

export const writeThinkerSymbolWidthLocation = (
  oldFile: string,
  width: number
): string | null => {
  const location = getThinkerSymbolWidthLocation(oldFile);
  if (!location) {
    return null;
  }

  const newCss = `{${location.prefix}flexWrap:"wrap",height:1,width:${width}}`;
  const newFile =
    oldFile.slice(0, location.startIndex) +
    newCss +
    oldFile.slice(location.endIndex);

  showDiff(oldFile, newFile, newCss, location.startIndex, location.endIndex);
  return newFile;
};
