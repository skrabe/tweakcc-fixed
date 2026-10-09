// Please see the note about writing patches in ./index
//
// Propose Goal Patch - force the ProposeGoal tool's rollout flag on.
//
// ProposeGoal lets the model propose a session goal, which the user approves
// with one keypress or which it sets directly. Its `isEnabled` and the
// "Claude-proposed goals" entry in /config both read one GrowthBook flag:
//
//   function N_n(){return k("tengu_propose_goal",!1)}
//
// Forcing it on makes the tool and the setting available wherever the rest of
// `isEnabled` allows (not in agent contexts, not with the setting at
// "disabled", and not in a background session unless
// attached-background-interactive lets an attached one through).
//
// ```diff
//  function N_n() {
// +  return !0;
//    return k("tengu_propose_goal", !1);
//  }
// ```

import { showDiff } from './index';

export const writeProposeGoal = (oldFile: string): string | null => {
  const match = oldFile.match(
    /function [$\w]+\(\)\{(return !0;)?return [$\w]+\("tengu_propose_goal",!1\)/
  );
  if (!match || match.index === undefined) {
    console.error(
      'patch: proposeGoal: failed to find the tengu_propose_goal gate'
    );
    return null;
  }
  if (match[1]) return oldFile;
  const insertIndex = match.index + match[0].indexOf('{') + 1;
  const insertion = 'return !0;';
  const newFile =
    oldFile.slice(0, insertIndex) + insertion + oldFile.slice(insertIndex);
  showDiff(oldFile, newFile, insertion, insertIndex, insertIndex);
  return newFile;
};
