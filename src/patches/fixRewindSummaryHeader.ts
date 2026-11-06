// Fix Rewind Summary Header Patch
//
// When you rewind the conversation and pick "Summarize from here" / "Summarize
// up to here", CC inserts the summary with the SAME header it uses for
// auto/manual context-overflow compaction:
//   "This session is being continued from a previous conversation that ran out
//    of context. The summary below covers the earlier portion of the conversation."
// That's a lie for a rewind — nothing ran out of context; the user deliberately
// rewound and asked to carry a summary forward. The header is built inside a
// shared helper used by all summary paths, so we act ONLY at the rewind call
// site, which is the one tagged with `summarizeMetadata.direction`
// ("from" | "up_to"). The direction var is in scope there, so the note is
// direction-aware. Auto/manual compaction is untouched.
//
// The header itself stays verbatim and the correction is appended after the
// summary: the transcript renderer, the tool-name parser and the share
// redactor all find a summary by that exact header text, and the redactor
// would let a rewind summary through in saved API requests without it.
//
// Futureproofing: anchors key on stable English property names
// (isCompactSummary / summarizeMetadata / messagesSummarized / direction) and
// capture every minified identifier, so version-to-version renames don't break
// it. If the call site or the header phrase is gone, the patch FAILS LOUD at
// --apply (returns null).

import { debug } from '../utils';
import { findClosingBracket } from './helpers';
import { showDiff } from './index';

const HEADER_PHRASE =
  'This session is being continued from a previous conversation that ran out of context';

// Concise, honest, direction-aware notes (no $ / no " to stay literal).
const NOTE_MARKER = 'This summary comes from a rewind';
const FROM_NOTE = `${NOTE_MARKER} at your request, not a context overflow: it captures the later work you chose to carry forward, and the messages above are intact.`;
const UP_TO_NOTE = `${NOTE_MARKER} at your request, not a context overflow: it covers the earlier portion up to your selected point, and the recent messages are kept intact.`;

// The rewind-site tail: `}),isCompactSummary:!0,...<J>.length>0?{summarizeMetadata:{…,direction:<T>}}`.
// [1] the isCompactSummary…summarizeMetadata tail, [2] the direction var.
const REWIND_TAIL_RE =
  /\}\),(isCompactSummary:!0,\.\.\.[$\w]+\.length>0\?\{summarizeMetadata:\{messagesSummarized:[$\w]+\.length,userContext:[$\w]+,direction:([$\w]+)\}\})/;

// Method 1 (CC >= 2.1.318): the spread helper call whose options object holds
// nested objects, e.g. ...Yte(Qt,{…,...ae()&&Ni()&&{replBindingsKept:…},…}).
// Anchors on the unique rewind tail, then finds the `...H(A,{` whose options
// object closes exactly at that tail (balanced-bracket scan, so any nesting).
// Returns a match shaped like the regex methods: [full, call, tail, dirVar].
const matchNestedSpreadCall = (file: string): RegExpMatchArray | null => {
  const tail = REWIND_TAIL_RE.exec(file);
  if (!tail) return null;
  const startRe = /\.\.\.[$\w]+\([$\w]+,\{/g;
  startRe.lastIndex = Math.max(0, tail.index - 8000);
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(file)) && m.index < tail.index) {
    const open = m.index + m[0].length - 1;
    if (findClosingBracket(file, open, tail.index + 1) !== tail.index) continue;
    const end = tail.index + tail[0].length;
    const result = [
      file.slice(m.index, end),
      file.slice(m.index + 3, tail.index + 2),
      tail[1],
      tail[2],
    ] as unknown as RegExpMatchArray;
    result.index = m.index;
    return result;
  }
  return null;
};

export const writeFixRewindSummaryHeader = (file: string): string | null => {
  // The rewind summary message: content:<header helper call>,isCompactSummary:!0,...<J>.length>0?{summarizeMetadata:{messagesSummarized:<j>.length,userContext:<O>,direction:<T>}}
  // Method 1 (matchNestedSpreadCall, above) runs first; the regex fallbacks
  // below cover older shapes. Every method captures the same 3 groups: [1] the header-helper call to wrap,
  // [2] the isCompactSummary…summarizeMetadata tail, [3] the direction var.
  const patterns = [
    // Method 2 (CC 2.1.285–2.1.317): the helper returns a message-fields object
    // ({content,modelOnlyText?}) that is spread into the message, e.g.
    // ke({...a2(Ut,{suppressFollowUpQuestions:!1,...}),isCompactSummary:!0,...}).
    /\.\.\.([$\w]+\([$\w]+,\{[^}]*\}\)),(isCompactSummary:!0,\.\.\.[$\w]+\.length>0\?\{summarizeMetadata:\{messagesSummarized:[$\w]+\.length,userContext:[$\w]+,direction:([$\w]+)\}\})/,
    // Method 3 (CC 2.1.210+): the header helper takes an options-object arg,
    // e.g. X6r(H,{suppressFollowUpQuestions:!1,transcriptPath:V,replStateCleared:j}).
    // Tolerant of object-key reorder/additions (no nested braces at this site).
    /content:([$\w]+\([$\w]+,\{[^}]*\}\)),(isCompactSummary:!0,\.\.\.[$\w]+\.length>0\?\{summarizeMetadata:\{messagesSummarized:[$\w]+\.length,userContext:[$\w]+,direction:([$\w]+)\}\})/,
    // Method 4 (<= CC 2.1.209): positional-arg helper, e.g. jR_(y,!1,r,void 0,s).
    /content:([$\w]+\([$\w]+,!1,[$\w]+,void 0,[$\w]+\)),(isCompactSummary:!0,\.\.\.[$\w]+\.length>0\?\{summarizeMetadata:\{messagesSummarized:[$\w]+\.length,userContext:[$\w]+,direction:([$\w]+)\}\})/,
  ];
  let match: RegExpMatchArray | null = matchNestedSpreadCall(file);
  for (const pattern of match ? [] : patterns) {
    match = file.match(pattern);
    if (match && match.index !== undefined) break;
    match = null;
  }

  if (!match || match.index === undefined) {
    if (file.includes(NOTE_MARKER)) {
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
  const spread = match[0].startsWith('...');
  const note = `"\\n\\n"+(${dirVar}==="up_to"?${JSON.stringify(UP_TO_NOTE)}:${JSON.stringify(FROM_NOTE)})`;
  const replacement = spread
    ? `...(($rw)=>({...$rw,content:$rw.content+${note}}))(${jrCall}),${metaTail}`
    : `content:${jrCall}+${note},${metaTail}`;
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
