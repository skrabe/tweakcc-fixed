// Please see the note about writing patches in ./index
//
// Runs the compaction summarizer at "high" reasoning effort, whatever effort
// the session is on. The summary call otherwise inherits the session's effort,
// and at medium it writes noticeably thinner summaries: on real transcripts
// cut at their compaction point, high effort kept every fact the medium
// summaries kept plus the branch tips, rules and traps they dropped, and sized
// itself to the remaining work (about 2k tokens when the work was done, 4k
// when it was not).
//
// Three call sites, all tagged querySource "compact":
//   - the cache-sharing fork:   …querySource:"compact",forkLabel:"compact",maxTurns:1,…
//   - the reactive-compact fork …querySource:"compact",forkLabel:"reactive-compact",maxTurns:1,…
//   - the non-fork fallback:    …querySource:"compact",sendSideQueryBeta:…,effortValue:…
// The forks take `pinnedEffort`, which CC already uses for plugin-hook forks
// and which becomes the request's `hookEffortValue`; the fallback passes
// request options directly, so it takes `hookEffortValue`. A pinned value wins
// over the session's effort in CC's effort resolver and is still clamped to
// what the model supports.

import { showDiff } from './index';

const FORK =
  /querySource:"compact",forkLabel:"(?:reactive-)?compact",maxTurns:1,(?!pinnedEffort:)/g;
const SIDE = /querySource:"compact",(?=sendSideQueryBeta:)/g;

export const writeCompactionHighEffort = (oldFile: string): string | null => {
  const forks = [...oldFile.matchAll(FORK)].length;
  const sides = [...oldFile.matchAll(SIDE)].length;
  if (forks === 0 && sides === 0) {
    if (
      oldFile.includes('maxTurns:1,pinnedEffort:"high"') ||
      oldFile.includes('querySource:"compact",hookEffortValue:"high"')
    )
      return oldFile;
    console.error(
      'patch: compactionHighEffort: failed to find the compaction summarizer calls'
    );
    return null;
  }

  let newFile = oldFile.replace(FORK, m => `${m}pinnedEffort:"high",`);
  newFile = newFile.replace(
    SIDE,
    'querySource:"compact",hookEffortValue:"high",'
  );
  const at = oldFile.indexOf('querySource:"compact"');
  showDiff(oldFile, newFile, 'pinnedEffort:"high"', at, at);
  return newFile;
};
