// Please see the note about writing patches in ./index

import { LocationResult, showDiff } from './index';

type WidthLocation = LocationResult & { replacement: string };

// Collect every thinking-spinner box whose `width:2` cell must grow to `width`.
//
// 2.1.186 rebuilt the thinking indicator as a memo component (`_d()`) that emits
// the box via the jsx transform: jsx($,{ref:X,"aria-hidden":!0,flexWrap:"wrap",
// height:1,width:2,children:X}). Two things changed from the pre-2.1.186 shape:
// the symbol moved from a separate createElement child arg INTO the object as a
// `children:` prop, and a `ref` was added. The component renders two such boxes
// — a static-motion fallback (children = "●") and the animated frame
// (children = gMa[s], the cycled thinking phases) — both of which must be wide
// enough for a custom symbol. The `ref:` prefix is what distinguishes these
// spinner boxes from the unrelated no-ref status-dot boxes that share the
// flexWrap/height:1/width:2 shape, so Method 1 requires it.
const collectWidthLocations = (
  oldFile: string,
  width: number
): WidthLocation[] | null => {
  // Method 1 (2.1.186+): ref-prefixed spinner box(es), children inline.
  const jsxPattern =
    /\{(ref:[$\w]+,)("aria-hidden":!0,)?flexWrap:"wrap",height:1,width:2(,children:[$\w]+)?\}/g;
  const jsxLocations: WidthLocation[] = [];
  let m: RegExpExecArray | null;
  while ((m = jsxPattern.exec(oldFile)) !== null) {
    jsxLocations.push({
      startIndex: m.index,
      endIndex: m.index + m[0].length,
      replacement: `{${m[1]}${m[2] ?? ''}flexWrap:"wrap",height:1,width:${width}${m[3] ?? ''}}`,
    });
  }
  if (jsxLocations.length > 0) return jsxLocations;

  // Method 2 (<= 2.1.185): the bare box. 2.1.172 added an "aria-hidden":!0
  // property before flexWrap; older CC versions emit the bare object. The symbol
  // was a separate createElement arg, so the object ended right after width:2.
  const barePattern =
    /\{("aria-hidden":!0,)?flexWrap:"wrap",height:1,width:2\}/;
  const bare = oldFile.match(barePattern);
  if (bare && bare.index != undefined) {
    return [
      {
        startIndex: bare.index,
        endIndex: bare.index + bare[0].length,
        replacement: `{${bare[1] ?? ''}flexWrap:"wrap",height:1,width:${width}}`,
      },
    ];
  }

  return null;
};

export const writeThinkerSymbolWidthLocation = (
  oldFile: string,
  width: number
): string | null => {
  const locations = collectWidthLocations(oldFile, width);
  if (!locations || locations.length === 0) {
    console.error('patch: thinker symbol width: failed to find match');
    return null;
  }

  // Apply end-to-start so earlier replacements don't shift later indices.
  const sorted = [...locations].sort((a, b) => b.startIndex - a.startIndex);
  let newFile = oldFile;
  for (const loc of sorted) {
    const updated =
      newFile.slice(0, loc.startIndex) +
      loc.replacement +
      newFile.slice(loc.endIndex);
    showDiff(newFile, updated, loc.replacement, loc.startIndex, loc.endIndex);
    newFile = updated;
  }

  return newFile;
};
