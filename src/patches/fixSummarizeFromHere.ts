// Fix "Summarize from here" Patch
//
// The message-selector offers two summary actions: "Summarize up to here"
// (summarize the OLD messages, keep recent) and "Summarize from here"
// (summarize the RECENT messages after the rewind point, keep the earlier
// ones). The "up_to" path feeds the summarizer ONLY the slice it should
// summarize; the "from" path feeds it the ENTIRE conversation and relies on
// the prompt's "summarize the recent portion" wording with no positional
// marker — so the model can't tell where "recent" begins and over-summarizes
// (typically everything up to the selected point).
//
// The whole asymmetry is two ternaries in the partial-compaction helper:
//   ...,G=T==="up_to"?j:H,R=T==="up_to"?{...K,forkContextMessages:j}:K,...
// where j is the slice to summarize, H the full conversation, G the messages
// actually sent to the summarizer, R the cache-safe params. For "from", G=H.
//
// Since CC 2.1.318 an expression sits between the two ternaries:
//   ...,G=T==="up_to"?j:H,X=Q+M(G).map((n)=>`\n\n${n}`).join(""),R=...
// X is the prompt-too-long retry request: the summary prompt plus every
// preservation marker (M lists the marker constants present in G). With G
// collapsed to the slice, X lists the markers of the summarized part — the
// part being replaced; the kept messages carry their own markers verbatim.
// The intermediate expression is reproduced untouched.
//
// Fix: make "from" behave exactly like "up_to" — feed the slice and set the
// matching forkContextMessages — by collapsing both branches to j:
//   ...,G=j,[X=...,]R={...K,forkContextMessages:j},...
// G is only used as the summarizer input, the partial-compact retry base, the
// retry request's marker list, and reply telemetry; the retained set, resume
// leaf, and reconstruction use H/J/_, not G, so this is isolated to what the
// summarizer sees.

import { debug } from '../utils';
import { showDiff } from './index';

// Method 1 (CC >= 2.1.318): ternaries separated by the retry-request expression.
const METHOD1 =
  /messagesSummarized:([$\w]+)\.length\},([$\w]+)=([$\w]+)==="up_to"\?\1:([$\w]+),(([$\w]+)=[$\w]+\+[$\w]+\(\2\)\.map\(\(([$\w]+)\)=>`(?:\n|\\n){2}\$\{\7\}`\)\.join\(""\)),([$\w]+)=\3==="up_to"\?\{\.\.\.([$\w]+),forkContextMessages:\1\}:\9/;
const METHOD1_PATCHED =
  /messagesSummarized:([$\w]+)\.length\},([$\w]+)=\1,[$\w]+=[$\w]+\+[$\w]+\(\2\)\.map\(\(([$\w]+)\)=>`(?:\n|\\n){2}\$\{\3\}`\)\.join\(""\),[$\w]+=\{\.\.\.[$\w]+,forkContextMessages:\1\}/;

// Method 2 (CC < 2.1.318): the two ternaries are adjacent.
const METHOD2 =
  /messagesSummarized:([$\w]+)\.length\},([$\w]+)=([$\w]+)==="up_to"\?\1:([$\w]+),([$\w]+)=\3==="up_to"\?\{\.\.\.([$\w]+),forkContextMessages:\1\}:\6/;
const METHOD2_PATCHED =
  /messagesSummarized:([$\w]+)\.length\},([$\w]+)=\1,([$\w]+)=\{\.\.\.([$\w]+),forkContextMessages:\1\}/;

const splice = (
  file: string,
  index: number,
  length: number,
  replacement: string
): string => {
  const newFile =
    file.slice(0, index) + replacement + file.slice(index + length);
  showDiff(file, newFile, replacement, index, index + replacement.length);
  return newFile;
};

export const writeFixSummarizeFromHere = (file: string): string | null => {
  const m1 = file.match(METHOD1);
  if (m1 && m1.index !== undefined) {
    const [, j, G, , , mid, , , R, K] = m1;
    const replacement =
      `messagesSummarized:${j}.length},${G}=${j},${mid},` +
      `${R}={...${K},forkContextMessages:${j}}`;
    return splice(file, m1.index, m1[0].length, replacement);
  }

  const m2 = file.match(METHOD2);
  if (m2 && m2.index !== undefined) {
    const [, j, G, , , R, K] = m2;
    const replacement =
      `messagesSummarized:${j}.length},${G}=${j},` +
      `${R}={...${K},forkContextMessages:${j}}`;
    return splice(file, m2.index, m2[0].length, replacement);
  }

  // Idempotency: already-patched shape (both branches collapsed to the slice).
  if (METHOD1_PATCHED.test(file) || METHOD2_PATCHED.test(file)) {
    debug(
      'patch: fixSummarizeFromHere: already applied in this CC build — no-op'
    );
    return file;
  }
  console.error(
    'patch: fixSummarizeFromHere: failed to find the summarize-direction ternary'
  );
  return null;
};
