// Please see the note about writing patches in ./index

import * as vm from 'node:vm';

import { showDiff } from './index';

// Per-model context windows, read from the environment at call time:
//   TWEAKCC_MODEL_CONTEXT_TOKENS="qwen36-500k:35b=500000,other:8b=131072"
// CC >= 2.1.223 ships CLAUDE_CODE_MAX_CONTEXT_TOKENS as the window for
// unrecognized models, but it is ONE integer per process — switching between
// local models with /model keeps the first window. This patch keys the same
// fallback branch on the model ID instead, with no runtime state: the lookup
// is the first statement of the window sizer, so the window follows /model.
export const MODEL_CONTEXT_TOKENS_ENV_VAR = 'TWEAKCC_MODEL_CONTEXT_TOKENS';

// Every injected binding carries this prefix: it is the house already-patched
// sentinel (see isPristine in allPatchesAgainstPristine.test.ts) and the
// idempotency guard for re-runs.
const MARKER = '__tweakccMct';

// Window sizer tail (CC 2.1.223+):
//   let d=a.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(d!==void 0&&d>0&&hz(e))return d;return Obe}
// The bare `.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(` prefix ALSO matches CC's
// DISABLE_COMPACT env helper, so the full three-condition tail plus the
// `return IDENT}` closer is what makes the anchor unique. Captures:
//   1: env-value local, 2: env object, 3: MODEL PARAM, 4: default constant.
const patternSizerTail =
  /let ([$\w]+)=([$\w]+)\.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if\(\1!==void 0&&\1>0&&[$\w]+\(([$\w]+)\)\)return \1;return ([$\w]+)\}/g;

// Unknown-model notice builder head:
//   let{source:H,window:q}=tw(w,P,U);if(H!=="unknown-model")return null;
// Captures: 1: source local, 2: window local, 3: resolver fn, 4: MODEL PARAM.
const patternNoticeHead =
  /let\{source:([$\w]+),window:([$\w]+)\}=([$\w]+)\(([$\w]+)[^)]*\);if\(\1!=="unknown-model"\)return null;/g;

// Inline, block-scoped lookup: no top-level declarations (the bundle joins
// ~1,700 ESM modules, so a second splice into the same module would redeclare),
// ASCII-only, env read at CALL time, entries split on the LAST `=` (model IDs
// contain `:` and `/`), matched case-insensitively, malformed entries ignored.
// `returnValue` is what a listed model with a positive value yields: the value
// itself in the sizer, `null` in the notice builder.
const buildLookup = (modelParam: string, returnValue: string): string =>
  `{let ${MARKER}=process.env.${MODEL_CONTEXT_TOKENS_ENV_VAR};if(${MARKER}){` +
  `let ${MARKER}K=typeof ${modelParam}==="string"?${modelParam}:${modelParam}&&${modelParam}.id;` +
  `if(${MARKER}K){${MARKER}K=String(${MARKER}K).toLowerCase();` +
  `for(let ${MARKER}P of ${MARKER}.split(",")){` +
  `let ${MARKER}I=${MARKER}P.lastIndexOf("=");` +
  `if(${MARKER}I>0&&${MARKER}P.slice(0,${MARKER}I).trim().toLowerCase()===${MARKER}K){` +
  `let ${MARKER}V=Math.floor(Number(${MARKER}P.slice(${MARKER}I+1)));` +
  `if(${MARKER}V>0)return ${returnValue}}}}}}`;

interface AnchorSpan {
  start: number;
  end: number;
}

// Walk back from the anchor to the enclosing `function` header, returning the
// header offset and the offset just past the body's opening brace.
//
// The parse oracle is the arrow-function trap guard: if CC reshapes the target
// into an arrow (`Sz=(e,n)=>{…}`), the nearest `function` keyword belongs to an
// unrelated earlier function whose first param may coincidentally match. The
// span from that header to the anchor tail would then be TWO statements — it
// parses bare, but NOT wrapped in parens, so `( span )` forces "exactly one
// function expression" and rejects the false candidate.
const liftEnclosingFunction = (
  file: string,
  anchor: AnchorSpan,
  firstParam: string
): { start: number; bodyAt: number } | null => {
  const headerRe = /^function ?[$\w]*\(([$\w]*)/;
  let i = anchor.start;
  for (let attempt = 0; attempt < 32; attempt++) {
    i = file.lastIndexOf('function', i - 1);
    if (i < 0) return null;
    const prev = i > 0 ? file[i - 1] : ' ';
    if (/[$\w.]/.test(prev)) continue; // part of an identifier / member access
    const span = file.slice(i, anchor.end);
    const header = headerRe.exec(span);
    if (!header || header[1] !== firstParam) continue;
    try {
      new vm.Script(`(${span})`, { filename: 'modelContextTokens-oracle' });
    } catch {
      continue; // not a single complete function — keep walking back
    }
    const open = span.indexOf('{');
    if (open < 0) return null;
    return { start: i, bodyAt: i + open + 1 };
  }
  return null;
};

interface Insertion {
  at: number;
  text: string;
}

// Locate both splice points, or null (loudly) on any anchor drift.
const findInsertions = (file: string): Insertion[] | null => {
  const tails = [...file.matchAll(patternSizerTail)];
  if (tails.length !== 1) {
    console.error(
      `patch: modelContextTokens: expected exactly 1 window-sizer tail, found ${tails.length}`
    );
    return null;
  }
  const notices = [...file.matchAll(patternNoticeHead)];
  if (notices.length !== 1) {
    console.error(
      `patch: modelContextTokens: expected exactly 1 notice-builder head, found ${notices.length}`
    );
    return null;
  }

  const tail = tails[0];
  const notice = notices[0];
  if (tail.index === undefined || notice.index === undefined) return null;
  const tailAnchor = { start: tail.index, end: tail.index + tail[0].length };
  const sizer = liftEnclosingFunction(file, tailAnchor, tail[3]);
  if (!sizer) {
    console.error(
      'patch: modelContextTokens: window-sizer tail is not inside a liftable `function` (arrow reshape?) — refusing to splice'
    );
    return null;
  }

  return [
    { at: sizer.bodyAt, text: buildLookup(tail[3], `${MARKER}V`) },
    {
      at: notice.index + notice[0].length,
      text: buildLookup(notice[4], 'null'),
    },
  ];
};

export const writeModelContextTokens = (oldFile: string): string | null => {
  // Already patched (e.g. tweakcc re-run against a patched backup).
  if (oldFile.includes(MARKER)) return oldFile;

  // CC < 2.1.223 has no env-var window hook at all — nothing to key on.
  // Silent no-op: such a bundle simply predates the hook.
  if (!oldFile.includes('CLAUDE_CODE_MAX_CONTEXT_TOKENS')) return oldFile;

  const insertions = findInsertions(oldFile);
  if (!insertions) return null;

  // Splice back-to-front so earlier offsets stay valid, via slice/concat —
  // never String.replace with a replacement string, because the surrounding
  // minified bundle text can contain `$` sequences.
  let newFile = oldFile;
  for (const insertion of [...insertions].sort((a, b) => b.at - a.at)) {
    newFile =
      newFile.slice(0, insertion.at) +
      insertion.text +
      newFile.slice(insertion.at);
    showDiff(oldFile, newFile, insertion.text, insertion.at, insertion.at);
  }
  return newFile;
};
