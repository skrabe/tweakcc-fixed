// Please see the note about writing patches in ./index

import { LocationResult, showDiff } from './index';

const getVerbosePropertyLocation = (oldFile: string): LocationResult | null => {
  // Older CC shape: createElement(X, {...spinnerTip...overrideMessage...})
  const createElementPattern =
    /createElement\([$\w]+,\{[^}]+spinnerTip[^}]+overrideMessage[^}]+\}/;
  // CC >= 2.1.113: the spinner component receives its props as a destructured
  // function parameter rather than a createElement object literal, and
  // spinnerTip is no longer on the same object (it's pulled from state
  // separately). Anchor on overrideMessage + verbose instead.
  const destructurePattern =
    /\{[^{}]{0,400}overrideMessage:[$\w]+,[^{}]{0,200}verbose:[^,}]+[^{}]{0,200}\}/;

  const createElementMatch =
    oldFile.match(createElementPattern) || oldFile.match(destructurePattern);

  if (!createElementMatch || createElementMatch.index === undefined) {
    console.error(
      'patch: verbose: failed to find spinner props containing overrideMessage and verbose'
    );
    return null;
  }

  const extractedString = createElementMatch[0];

  const verbosePattern = /verbose:[^,}]+/;
  const verboseMatch = extractedString.match(verbosePattern);

  if (!verboseMatch || verboseMatch.index === undefined) {
    console.error('patch: verbose: failed to find verbose property');
    return null;
  }

  // Calculate absolute positions in the original file
  const absoluteVerboseStart = createElementMatch.index + verboseMatch.index;
  const absoluteVerboseEnd = absoluteVerboseStart + verboseMatch[0].length;

  return {
    startIndex: absoluteVerboseStart,
    endIndex: absoluteVerboseEnd,
  };
};

export const writeVerboseProperty = (oldFile: string): string | null => {
  const location = getVerbosePropertyLocation(oldFile);
  if (!location) {
    return null;
  }

  const newCode = 'verbose:true';
  const newFile =
    oldFile.slice(0, location.startIndex) +
    newCode +
    oldFile.slice(location.endIndex);

  showDiff(oldFile, newFile, newCode, location.startIndex, location.endIndex);
  return newFile;
};
