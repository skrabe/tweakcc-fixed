// Please see the note about writing patches in ./index
//
// This patch makes Opus default to "max" reasoning effort. It rewrites the
// per-model default resolver only:
//
//     function hn_(H){if(JK(H)==="claude-opus-4-7")return"xhigh";return"high"}
//
// The function name churns across versions (hn_, xo_, YK6, …) but the shape is
// stable — swap the Opus return values to "max". CC 2.1.156 added an Opus 4.8
// branch (stock returns "high"); we cover both.
//
// We deliberately leave CC's launch-effort gate (the
// `unpinOpus47LaunchEffort` / `unpinOpus48LaunchEffort` check) UNTOUCHED. That
// gate is exactly what lets `/effort` override the per-model default: the first
// time the user sets effort, CC flips the unpin flag, the gate closes, and the
// persisted effortLevel wins from then on. So "max" is the DEFAULT, not a lock
// — a session can drop to xhigh/high via `/effort` (or CLAUDE_CODE_EFFORT_LEVEL)
// and it takes effect.
//
// (A previous revision also forced that gate permanently open to pin "max"
// across sessions. That defeated `/effort` entirely — effort snapped back to
// max every time it was recomputed — so it was removed. Don't re-add it.)
//
// CC has a guard `if(T==="max"&&!V3_(H))return"high"` that downgrades "max" for
// models that don't support it, so the swap is safe across model switches.

import { debug } from '../utils';
import { showDiff } from './index';

export const writeMaxEffortDefault = (oldFile: string): string | null => {
  let workingFile = oldFile;

  // Method 0 (CC 2.1.199+): data-driven model catalog. The per-model default
  // effort is now a string field `default_effort:"..."` inside each model's
  // object — the old `function ...==="claude-opus-4-7")return"xhigh"` resolver
  // is gone. Flip Opus 4.7/4.8 to "max" by editing that field, anchored on the
  // model id + the field name (both stable string literals, so it survives
  // minifier churn without depending on any symbol name). Opus 4.7/4.8 are in
  // the max-support set, so the turn resolver's cap guard keeps "max" (it only
  // downgrades models that don't support it). The launch-pin gate is untouched,
  // so `/effort` still overrides the default within a session.
  {
    let catalogApplied = false;
    for (const id of ['claude-opus-4-8', 'claude-opus-4-7']) {
      // Non-greedy gap → the NEAREST default_effort after the id, i.e. this
      // model's own field (it precedes any later model's within the catalog).
      const re = new RegExp(
        `(id:"${id}"[\\s\\S]{0,900}?default_effort:)"(?:high|xhigh)"`
      );
      const m = workingFile.match(re);
      if (m && m.index !== undefined) {
        const replacement = `${m[1]}"max"`;
        const newFile =
          workingFile.slice(0, m.index) +
          replacement +
          workingFile.slice(m.index + m[0].length);
        showDiff(
          workingFile,
          newFile,
          replacement,
          m.index,
          m.index + m[0].length
        );
        workingFile = newFile;
        catalogApplied = true;
      }
    }
    if (catalogApplied) return workingFile;
    // Catalog present but nothing left to flip → already "max" (idempotent).
    if (
      /id:"claude-opus-4-[78]"[\s\S]{0,900}?default_effort:"max"/.test(
        workingFile
      )
    ) {
      debug(
        'patch: maxEffortDefault: catalog default_effort already "max" — skipping'
      );
      return workingFile;
    }
    // No catalog in this build — fall through to the resolver-rewrite methods.
  }

  // Per-model default ("xhigh" → "max"):
  // function NAME(ARG){if(FUNC(ARG)==="claude-opus-4-7")return"xhigh";return"high"}
  const defaultPattern =
    /function\s+([$\w]+)\s*\(\s*([$\w]+)\s*\)\s*\{\s*if\s*\(\s*([$\w]+)\s*\(\s*\2\s*\)\s*===\s*"claude-opus-4-7"\s*\)\s*return\s*"xhigh"\s*;\s*return\s*"high"\s*\}/;
  // CC 2.1.156 shape — two model conditions (Opus 4.8 added, defaults to "high"):
  // function NAME(ARG){if(FUNC(ARG)==="claude-opus-4-8")return"high";if(FUNC(ARG)==="claude-opus-4-7")return"xhigh";return"high"}
  const default156Pattern =
    /function\s+([$\w]+)\s*\(\s*([$\w]+)\s*\)\s*\{\s*if\s*\(\s*([$\w]+)\s*\(\s*\2\s*\)\s*===\s*"claude-opus-4-8"\s*\)\s*return\s*"high"\s*;\s*if\s*\(\s*\3\s*\(\s*\2\s*\)\s*===\s*"claude-opus-4-7"\s*\)\s*return\s*"xhigh"\s*;\s*return\s*"high"\s*\}/;
  const m156 = workingFile.match(default156Pattern);
  const defaultMatch = m156 || workingFile.match(defaultPattern);
  if (defaultMatch && defaultMatch.index !== undefined) {
    const [fullMatch, fnName, argName, innerFnName] = defaultMatch;
    const replacement = m156
      ? `function ${fnName}(${argName}){if(${innerFnName}(${argName})==="claude-opus-4-8")return"max";if(${innerFnName}(${argName})==="claude-opus-4-7")return"max";return"high"}`
      : `function ${fnName}(${argName}){if(${innerFnName}(${argName})==="claude-opus-4-7")return"max";return"high"}`;
    const newFile =
      workingFile.slice(0, defaultMatch.index) +
      replacement +
      workingFile.slice(defaultMatch.index + fullMatch.length);
    showDiff(
      workingFile,
      newFile,
      replacement,
      defaultMatch.index,
      defaultMatch.index + fullMatch.length
    );
    workingFile = newFile;
  } else if (
    /===\s*"claude-opus-4-8"\s*\)\s*return\s*"max"/.test(workingFile) ||
    /function\s+[$\w]+\s*\(\s*[$\w]+\s*\)\s*\{\s*if\s*\(\s*[$\w]+\s*\(\s*[$\w]+\s*\)\s*===\s*"claude-opus-4-7"\s*\)\s*return\s*"max"\s*;\s*return\s*"high"\s*\}/.test(
      workingFile
    )
  ) {
    debug(
      'patch: maxEffortDefault: per-model default already "max" — skipping'
    );
  } else {
    console.error(
      'patch: maxEffortDefault: failed to find Opus per-model effort default'
    );
    return null;
  }

  return workingFile;
};
