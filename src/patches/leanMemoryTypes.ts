// Lean Memory Types Patch - Force the compact "Types of memory" arrangement
//
// CC dark-launched a leaner memory-types design behind the statsig flag
// "tengu_ochre_finch" (default false). When on, two things change together:
//
//   1. The memory system prompts swap the verbose <types><type>... XML
//      blocks for a ~600-char dynamic list (type names + one-line
//      descriptions + a pointer to the memory-types skill).
//   2. A model-invocable `memory-types` skill is enabled, serving the full
//      taxonomy reference on demand. Its body is built from the same
//      verbose arrays the prompts use when the flag is off, so inline-blob
//      overrides of those arrays keep applying to whichever surface is
//      live.
//
// This patch forces only that gate. One niche call site passes a bypass
// flag and keeps the verbose block regardless (the auto-memory MEMORY.md
// builder); it is intentionally left alone — the verbose arrays stay
// overridable there.
//
// Gate (CC 2.1.173):
// ```diff
//  function nL8(){
// +  return!0;
//    return j_("tengu_ochre_finch",!1)
//  }
// ```

import { debug } from '../utils';
import { showDiff } from './index';

export const writeLeanMemoryTypes = (file: string): string | null => {
  if (!file.includes('"tengu_ochre_finch"')) {
    debug(
      'patch: leanMemoryTypes: gate already promoted/removed in this CC build — no-op'
    );
    return file;
  }

  const pattern =
    /function [$\w]+\(\)\{(?:return!0;)?return [$\w]+\("tengu_ochre_finch",!1\)\}/;
  const match = file.match(pattern);

  if (!match || match.index === undefined) {
    console.error('patch: leanMemoryTypes: failed to find statsig gate');
    return null;
  }

  const insertIndex = match.index + match[0].indexOf('{') + 1;

  if (file.startsWith('return!0;', insertIndex)) {
    return file;
  }

  const insertion = 'return!0;';
  const newFile =
    file.slice(0, insertIndex) + insertion + file.slice(insertIndex);

  showDiff(file, newFile, insertion, insertIndex, insertIndex);
  return newFile;
};
