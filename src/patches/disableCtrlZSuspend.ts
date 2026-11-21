// Please see the note about writing patches in ./index

import { showDiff } from './index';

// Ink's input loop suspends on Ctrl-Z before keybinding dispatch:
//   if(T.name==="z"&&T.ctrl&&tYn()){n.handleSuspend();continue}
// Short-circuit the condition so Ctrl-Z falls through as a normal key.
export const writeDisableCtrlZSuspend = (oldFile: string): string | null => {
  const patterns = [
    /if\(([$\w]+)\.name==="z"&&\1\.ctrl&&[$\w]+\(\)\)\{[$\w]+\.props\.terminal\.handleSuspend\(\);continue\}/,
    /if\(([$\w]+)\.name==="z"&&\1\.ctrl&&[$\w]+\(\)\)\{[$\w]+\.handleSuspend\(\);continue\}/,
  ];
  const match = patterns
    .map(pattern => oldFile.match(pattern))
    .find(m => m !== null);
  if (!match || match.index === undefined) {
    console.error(
      'patch: disableCtrlZSuspend: failed to find Ctrl-Z handleSuspend check'
    );
    return null;
  }

  const startIndex = match.index + 'if('.length;
  const newCode = '!1&&';
  const newFile =
    oldFile.slice(0, startIndex) + newCode + oldFile.slice(startIndex);

  showDiff(oldFile, newFile, newCode, startIndex, startIndex);
  return newFile;
};
