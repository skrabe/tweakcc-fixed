/**
 * Edit Tool Patch Configuration for the LexPatcher engine.
 *
 * This config describes how to patch any Claude Code version's edit tool function
 * to add an `ignore_whitespace` option (trim content before matching).
 *
 * ## Architecture of the edit tool in minified source
 *
 * The edit tool is called via a structural pattern like:
 *   `run:async({file_path:X,old_string:Y,new_string:Z,replace_all:W})=>{...}`
 * where X/W/Z/Y are version-specific single-char identifiers.
 *
 * Inside the function body (before this anchor), variables are assigned:
 *   1. `content=s.split(r)` — splits old_string by file_path to count occurrences
 *      (the `s` and `r` here are the actual param names, extracted from groups)
 *   2. `count=a=s.split(r).length-1` — stores occurrence count in `a`
 *   3. `result=l.join(c)` — joins matches back into result with `c` as separator
 *      (the `l` is the captured group, e.g. `s` or another var)
 *
 * We need to:
 * - Insert a trim() call on content before the split
 * - Add ignore_whitespace schema to the params object
 * - Generate safe variable names that don't collide with any existing identifiers
 */

import type { LexPatcherConfig } from './lexPatcher';

export const editToolPatchConfig: LexPatcherConfig = {
  // Anchor: find the edit tool invocation by its stable parameter structure.
  // The regex captures file_path:X and old_string:Y values inside the anchor text.
  // searchExtensionAfterMatch extends the "before" search region past the match end
  // to capture new_string:Z and replace_all:W which appear just after the anchor.
  anchors: [
    {
      id: 'editTool',
      regex: /run:async\(\{file_path:[a-zA-Z_$]+,old_string:[a-zA-Z_$]/,
      contextWindowBefore: 5000,
      contextWindowAfter: 3000,
      searchExtensionAfterMatch: 100, // enough to reach new_string:X and replace_all:X
    },
  ],

  // Variables to extract from bounded context windows around the anchor
  variables: [
    // paramFile: X from file_path:X — the first parameter name in the struct
    {
      id: 'paramFile',
      anchorId: 'editTool',
      direction: 'before',
      regex: /file_path:([a-zA-Z_$]+)/,
    },
    // paramOld: Y from old_string:Y — the second parameter name
    {
      id: 'paramOld',
      anchorId: 'editTool',
      direction: 'before',
      regex: /old_string:([a-zA-Z_$]+)/,
    },
    // paramNew: Z from new_string:Z — the third parameter name
    {
      id: 'paramNew',
      anchorId: 'editTool',
      direction: 'before',
      regex: /new_string:([a-zA-Z_$]+)/,
    },
    // paramReplaceAll: W from replace_all:W — the fourth parameter name
    {
      id: 'paramReplaceAll',
      anchorId: 'editTool',
      direction: 'before',
      regex: /replace_all:([a-zA-Z_$]+)/,
    },
  ],

  // Inject trim logic and schema update before the count-check region (after anchor)
  injections: [
    {
      targetAnchorId: 'editTool',
      position: 'after',
      template: (vars, safe) => {
        const [d] = safe; // single-char safe name for trimmed content
        return `${d}=${vars.paramFile}.trim()`;
      },
    },
  ],
};
