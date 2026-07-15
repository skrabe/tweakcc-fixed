// Fix Rewind Summary Header Patch
//
// When you rewind the conversation and pick "Summarize from here" / "Summarize
// up to here", CC inserts the summary with the SAME header it uses for
// auto/manual context-overflow compaction:
//   "This session is being continued from a previous conversation that ran out
//    of context. The summary below covers the earlier portion of the conversation."
// That's a lie for a rewind — nothing ran out of context; the user deliberately
// rewound and asked to carry a summary forward. The header is built inside a
// shared helper (jR_) used by all summary paths, so we rewrite it ONLY at the
// rewind call site, which is the one tagged with `summarizeMetadata.direction`
// ("from" | "up_to"). The direction var is in scope there, so the new header is
// direction-aware. Auto/manual compaction is untouched.
//
// Futureproofing: anchors key on stable English property names
// (isCompactSummary / summarizeMetadata / messagesSummarized / direction) and
// capture every minified identifier, so version-to-version renames don't break
// it. The runtime swap matches the stable opening phrase (tolerant of
// second-sentence drift). If the call site or that phrase is gone, the patch
// FAILS LOUD at --apply (returns null) rather than silently reverting to the
// misleading header.

import { debug } from '../utils';
import { showDiff } from './index';

const HEADER_PHRASE =
  'This session is being continued from a previous conversation that ran out of context';

// Concise, honest, direction-aware replacements (no $ / no " to stay literal).
const FROM_HEADER =
  'This session was rewound to an earlier point at your request, not a context overflow. The summary below captures the later work you chose to carry forward; the messages above are intact.';
const UP_TO_HEADER =
  'This session was rewound at your request, not a context overflow. The summary below covers the earlier portion up to your selected point; the recent messages are kept intact.';

export const writeFixRewindSummaryHeader = (file: string): string | null => {
  // The rewind summary message: content:<header helper call>,isCompactSummary:!0,...<J>.length>0?{summarizeMetadata:{messagesSummarized:<j>.length,userContext:<O>,direction:<T>}}
  // Every method captures the same 3 groups: [1] the header-helper call to wrap,
  // [2] the isCompactSummary…summarizeMetadata tail, [3] the direction var.
  const patterns = [
    // Method 1 (CC 2.1.210+): the header helper takes an options-object arg,
    // e.g. X6r(H,{suppressFollowUpQuestions:!1,transcriptPath:V,replStateCleared:j}).
    // Tolerant of object-key reorder/additions (no nested braces at this site).
    /content:([$\w]+\([$\w]+,\{[^}]*\}\)),(isCompactSummary:!0,\.\.\.[$\w]+\.length>0\?\{summarizeMetadata:\{messagesSummarized:[$\w]+\.length,userContext:[$\w]+,direction:([$\w]+)\}\})/,
    // Method 2 (<= CC 2.1.209): positional-arg helper, e.g. jR_(y,!1,r,void 0,s).
    /content:([$\w]+\([$\w]+,!1,[$\w]+,void 0,[$\w]+\)),(isCompactSummary:!0,\.\.\.[$\w]+\.length>0\?\{summarizeMetadata:\{messagesSummarized:[$\w]+\.length,userContext:[$\w]+,direction:([$\w]+)\}\})/,
  ];
  let match: RegExpMatchArray | null = null;
  for (const pattern of patterns) {
    match = file.match(pattern);
    if (match && match.index !== undefined) break;
    match = null;
  }

  if (!match || match.index === undefined) {
    if (file.includes('.replace(/This session is being continued')) {
      debug(
        'patch: fixRewindSummaryHeader: already applied in this CC build — no-op'
      );
      return file;
    }
    console.error(
      'patch: fixRewindSummaryHeader: failed to find the rewind summary message (summarizeMetadata.direction call site)'
    );
    return null;
  }

  if (!file.includes(HEADER_PHRASE)) {
    console.error(
      'patch: fixRewindSummaryHeader: rewind call site found but the compaction header phrase changed — needs re-anchoring'
    );
    return null;
  }

  const [, jrCall, metaTail, dirVar] = match;
  // Replace the whole header line (stable phrase + remainder up to the blank line).
  const swap =
    `${jrCall}.replace(/This session is being continued from a previous conversation that ran out of context\\.[^\\n]*/,` +
    `${dirVar}==="up_to"?${JSON.stringify(UP_TO_HEADER)}:${JSON.stringify(FROM_HEADER)})`;
  const replacement = `content:${swap},${metaTail}`;
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
