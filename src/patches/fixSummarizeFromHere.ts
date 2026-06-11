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
// The whole asymmetry is one ternary in the partial-compaction helper:
//   ...,G=T==="up_to"?j:H,R=T==="up_to"?{...K,forkContextMessages:j}:K,...
// where j is the slice to summarize, H the full conversation, G the messages
// actually sent to the summarizer, R the cache-safe params. For "from", G=H.
//
// Fix: make "from" behave exactly like "up_to" — feed the slice and set the
// matching forkContextMessages — by collapsing both branches to j:
//   ...,G=j,R={...K,forkContextMessages:j},...
// G is only used as the summarizer input and the partial-compact retry base;
// the retained set, resume leaf, and reconstruction use H/J/_, not G, so this
// is isolated to what the summarizer sees.

import { debug } from '../utils';
import { showDiff } from './index';

export const writeFixSummarizeFromHere = (file: string): string | null => {
  const pattern =
    /messagesSummarized:([$\w]+)\.length\},([$\w]+)=([$\w]+)==="up_to"\?\1:([$\w]+),([$\w]+)=\3==="up_to"\?\{\.\.\.([$\w]+),forkContextMessages:\1\}:\6/;
  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    // Idempotency: already-patched shape (both branches collapsed to the slice).
    const patched =
      /messagesSummarized:([$\w]+)\.length\},([$\w]+)=\1,([$\w]+)=\{\.\.\.([$\w]+),forkContextMessages:\1\}/;
    if (patched.test(file)) {
      debug(
        'patch: fixSummarizeFromHere: already applied in this CC build — no-op'
      );
      return file;
    }
    console.error(
      'patch: fixSummarizeFromHere: failed to find the summarize-direction ternary'
    );
    return null;
  }

  const [, j, G, , , R, K] = match;
  const replacement =
    `messagesSummarized:${j}.length},${G}=${j},` +
    `${R}={...${K},forkContextMessages:${j}}`;
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);

  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + replacement.length
  );
  return newFile;
};
