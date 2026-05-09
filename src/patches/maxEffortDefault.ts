// Please see the note about writing patches in ./index
//
// This patch makes Opus 4.7 default to "max" reasoning effort. Two sites:
//
// 1) Per-model default function. CC 2.1.128 shipped:
//
//        function hn_(H){if(JK(H)==="claude-opus-4-7")return"xhigh";return"high"}
//
//    Function name has churned across versions (hn_, then xo_ in 2.1.138)
//    but the shape is stable. Swap "xhigh" → "max".
//
// 2) Opus-4.7 launch-effort gate. CC 2.1.138 introduced:
//
//        function bo_(H){return I7(H).includes("opus-4-7")&&!S_().unpinOpus47LaunchEffort}
//
//    The resolver only consults the per-model default for Opus 4.7 when this
//    gate returns true. The `unpinOpus47LaunchEffort` flag flips to true
//    permanently the first time the user runs `/effort` or sets effort via
//    CLI, at which point the gate returns false and the persisted `effortLevel`
//    wins instead — defeating site (1). Drop the flag clause so the gate stays
//    open for Opus 4.7 regardless of unpin state. Effect: max stays the
//    default; `/effort xhigh` still works session-by-session via env/CLI, it
//    just doesn't pin across sessions.
//
// CC has a guard `if(T==="max"&&!V3_(H))return"high"` that downgrades "max"
// for models that don't support it, so site (1) is safe across model switches.

import { showDiff } from './index';

export const writeMaxEffortDefault = (oldFile: string): string | null => {
  let workingFile = oldFile;

  // --- Site 1: per-model default ("xhigh" → "max") ---
  // function NAME(ARG){if(FUNC(ARG)==="claude-opus-4-7")return"xhigh";return"high"}
  const defaultPattern =
    /function\s+([$\w]+)\s*\(\s*([$\w]+)\s*\)\s*\{\s*if\s*\(\s*([$\w]+)\s*\(\s*\2\s*\)\s*===\s*"claude-opus-4-7"\s*\)\s*return\s*"xhigh"\s*;\s*return\s*"high"\s*\}/;
  const defaultMatch = workingFile.match(defaultPattern);
  if (defaultMatch && defaultMatch.index !== undefined) {
    const [fullMatch, fnName, argName, innerFnName] = defaultMatch;
    const replacement = `function ${fnName}(${argName}){if(${innerFnName}(${argName})==="claude-opus-4-7")return"max";return"high"}`;
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
    /function\s+[$\w]+\s*\(\s*[$\w]+\s*\)\s*\{\s*if\s*\(\s*[$\w]+\s*\(\s*[$\w]+\s*\)\s*===\s*"claude-opus-4-7"\s*\)\s*return\s*"max"\s*;\s*return\s*"high"\s*\}/.test(
      workingFile
    )
  ) {
    console.log(
      'patch: maxEffortDefault: site 1 (per-model default) already "max" — skipping'
    );
  } else {
    console.error(
      'patch: maxEffortDefault: failed to find Opus 4.7 per-model default resolver (site 1)'
    );
    return null;
  }

  // --- Site 2: drop unpinOpus47LaunchEffort gate clause ---
  // function NAME(ARG){return INNER(ARG).includes("opus-4-7")&&!STATE().unpinOpus47LaunchEffort}
  const gatePattern =
    /function\s+([$\w]+)\s*\(\s*([$\w]+)\s*\)\s*\{\s*return\s+([$\w]+)\s*\(\s*\2\s*\)\s*\.\s*includes\s*\(\s*"opus-4-7"\s*\)\s*&&\s*!\s*[$\w]+\s*\(\s*\)\s*\.\s*unpinOpus47LaunchEffort\s*\}/;
  const gateMatch = workingFile.match(gatePattern);
  if (gateMatch && gateMatch.index !== undefined) {
    const [fullMatch, fnName, argName, innerFnName] = gateMatch;
    const replacement = `function ${fnName}(${argName}){return ${innerFnName}(${argName}).includes("opus-4-7")}`;
    const newFile =
      workingFile.slice(0, gateMatch.index) +
      replacement +
      workingFile.slice(gateMatch.index + fullMatch.length);
    showDiff(
      workingFile,
      newFile,
      replacement,
      gateMatch.index,
      gateMatch.index + fullMatch.length
    );
    workingFile = newFile;
  } else if (
    /function\s+[$\w]+\s*\(\s*[$\w]+\s*\)\s*\{\s*return\s+[$\w]+\s*\(\s*[$\w]+\s*\)\s*\.\s*includes\s*\(\s*"opus-4-7"\s*\)\s*\}/.test(
      workingFile
    )
  ) {
    console.log(
      'patch: maxEffortDefault: site 2 (launch-effort gate) already free of unpin clause — skipping'
    );
  } else if (!workingFile.includes('unpinOpus47LaunchEffort')) {
    console.log(
      'patch: maxEffortDefault: site 2 not present in this CC build — no-op'
    );
  } else {
    console.error(
      'patch: maxEffortDefault: failed to find Opus 4.7 launch-effort gate (site 2)'
    );
    return null;
  }

  return workingFile;
};
