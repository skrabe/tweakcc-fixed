// Please see the note about writing patches in ./index
//
// "Treat my model as Fable/Mythos" — the full flip.
//
// Claude Code branches on a single model-family predicate:
//
//     function zQ(e){if(e==="claude-fable-5"||e==="claude-mythos-5")return!0;return!1}
//
// `zQ` true means "this model is fable-5/mythos-5", and it gates everything CC
// reserves for those models: the autonomous-operation system prompt, the
// "# Communicating with the user" comms block (vs the "# Text output" one),
// /loop dynamic-wakeup turn behavior, brief-mode comms shaping, and per-model
// feature-flag routing. We flip the fallback `return!1` → `return!0` so zQ
// returns true for EVERY model — i.e. whatever model the user runs is treated
// as fable/mythos. (Function/arg names churn across versions; we anchor on the
// two stable model-id literals.)
//
// This is deliberately the whole gate, not just the autonomy-prompt call-site,
// because the user asked to "turn opus into fable", not to cherry-pick one
// prompt. The feature-flag side (hkt → "falcon") is inert on a local install
// (those ct() lookups default off without a live gate service); the one site
// worth runtime-verifying is the model-resolution path (rUi), which this flip
// makes every model take — covered by a real-session check after --apply.

import { debug } from '../utils';
import { showDiff } from './index';

export const writeAutonomousOperationAllModels = (
  oldFile: string
): string | null => {
  // function NAME(ARG){if(ARG==="claude-fable-5"||ARG==="claude-mythos-5")return!0;return!1}
  const pattern =
    /function\s+([$\w]+)\s*\(\s*([$\w]+)\s*\)\s*\{\s*if\s*\(\s*\2\s*===\s*"claude-fable-5"\s*\|\|\s*\2\s*===\s*"claude-mythos-5"\s*\)\s*return\s*!0\s*;\s*return\s*!1\s*\}/;
  const match = oldFile.match(pattern);

  if (!match || match.index === undefined) {
    // Already flipped (fallback is now !0).
    if (
      /"claude-mythos-5"\s*\)\s*return\s*!0\s*;\s*return\s*!0\s*\}/.test(
        oldFile
      )
    ) {
      debug(
        'patch: autonomousOperationAllModels: model-family gate already flipped — skipping'
      );
      return oldFile;
    }
    // The model-family predicate still references these ids but in a new shape.
    if (/"claude-fable-5"/.test(oldFile)) {
      console.error(
        'patch: autonomousOperationAllModels: found the fable/mythos model ids but not the expected gate shape — needs a new match method'
      );
      return null;
    }
    // Model ids renamed/removed (new CC build) → no-op rather than fail apply.
    console.log(
      'patch: autonomousOperationAllModels: fable/mythos model-family gate not present in this CC build — no-op'
    );
    return oldFile;
  }

  const [fullMatch, fnName, argName] = match;
  const replacement = `function ${fnName}(${argName}){if(${argName}==="claude-fable-5"||${argName}==="claude-mythos-5")return!0;return!0}`;
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
