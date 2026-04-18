// Please see the note about writing patches in ./index

import { showDiff } from './index';

interface VerboseEdit {
  startIndex: number;
  endIndex: number;
  replacement: string;
}

const getVerbosePropertyEdit = (oldFile: string): VerboseEdit | null => {
  // Older CC shape: createElement(X, {...spinnerTip...overrideMessage...}).
  // Here, `verbose:X` is an object-literal value and can be safely replaced
  // with the literal `verbose:true`.
  const createElementPattern =
    /createElement\([$\w]+,\{[^}]+spinnerTip[^}]+overrideMessage[^}]+\}/;
  const objLitMatch = oldFile.match(createElementPattern);
  if (objLitMatch && objLitMatch.index !== undefined) {
    const verboseMatch = objLitMatch[0].match(/verbose:[^,}]+/);
    if (!verboseMatch || verboseMatch.index === undefined) {
      console.error('patch: verbose: failed to find verbose property');
      return null;
    }
    const start = objLitMatch.index + verboseMatch.index;
    return {
      startIndex: start,
      endIndex: start + verboseMatch[0].length,
      replacement: 'verbose:true',
    };
  }

  // CC >= 2.1.113: props are a destructured function parameter
  //   function X({...,overrideMessage:z,spinnerSuffix:M,verbose:Y,...}){...}
  // Replacing `verbose:Y` with `verbose:true` is a SyntaxError in this
  // context (the right-hand side of a destructure binding must be an
  // assignment target, not a literal). Instead: leave the destructure alone
  // and inject `Y=!0;` at the start of the function body so the local
  // variable is always forced true regardless of caller.
  const destructurePattern =
    /\{[^{}]{0,400}overrideMessage:[$\w]+,[^{}]{0,200}verbose:([$\w]+)[^{}]{0,200}\}\)\{/;
  const destructureMatch = oldFile.match(destructurePattern);
  if (destructureMatch && destructureMatch.index !== undefined) {
    const varName = destructureMatch[1];
    // Position right after the `){` that opens the function body
    const bodyStart = destructureMatch.index + destructureMatch[0].length;
    return {
      startIndex: bodyStart,
      endIndex: bodyStart,
      replacement: `${varName}=!0;`,
    };
  }

  console.error(
    'patch: verbose: failed to find spinner props containing overrideMessage and verbose'
  );
  return null;
};

export const writeVerboseProperty = (oldFile: string): string | null => {
  const edit = getVerbosePropertyEdit(oldFile);
  if (!edit) {
    return null;
  }

  const newFile =
    oldFile.slice(0, edit.startIndex) +
    edit.replacement +
    oldFile.slice(edit.endIndex);

  showDiff(oldFile, newFile, edit.replacement, edit.startIndex, edit.endIndex);
  return newFile;
};
