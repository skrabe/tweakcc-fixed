import { showDiff } from './index';

// kY6 wrapper (named hY6 in 2.1.142). Vanilla shape:
//   function fn(H,_){if(Object.entries(_).length===0)return H;return[j6({content:`<system-reminder>...`,isMeta:!0}),...H]}
//
// Vanilla CC calls this on every API round from the main loop and PREPENDS a
// fresh sysRem (claudeMd + userEmail + currentDate) to the messages payload
// each time. The sysRem is rebuilt every call — currentDate or any context
// field changing invalidates the prompt cache prefix.
//
// First (broken) attempt at "once per conversation": added `if(H.length>1)
// return H;`. That assumed length===1 meant "first turn", which is wrong:
// in headless mode H starts at length 7 (bootstrap progress + attachment
// frames precede the user message), and even interactively the array grows
// past 1 mid-turn during tool-use loops. The early return triggered on the
// very first call, sysRem was never injected, and the model never saw
// CLAUDE.md at all.
//
// Real fix: detect "sysRem already present at H[0]" instead of trying to
// guess turn number from length. On the genuine first call sysRem is absent
// → unshift it into H (mutating, so it persists in the in-memory messages
// array used by every subsequent API round in the same process). On every
// later call sysRem is at H[0] → no-op. Result: one sysRem, persisted
// across the conversation, prompt-cache friendly.
//
// Marker for detection is the literal "<system-reminder>\nAs you answer the
// user" prefix. That string is fixed in CC's wrapper template even when
// claudemd-context overrides replace the body further down, so the check
// stays correct alongside the override system.
export const writeClaudemdContextOncePerConversation = (
  oldFile: string
): string | null => {
  // Idempotency: detect the new (presence-check + mutate-and-persist) form.
  if (
    /function [$\w]+\(([$\w]+),[$\w]+\)\{if\(Object\.entries\([$\w]+\)\.length===0\)return \1;var ([$\w]+)=\1\[0\];if\(\2&&\2\.isMeta/.test(
      oldFile
    )
  ) {
    return oldFile;
  }
  const pattern =
    /function ([$\w]+)\(([$\w]+),([$\w]+)\)\{if\(Object\.entries\(\3\)\.length===0\)return \2;return\[([\s\S]+?),\.\.\.\2\]\}/;
  const match = oldFile.match(pattern);
  if (!match || match.index === undefined) {
    // claudemd-context override may have suppressed the wrapper to
    // `function fn(H,_){return H;}`. That shape is too generic to find
    // safely, so we anchor on the always-present `tengu_context_size`
    // analytics event (emitted from bhK, the function that immediately
    // follows kY6) and check the preceding 5KB window.
    const tenguIdx = oldFile.indexOf('"tengu_context_size"');
    if (tenguIdx > 0) {
      const window = oldFile.slice(Math.max(0, tenguIdx - 5000), tenguIdx);
      if (
        /function [$\w]+\([$\w]+,[$\w]+\)\{return [$\w]+;?\}\s*async function/.test(
          window
        )
      ) {
        console.log(
          'patch: claudemd-context-once-per-conversation: claudemd-context override suppressed wrapper — no-op'
        );
        return oldFile;
      }
    }
    console.error(
      'patch: claudemd-context-once-per-conversation: failed to find kY6 wrapper'
    );
    return null;
  }
  const [fullMatch, fnName, msgsParam, ctxParam, j6Call] = match;
  // Use a fresh local name for the H[0] alias. The wrapper's params are
  // known (msgsParam, ctxParam) so we just pick something that can't collide.
  const headVar = `${msgsParam}_0`;
  const replacement =
    `function ${fnName}(${msgsParam},${ctxParam}){` +
    `if(Object.entries(${ctxParam}).length===0)return ${msgsParam};` +
    `var ${headVar}=${msgsParam}[0];` +
    `if(${headVar}&&${headVar}.isMeta&&${headVar}.message&&typeof ${headVar}.message.content==="string"&&${headVar}.message.content.indexOf("<system-reminder>\\nAs you answer the user")===0)return ${msgsParam};` +
    `${msgsParam}.unshift(${j6Call});` +
    `return ${msgsParam}}`;
  const startIndex = match.index;
  const endIndex = startIndex + fullMatch.length;
  const newFile =
    oldFile.slice(0, startIndex) + replacement + oldFile.slice(endIndex);
  showDiff(oldFile, newFile, replacement, startIndex, endIndex);
  return newFile;
};

export const writeStripEmptySystemReminders = (
  oldFile: string
): string | null => {
  const pattern =
    /function ([$\w]+)\(([$\w]+)\)\{return`<system-reminder>\n\$\{\2\}\n<\/system-reminder>`\}/;
  const match = oldFile.match(pattern);

  if (!match || match.index === undefined) {
    if (
      /function [$\w]+\(([$\w]+)\)\{if\(!\1\|\|!\1\.trim\(\)\|\|\1==="\(no content\)"\)return"\(no content\)";return`<system-reminder>/.test(
        oldFile
      )
    ) {
      return oldFile;
    }
    console.error(
      'patch: strip-empty-system-reminders: failed to find LW(H) wrapper'
    );
    return null;
  }

  const [fullMatch, fnName, argName] = match;
  // Return the unwrapped "(no content)" placeholder for empty/placeholder input.
  // Returning "" would make text blocks empty, which Anthropic's API rejects when
  // cache_control is attached: `cache_control cannot be set for empty text blocks`.
  const replacement =
    `function ${fnName}(${argName}){` +
    `if(!${argName}||!${argName}.trim()||${argName}==="(no content)")return"(no content)";` +
    `return\`<system-reminder>\n\${${argName}}\n</system-reminder>\`}`;

  const startIndex = match.index;
  const endIndex = startIndex + fullMatch.length;
  const newFile =
    oldFile.slice(0, startIndex) + replacement + oldFile.slice(endIndex);
  showDiff(oldFile, newFile, replacement, startIndex, endIndex);
  return newFile;
};

const DEFERRED_TOOLS_ANCHOR =
  'The following deferred tools are now available via';

export const writeSuppressDeferredTools = (oldFile: string): string | null => {
  if (!oldFile.includes(DEFERRED_TOOLS_ANCHOR)) {
    console.log(
      'patch: suppress-deferred-tools: anchor not present in this CC build — no-op'
    );
    return oldFile;
  }

  const caseHeader = `case"deferred_tools_delta":{`;
  const earlyReturn = `case"deferred_tools_delta":{return [];`;

  if (oldFile.includes(earlyReturn)) {
    return oldFile;
  }

  const headerIdx = oldFile.indexOf(caseHeader);
  if (headerIdx < 0) {
    console.error('patch: suppress-deferred-tools: failed to find case header');
    return null;
  }

  const lookahead = oldFile.slice(headerIdx, headerIdx + 2048);
  if (!lookahead.includes(DEFERRED_TOOLS_ANCHOR)) {
    console.error(
      'patch: suppress-deferred-tools: case header found but anchor text not nearby'
    );
    return null;
  }

  const insertAt = headerIdx + caseHeader.length;
  const insertion = 'return [];';
  const newFile =
    oldFile.slice(0, insertAt) + insertion + oldFile.slice(insertAt);
  showDiff(oldFile, newFile, insertion, insertAt, insertAt);
  return newFile;
};
