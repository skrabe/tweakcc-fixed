#!/usr/bin/env node
// Lifts the two functions that modelContextTokens.ts patches VERBATIM out of a
// pristine Claude Code bundle, so test fixtures are generated rather than
// retyped (retyped minified fixtures silently drift from reality).
//
// Usage: node tools/liftModelContextTokensFixtures.mjs <path-to-cli.js-or-bun-binary> [...]
// Prints one JSON document per input file:
//   { file, version?, sizer: { src, names }, notice: { src, names } }
//
// The anchors mirror src/patches/modelContextTokens.ts exactly; if this script
// fails on a new CC build, the patch will too (by design — loud failure).
import { readFileSync } from 'node:fs';
import * as vm from 'node:vm';

// Window sizer tail: `let d=a.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(d!==void 0&&d>0&&hz(e))return d;return Obe}`
// The bare `.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(` prefix ALSO matches CC's
// DISABLE_COMPACT env helper, so the full three-condition tail plus the
// `return IDENT}` closer is required for uniqueness.
const patternSizerTail =
  /let ([$\w]+)=([$\w]+)\.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if\(\1!==void 0&&\1>0&&[$\w]+\(([$\w]+)\)\)return \1;return ([$\w]+)\}/g;

// Notice builder head: `let{source:H,window:q}=tw(w,P,U);if(H!=="unknown-model")return null;`
const patternNoticeHead =
  /let\{source:([$\w]+),window:([$\w]+)\}=([$\w]+)\(([$\w]+)[^)]*\);if\(\1!=="unknown-model"\)return null;/g;

// Walk back from the anchor to the enclosing `function` header. The span from
// header to anchor end must parse as EXACTLY ONE function whose first param is
// `firstParam` — the paren wrap is what forces "single function": two
// consecutive complete functions parse bare but not inside `( … )`. This is
// the arrow-function trap guard: if CC reshapes the target into an arrow, the
// nearest `function` header belongs to an unrelated earlier function and the
// span fails the oracle.
function liftEnclosingFunction(file, anchorStart, anchorEnd, firstParam) {
  const headerRe = /^function ?[$\w]*\(([$\w]*)/;
  let i = anchorStart;
  for (let attempt = 0; attempt < 32; attempt++) {
    i = file.lastIndexOf('function', i - 1);
    if (i < 0) return null;
    const prev = i > 0 ? file[i - 1] : ' ';
    if (/[$\w.]/.test(prev)) continue; // part of an identifier / member access
    const span = file.slice(i, anchorEnd);
    const header = headerRe.exec(span);
    if (!header || header[1] !== firstParam) continue;
    try {
      new vm.Script(`(${span})`, { filename: 'lift-oracle' });
    } catch {
      continue;
    }
    const open = span.indexOf('{');
    if (open < 0) return null;
    return { src: span, start: i, bodyAt: i + open + 1 };
  }
  return null;
}

// The notice anchor does not include the function's closing brace; find it by
// brace-matching forward from the validated header. Good enough for these
// small (~650B) functions — the fixture lift is a build-time aid, and the
// patch itself never needs the notice function end.
function findFunctionEnd(file, start) {
  const open = file.indexOf('{', start);
  if (open < 0) return -1;
  let depth = 0;
  for (let j = open; j < file.length && j < open + 20000; j++) {
    const c = file[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

export function liftFromFile(file) {
  const tails = [...file.matchAll(patternSizerTail)];
  const notices = [...file.matchAll(patternNoticeHead)];
  if (tails.length !== 1) {
    throw new Error(
      `expected exactly 1 window-sizer tail, found ${tails.length}`
    );
  }
  if (notices.length !== 1) {
    throw new Error(
      `expected exactly 1 notice-builder head, found ${notices.length}`
    );
  }

  const tail = tails[0];
  const sizer = liftEnclosingFunction(
    file,
    tail.index,
    tail.index + tail[0].length,
    tail[3]
  );
  if (!sizer) throw new Error('failed to lift the window sizer function');

  const notice = notices[0];
  let head = file.lastIndexOf('function', notice.index);
  let noticeEnd = -1;
  while (head >= 0) {
    const prev = head > 0 ? file[head - 1] : ' ';
    if (!/[$\w.]/.test(prev)) {
      noticeEnd = findFunctionEnd(file, head);
      if (noticeEnd > notice.index) break;
    }
    head = file.lastIndexOf('function', head - 1);
  }
  if (noticeEnd < 0) throw new Error('failed to find the notice function end');
  const noticeLift = liftEnclosingFunction(
    file,
    notice.index,
    noticeEnd,
    notice[4]
  );
  if (!noticeLift)
    throw new Error('failed to lift the notice-builder function');

  return {
    sizer: {
      src: sizer.src,
      names: {
        fn: /^function ?([$\w]*)\(/.exec(sizer.src)[1],
        local: tail[1],
        envObj: tail[2],
        modelParam: tail[3],
        defConst: tail[4],
      },
    },
    notice: {
      src: noticeLift.src,
      names: {
        fn: /^function ?([$\w]*)\(/.exec(noticeLift.src)[1],
        source: notice[1],
        window: notice[2],
        resolver: notice[3],
        modelParam: notice[4],
      },
    },
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));
if (isMain) {
  for (const path of process.argv.slice(2)) {
    const file = readFileSync(path, 'latin1');
    const version = /claude-code[^0-9]*([0-9]+\.[0-9]+\.[0-9]+)/.exec(
      path
    )?.[1];
    const out = liftFromFile(file);
    console.log(JSON.stringify({ file: path, version, ...out }, null, 2));
  }
}
