// Please see the note about writing patches in ./index
//
// This patch swaps Opus 4.7's default reasoning effort from "xhigh" to "max"
// in the per-model default resolver. CC 2.1.128 ships:
//
//     function hn_(H){if(JK(H)==="claude-opus-4-7")return"xhigh";return"high"}
//
// `hn_` is the per-model default that the effort resolver consults when no
// `CLAUDE_CODE_EFFORT_LEVEL` env var is set. For Opus models the resolver
// returns this default directly, ignoring the persisted `effortLevel` setting
// (which only enumerates low/medium/high/xhigh — "max" is session-only). So
// patching this single literal is sufficient to make Opus 4.7 sessions
// default to "max" reasoning effort.
//
// CC has a guard `if(T==="max"&&!N1_(H))return"high"` that downgrades "max"
// for models that don't support it (anything older than Opus 4.6 / Sonnet 4.6
// / Opus 4.7), so this patch is safe even if the user later switches models
// — non-supporting models silently fall back to "high".

import { showDiff } from './index';

export const writeMaxEffortDefault = (oldFile: string): string | null => {
  // Match: function NAME(ARG){if(FUNC(ARG)==="claude-opus-4-7")return"xhigh";return"high"}
  // Captures the inner function name + arg name so we can rebuild the body
  // with "max" instead of "xhigh".
  const pattern =
    /function\s+([$\w]+)\s*\(\s*([$\w]+)\s*\)\s*\{\s*if\s*\(\s*([$\w]+)\s*\(\s*\2\s*\)\s*===\s*"claude-opus-4-7"\s*\)\s*return\s*"xhigh"\s*;\s*return\s*"high"\s*\}/;

  const match = oldFile.match(pattern);
  if (!match || match.index === undefined) {
    // CC may have already shipped "max" as the default in a future build, or
    // refactored the per-model default resolver. Either way, nothing to do.
    if (
      /function\s+[$\w]+\s*\(\s*[$\w]+\s*\)\s*\{\s*if\s*\(\s*[$\w]+\s*\(\s*[$\w]+\s*\)\s*===\s*"claude-opus-4-7"\s*\)\s*return\s*"max"\s*;\s*return\s*"high"\s*\}/.test(
        oldFile
      )
    ) {
      console.log(
        'patch: maxEffortDefault: Opus 4.7 already defaults to "max" — skipping'
      );
      return oldFile;
    }
    console.error(
      'patch: maxEffortDefault: failed to find Opus 4.7 default-effort resolver'
    );
    return null;
  }

  const [fullMatch, fnName, argName, innerFnName] = match;
  const replacement = `function ${fnName}(${argName}){if(${innerFnName}(${argName})==="claude-opus-4-7")return"max";return"high"}`;

  const newFile =
    oldFile.slice(0, match.index) +
    replacement +
    oldFile.slice(match.index + fullMatch.length);

  showDiff(
    oldFile,
    newFile,
    replacement,
    match.index,
    match.index + fullMatch.length
  );
  return newFile;
};
