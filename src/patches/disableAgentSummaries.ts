// Please see the note about writing patches in ./index
//
// Stops the per-agent progress summarizer. Every ~30 s, for each running
// background agent, CC forks the agent's whole transcript to the agent's own
// model (usually Opus) and asks for a 3-5 word "most recent action" label for
// the agents panel. No setting turns it off: the SDK option and env var can
// only enable it, and the interval is a server flag clamped to 30-240 s.
//
// The summarizer owns a single timer, armed by one scheduler:
//
//     async function Ee(){if(ie)return;...t(`[AgentSummary] Timer fired ...`)
//     ...
//     function me(){if(ie)return;j=setTimeout(Ee,Te>0?cn:v)}        (2.1.316)
//     function xe(){if(j)return;...;Pe+=Re,ue=setTimeout(Me,Re)}     (2.1.312)
//
// We make the scheduler return before arming, so no summary request is ever
// sent. The rest of the summarizer (stop handle, cleanup) stays intact, and
// the agent row falls back to its launch description.

import { showDiff } from './index';

const MARKER = '/*tweakcc:disable-agent-summaries*/';
const ANCHOR = '[AgentSummary] Timer fired';

export const writeDisableAgentSummaries = (oldFile: string): string | null => {
  if (oldFile.includes(MARKER)) return oldFile;

  const anchorIdx = oldFile.indexOf(ANCHOR);
  if (anchorIdx === -1) {
    console.log(
      'patch: disableAgentSummaries: agent summarizer not present — no-op'
    );
    return oldFile;
  }

  const head = oldFile.slice(Math.max(0, anchorIdx - 600), anchorIdx);
  const cbMatch = head.match(
    /async function ([$\w]+)\(\)\{if\(([$\w]+)\)return;[^{}]*$/
  );
  if (!cbMatch) {
    console.error(
      'patch: disableAgentSummaries: failed to find summary timer callback'
    );
    return null;
  }
  const [, callback, stopFlag] = cbMatch;

  const esc = (s: string) => s.replace(/\$/g, '\\$');
  const schedulerHead = `function ([$\\w]+)\\(\\)\\{if\\(${esc(stopFlag)}\\)return;`;
  const schedulerRes = [
    // CC 2.1.316: the delay is an expression (`Te>0?cn:v`).
    new RegExp(
      schedulerHead + `[$\\w]+=setTimeout\\(${esc(callback)},[^(){};,]+\\)\\}`
    ),
    // CC 2.1.312: the delay is a plain identifier.
    new RegExp(
      schedulerHead + `[^{}]*?=setTimeout\\(${esc(callback)},[$\\w]+\\)\\}`
    ),
  ];
  const searchFrom = anchorIdx;
  const tail = oldFile.slice(searchFrom, searchFrom + 20000);
  let m: RegExpMatchArray | null = null;
  for (const re of schedulerRes) {
    m = tail.match(re);
    if (m) break;
  }
  if (!m || m.index === undefined) {
    console.error(
      'patch: disableAgentSummaries: failed to find summary timer scheduler'
    );
    return null;
  }

  const start = searchFrom + m.index;
  const prefix = `function ${m[1]}(){`;
  const replacement = `${prefix}${MARKER}return;${m[0].slice(prefix.length)}`;
  const end = start + m[0].length;
  const newFile = oldFile.slice(0, start) + replacement + oldFile.slice(end);
  showDiff(oldFile, newFile, replacement, start, end);
  return newFile;
};
