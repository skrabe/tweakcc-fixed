import {
  LocationResult,
  escapeIdent,
  findBoxComponent,
  findChalkVar,
  findTextComponent,
  getReactVar,
  showDiff,
} from './index';
import { escapeNonAscii } from '../utils';

/**
 * Renders one row of the "patches applied" startup list. The item text is
 * `\uXXXX`-escaped so a non-ASCII char in a prompt name (e.g. an em-dash in a
 * title) survives CC's Latin-1 module storage instead of mojibaking — the same
 * reason the ┃/✓ glyph literals are written as `┃`/`✓`. Shared by both
 * render sites (PATCH 3 and PATCH 5) so the escaping can't drift between them.
 */
export const renderPatchListItemRow = (
  reactVar: string,
  boxComponent: string,
  textComponent: string,
  item: string
): string =>
  `${reactVar}.createElement(${boxComponent}, null, ${reactVar}.createElement(${textComponent}, {color: "success", bold: true}, "\\u2503 "), ${reactVar}.createElement(${textComponent}, {dimColor: true}, \`  * ${escapeNonAscii(item)}\`)),`;

/**
 * PATCH 1: Finds the location of the version output pattern in Claude Code's cli.js
 */
export const findVersionOutputLocation = (
  fileContents: string
): LocationResult | null => {
  // Pattern: }.VERSION} (Claude Code)
  const versionPattern = '}.VERSION} (Claude Code)';
  const versionIndex = fileContents.indexOf(versionPattern);
  if (versionIndex == -1) {
    console.error(
      'patch: patchesAppliedIndication: failed to find versionIndex'
    );
    return null;
  }

  return {
    startIndex: 0,
    endIndex: versionIndex + versionPattern.length,
  };
};

/**
 * PATCH 2: Finds the header version display and returns the location(s) to splice
 * the "+ tweakcc vX.Y.Z" marker in.
 *
 * Two shapes:
 *   - JSX runtime (CC ≥2.1.186): the header is emitted as `HELPER.jsxs(TEXT,
 *     {children:[<title>," ",HELPER.jsxs(TEXT,{dimColor:!0,children:["v",VER]})]})`.
 *     We splice one more child element inline, so the result carries a `jsxInline`
 *     descriptor and no `let _tw=` declaration is needed.
 *   - React.createElement (CC ≤2.1.185): the older two-step shape — insert a `let
 *     _tw=React.createElement(...)` after the bold "Claude Code" element, then a
 *     `," ",_tw` sibling reference. Returns `varInsertIndex`/`refInsertIndex`.
 */
type TweakccVersionLocations =
  | {
      // CC ≥2.1.186 JSX runtime: splice a single inline child.
      jsxInline: { insertIndex: number; helper: string; textComponent: string };
    }
  | {
      // CC ≤2.1.185 React.createElement two-step splice.
      varInsertIndex: number;
      refInsertIndex: number;
      reactVar: string;
      textComponent: string;
    };

const findTweakccVersionLocations = (
  fileContents: string
): TweakccVersionLocations | null => {
  // Method 0 (CC ≥2.1.186): JSX runtime header. The startup header renders the
  // title + version as
  //   HELPER.jsxs(TEXT,{children:[<title>," ",HELPER.jsxs(TEXT,{dimColor:!0,children:["v",VER]})]})
  // where <title> is either a memoized var (React-compiler path) or an inline
  // `HELPER.jsx(TEXT,{bold:!0,children:"Claude Code"})`. The inner version group
  // (dimColor + "v") is the stable anchor; we append one more child element right
  // before the outer children array's closing `]})`.
  //
  // [^[\]]{0,200} for the <title> deliberately forbids nested brackets so this
  // matches the primary startup header (title is a var or a bracket-free jsx)
  // and skips the compact `M=…` header whose title is itself a bracketed array
  // (`children:["Claude Code"," "]`) — that path already gets the marker via the
  // chalk Path A/B replacements below.
  const jsxVersionPattern =
    /([$\w]+)\.jsxs\(([$\w]+),\{children:\[(?:[^[\]]{0,200})," ",([$\w]+)\.jsxs\(([$\w]+),\{dimColor:!0,children:\["v",[$\w]+\]\}\)\]\}\)/;
  const jsxMatch = fileContents.match(jsxVersionPattern);
  if (jsxMatch && jsxMatch.index !== undefined) {
    return {
      jsxInline: {
        // Insert before the `]})` that closes the outer children array.
        insertIndex: jsxMatch.index + jsxMatch[0].length - 3,
        helper: jsxMatch[1],
        textComponent: jsxMatch[2],
      },
    };
  }

  // Find: createElement(TEXT,{bold:!0},"Claude Code"),CACHE[N]=x;else x=CACHE[N];
  // This gives us the position right after the x assignment block — where we insert our var
  const boldPattern =
    /createElement\(([$\w]+),\{bold:!0\},"Claude Code"\),([$\w]+)\[\d+\]=[$\w]+;else [$\w]+=([$\w]+)\[\d+\]/;
  const boldMatch = fileContents.match(boldPattern);
  if (!boldMatch || boldMatch.index === undefined) {
    console.error(
      'patch: patchesAppliedIndication: PATCH 2 failed to find bold Claude Code pattern'
    );
    return null;
  }
  const textComponent = boldMatch[1];

  // Find the end of the "else x=q[8];" statement — insert our var declaration after it
  const afterBold = boldMatch.index + boldMatch[0].length;
  // Skip past the semicolon
  const semiIndex = fileContents.indexOf(';', afterBold);
  if (semiIndex === -1) return null;
  const varInsertIndex = semiIndex + 1;

  // Now find the I= createElement that wraps x and the version
  // Pattern: REACT.createElement(TEXT,null,MEMO_VAR," ",REACT.createElement(TEXT,{dimColor:!0},"v",VAR))
  const newPattern =
    /[^$\w]([$\w]+)\.createElement\(([$\w]+),null,[$\w]+," ",([$\w]+)\.createElement\(([$\w]+),\{dimColor:!0\},"v",[$\w]+\)\)/;
  const match = fileContents.match(newPattern);
  if (!match || match.index === undefined) {
    // Fallback: old pattern (pre-React-compiler)
    const oldPattern =
      /[^$\w]([$\w]+)\.createElement\(([$\w]+),\{bold:!0\},"Claude Code"\)," ",([$\w]+)\.createElement\(([$\w]+),\{dimColor:!0\},"v",[$\w]+\)/;
    const oldMatch = fileContents.match(oldPattern);
    if (!oldMatch || oldMatch.index === undefined) {
      console.error(
        'patch: patchesAppliedIndication: PATCH 2 failed to find version createElement'
      );
      return null;
    }
    return {
      varInsertIndex,
      refInsertIndex: oldMatch.index + oldMatch[0].length,
      reactVar: oldMatch[1],
      textComponent,
    };
  }

  // Insert before the last ) of the createElement
  return {
    varInsertIndex,
    refInsertIndex: match.index + match[0].length - 1,
    reactVar: match[1],
    textComponent,
  };
};

/**
 * PATCH 4: Inserts tweakcc version in the indicator view
 * Returns the modified content and the position where the closing paren was added
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const applyIndicatorViewPatch = (
  fileContents: string,
  tweakccVersion: string,
  reactVar: string,
  boxComponent: string,
  textComponent: string,
  chalkVar: string
): { content: string; closingParenIndex: number } | null => {
  // 1. Find alignItems:"center",minHeight:<value>, where value can be a number or ternary
  const alignItemsPattern =
    /alignItems:"center",minHeight:([$\w]+\?\d+:\d+|\d+),?/;
  const alignItemsMatch = fileContents.match(alignItemsPattern);
  if (!alignItemsMatch || alignItemsMatch.index === undefined) {
    console.error(
      'patch: patchesAppliedIndication: failed to find alignItems pattern for PATCH 4'
    );
    return null;
  }

  // 2. Replace alignItems:"center",minHeight:<value>, with just minHeight:<value>,
  const minHeightValue = alignItemsMatch[1];
  let content =
    fileContents.slice(0, alignItemsMatch.index) +
    `minHeight:${minHeightValue},` +
    fileContents.slice(alignItemsMatch.index + alignItemsMatch[0].length);

  // 3. Go back 200 chars from the alignItems location
  const lookbackStart = Math.max(0, alignItemsMatch.index - 200);
  const lookbackSubstring = content.slice(
    lookbackStart,
    alignItemsMatch.index + 'minHeight:9,'.length + '},'.length
  );

  // 4. Find the LAST createElement call in that subsection to get the insertion point
  const createElementPattern =
    /[^$\w]([$\w]+)\.createElement\(([$\w]+),(?:\w+|\{[^}]+\}),/g;
  const matches = Array.from(lookbackSubstring.matchAll(createElementPattern));
  if (matches.length === 0) {
    console.error(
      'patch: patchesAppliedIndication: failed to find createElement for PATCH 4'
    );
    return null;
  }

  const lastMatch = matches[matches.length - 1];

  // Calculate the absolute position after the createElement call
  const matchPositionInFile =
    lookbackStart + lastMatch.index! + lastMatch[0].length;

  // 5. Insert the tweakcc version code after the createElement call
  const insertCode = `${reactVar}.createElement(${textComponent}, null, ${chalkVar}.blue.bold("     + tweakcc v${tweakccVersion}")),${reactVar}.createElement(${boxComponent},{alignItems:"center",flexDirection:"column"},`;

  const oldContent = content;
  content =
    content.slice(0, matchPositionInFile) +
    insertCode +
    content.slice(matchPositionInFile);

  showDiff(
    oldContent,
    content,
    insertCode,
    matchPositionInFile,
    matchPositionInFile
  );

  // 6. Use stack machine to find where to add the closing paren
  let level = 1;
  let currentIndex = matchPositionInFile + insertCode.length;
  let closingParenIndex = -1;

  while (currentIndex < content.length) {
    const ch = content[currentIndex];
    if (ch === '(') {
      level++;
    } else if (ch === ')') {
      if (level === 1) {
        // Found the location - this is where we add the closing paren
        closingParenIndex = currentIndex;
        break;
      }
      level--;
    }
    currentIndex++;
  }

  if (closingParenIndex === -1) {
    console.error(
      'patch: patchesAppliedIndication: failed to find closing paren for PATCH 4'
    );
    return null;
  }

  // 7. Add ")," at the location
  const oldContent2 = content;
  content =
    content.slice(0, closingParenIndex) +
    '),' +
    content.slice(closingParenIndex);

  showDiff(oldContent2, content, '),', closingParenIndex, closingParenIndex);

  return { content, closingParenIndex: closingParenIndex + 2 }; // +2 for the added "),"
};

/**
 * PATCH 5: Inserts patches applied list in the indicator view
 * Uses stack machine starting at level 2 to find insertion point
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const applyIndicatorPatchesListPatch = (
  fileContents: string,
  startIndex: number,
  reactVar: string,
  boxComponent: string,
  textComponent: string,
  chalkVar: string,
  patchesApplies: string[]
): string | null => {
  // Find the insertion point: the closing paren of the Fragment createElement that
  // wraps the entire header component output.
  //
  // Strategy 1 (CC ≥2.1.79): Find createElement(REACT.Fragment,null,...) near the
  // alignItems location and use its closing paren.
  // Strategy 2 (older CC): Use stack machine from startIndex at level 4.
  let insertionIndex = -1;

  // Strategy 1: Look for Fragment createElement after startIndex
  const fragmentPattern = /createElement\([$\w]+\.Fragment,null,/;
  const searchRegion = fileContents.slice(startIndex, startIndex + 5000);
  const fragmentMatch = searchRegion.match(fragmentPattern);

  if (fragmentMatch && fragmentMatch.index !== undefined) {
    // Walk to find the closing paren of this createElement call
    const fragStart = startIndex + fragmentMatch.index;
    let level = 1; // we're right after "createElement("
    const scanFrom = fragStart + fragmentMatch[0].length;
    for (let i = scanFrom; i < fileContents.length; i++) {
      const ch = fileContents[i];
      if (ch === '(') level++;
      else if (ch === ')') {
        level--;
        if (level === 0) {
          insertionIndex = i;
          break;
        }
      }
    }
  }

  // Strategy 2: Stack machine (older CC)
  if (insertionIndex === -1) {
    let level = 4;
    let currentIndex = startIndex;
    while (
      currentIndex < fileContents.length &&
      currentIndex < startIndex + 10000
    ) {
      const ch = fileContents[currentIndex];
      if (ch === '(') {
        level++;
      } else if (ch === ')') {
        if (level === 1) {
          insertionIndex = currentIndex;
          break;
        }
        level--;
      }
      currentIndex++;
    }
  }

  if (insertionIndex === -1) {
    console.error(
      'patch: patchesAppliedIndication: failed to find insertion point for PATCH 5'
    );
    return null;
  }

  // Build the patches applied list (same format as PATCH 3)
  const lines = [];
  lines.push(
    `,${reactVar}.createElement(${boxComponent}, { flexDirection: "column" },`
  );
  lines.push(
    `${reactVar}.createElement(${boxComponent}, null, ${reactVar}.createElement(${textComponent}, {color: "success", bold: true}, "\\u2503 "), ${reactVar}.createElement(${textComponent}, {color: "success", bold: true}, "\\u2713 tweakcc-fixed patches are applied")),`
  );
  for (let item of patchesApplies) {
    item = item.replace('CHALK_VAR', chalkVar);
    lines.push(
      renderPatchListItemRow(reactVar, boxComponent, textComponent, item)
    );
  }
  lines.push('),');
  const patchesListCode = lines.join('');

  // Insert at the found location
  const oldContent = fileContents;
  const content =
    fileContents.slice(0, insertionIndex) +
    patchesListCode +
    fileContents.slice(insertionIndex);

  showDiff(
    oldContent,
    content,
    patchesListCode,
    insertionIndex,
    insertionIndex
  );

  return content;
};

/**
 * PATCH 3 (CC ≥2.1.186): JSX-runtime header. Find the version row's assigned var,
 * then the `flexDirection:"column"` Box that lists it as a child, and return the
 * end of that column's children array so the patches list slots in as the last
 * child. Returns null (no logging) so the caller can fall through to the older
 * `createElement`-based location finder for CC ≤2.1.185.
 */
const findPatchesListLocationJsx = (
  fileContents: string
): LocationResult | null => {
  // Match the header version row and capture its assigned var. CC emits this as a
  // memoized assignment `VAR=HELPER.jsxs(TEXT,{children:[<title>," ",HELPER.jsxs(
  // TEXT,{dimColor:!0,children:["v",VER]})...` — note we stop at the inner version
  // group's close and do NOT require the outer array's `]})`, because PATCH 2 may
  // have already appended a `," ",<marker>` sibling after that inner group.
  // Boundary class includes `)` and `]` because the memoized assignment is
  // commonly preceded by `if(e[N]!==d)VAR=…` (close-paren) on the React-compiler
  // path; a bare `{`/`;`/`,` class would miss it.
  const verAssignPattern =
    /[,;){}\]]([$\w]+)=([$\w]+)\.jsxs\(([$\w]+),\{children:\[(?:[^[\]]{0,200})," ",[$\w]+\.jsxs\([$\w]+,\{dimColor:!0,children:\["v",[$\w]+\]\}\)/;
  const verAssign = fileContents.match(verAssignPattern);
  if (!verAssign || verAssign.index === undefined) {
    return null;
  }
  const verVar = verAssign[1];

  // Find the column Box that holds verVar as a child: ,verVar, or [verVar inside a
  // `flexDirection:"column",children:[...verVar...]`. The var is referenced as a
  // child of its column container a few hundred bytes AFTER the assignment in
  // React-compiler output, so scope the search to a window starting at the
  // assignment. A whole-file search would risk binding to an unrelated component
  // that happens to reuse the same minified var (e.g. a `.map((y)=>…)` list).
  const searchStart = verAssign.index;
  const searchRegion = fileContents.slice(searchStart, searchStart + 4000);
  // verVar is either the first child (`children:[verVar,…`) or a later one
  // (`children:[…,verVar,…`); the optional `(?:[^[\]]*?,)?` prefix covers both
  // without letting the array contain a nested bracket before verVar.
  const columnPattern = new RegExp(
    `[$\\w]+\\.jsxs\\([$\\w]+,\\{flexDirection:"column",children:\\[(?:[^[\\]]*?,)?${escapeIdent(verVar)}[,\\]]`
  );
  const columnMatch = searchRegion.match(columnPattern);
  if (!columnMatch || columnMatch.index === undefined) {
    return null;
  }
  const columnAbsIndex = searchStart + columnMatch.index;

  // Bracket-walk from this container's `children:[` to its matching `]`; insert
  // right before that `]` so the patches list becomes the last child.
  const childrenToken = 'children:[';
  const childrenOpen =
    fileContents.indexOf(childrenToken, columnAbsIndex) + childrenToken.length;
  if (childrenOpen < childrenToken.length) {
    return null;
  }
  let depth = 1;
  let closeIndex = -1;
  for (let i = childrenOpen; i < fileContents.length; i++) {
    const ch = fileContents[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  if (closeIndex === -1) {
    return null;
  }

  return { startIndex: closeIndex, endIndex: closeIndex };
};

/**
 * PATCH 3: Finds the location to insert the patches applied list
 */
const findPatchesListLocation = (
  fileContents: string
): LocationResult | null => {
  // Method 0 (CC ≥2.1.186): JSX-runtime header. Try the JSX shape first; the
  // older createElement-based methods below remain as fallbacks for CC ≤2.1.185.
  const jsxLoc = findPatchesListLocationJsx(fileContents);
  if (jsxLoc) {
    return jsxLoc;
  }

  // 1. Find the version display area (may already be modified by PATCH 2)
  // Find the "Claude Code" that's near dimColor:!0},"v" (the header version display)
  const versionDisplayPattern =
    /"Claude Code".{0,200}\{dimColor:!0\},"v",[$\w]+\)/;
  const versionDisplayMatch = fileContents.match(versionDisplayPattern);
  if (!versionDisplayMatch || versionDisplayMatch.index === undefined) {
    console.error(
      'patch: patchesAppliedIndication: failed to find version display for patch 3'
    );
    return null;
  }
  const matchResult = { index: versionDisplayMatch.index };

  // 2. Go back 5000 chars from the match start. CC ≥2.1.140 emits a very long
  // React-compiled header function (Cf4) where the version display lives ~1900+ bytes
  // after the function head. PATCH 2's own insertions push that further. 5000 leaves
  // a comfortable margin for future CC builds while still being scoped to "this region".
  const lookbackStart = Math.max(0, matchResult.index - 5000);
  const lookbackSubstring = fileContents.slice(
    lookbackStart,
    matchResult.index
  );

  // 3. Take the last function-declaration boundary. CC ≤2.1.138 emitted these as
  // `}function NAME(` (close-brace immediately followed by `function`). CC 2.1.140
  // emits them as `});function NAME(` (var/IIFE block close + semicolon, then
  // `function`). Match on `}` or `;` boundary with optional whitespace before
  // `function` (React Compiler wraps the header, so the prefix is `;function`).
  const functionPattern = /[};]\s*function ([$\w]+)\(/g;
  const functionMatches = Array.from(
    lookbackSubstring.matchAll(functionPattern)
  );
  if (functionMatches.length === 0) {
    console.error(
      'patch: patchesAppliedIndication: failed to find header component function'
    );
    return null;
  }
  const lastFunctionMatch = functionMatches[functionMatches.length - 1];
  const headerComponentName = lastFunctionMatch[1];

  // 4. Search for the createElement call with the header component
  const createHeaderPattern = new RegExp(
    `[^$\\w]([$\\w]+)\\.createElement\\(${escapeIdent(headerComponentName)},null\\),?`
  );
  const createHeaderMatch = fileContents.match(createHeaderPattern);
  if (!createHeaderMatch || createHeaderMatch.index === undefined) {
    console.error(
      'patch: patchesAppliedIndication: failed to find createElement call for header'
    );
    return null;
  }

  // 5. Find the variable assigned from createElement(header,null) and locate
  // where it's used as a child in a parent createElement. Insert after it there.
  // This works regardless of whether PATCH 2 has already modified the area.

  // Look backwards from createElement to find the variable name
  const beforeCreate = fileContents.slice(
    Math.max(0, createHeaderMatch.index - 30),
    createHeaderMatch.index + 1
  );
  // Match: VAR=COND&&  or  VAR=
  const varMatch = beforeCreate.match(/([$\w]+)=(?:[$\w]+&&)?[^$\w]?$/);
  if (varMatch) {
    const headerVar = varMatch[1];
    // Find where this variable is used as a child in a createElement:
    // ,headerVar, or ,headerVar) — in a flexDirection:"column" parent
    const searchAfter = fileContents.slice(
      createHeaderMatch.index,
      createHeaderMatch.index + 2000
    );
    // Look for ,VAR, (used as middle child) or ,VAR) (used as last child)
    const childUsePattern = new RegExp(`,${escapeIdent(headerVar)}([,\\)])`);
    const childUseMatch = searchAfter.match(childUsePattern);
    if (childUseMatch && childUseMatch.index !== undefined) {
      // Insert right after the variable reference (before the , or ))
      const insertIndex =
        createHeaderMatch.index +
        childUseMatch.index +
        childUseMatch[0].length -
        childUseMatch[1].length; // before the trailing , or )
      return {
        startIndex: insertIndex,
        endIndex: insertIndex,
      };
    }
  }

  // Fallback for older CC: insert after the createElement call
  const insertIndex = createHeaderMatch.index + createHeaderMatch[0].length;
  return {
    startIndex: insertIndex,
    endIndex: insertIndex,
  };
};

/**
 * Modifies the CLI to show patches applied indication
 * - PATCH 1: Modifies version output text
 * - PATCH 2: Adds tweakcc version to header
 * - PATCH 3: Adds patches applied list
 */
const IMPORTED_VERSION_ROW =
  /([$\w]+)=([$\w]+)\(([$\w]+),\{children:\[[$\w]+," ",([$\w]+)\(([$\w]+),\{dimColor:!0,children:\["v",[$\w]+\]\}\)\]\}\)/;

// Matches the row expression alone: it is assigned to a var up to 2.1.284
// (`ya=l(p,{...})`) and inlined as a column child from 2.1.285
// (`Pt=r(s,{flexDirection:"column",children:[r(s,{...}),St]})`).
const IMPORTED_BANNER_ROW =
  /([$\w]+)\(([$\w]+),\{flexDirection:"row",gap:2,alignItems:"center",children:\[[$\w]+,[$\w]+\]\}\)/y;

const TWEAKCC_MODULE_MARK = '/*@@TWEAKCC_MODULE:';

/** Start of the bundle module containing `index`; 0 on a single-module bundle. */
const moduleStartAt = (file: string, index: number): number => {
  const start = file.lastIndexOf(TWEAKCC_MODULE_MARK, index);
  return start === -1 ? 0 : start;
};

/**
 * Resolve the module-local `jsx` helper and `Text` component from the startup
 * header's product title. Two constraints, both load-bearing: the lookback is
 * clamped to the enclosing module, because a 2.1.246 code-split bundle reuses
 * these one-letter locals per module; and the NEAREST preceding match wins,
 * because the same title renders ~8MB away under different names.
 */
const findNearbyJsxTitle = (
  fileContents: string,
  at: number
): { jsx: string; text: string } | null => {
  const from = Math.max(moduleStartAt(fileContents, at), at - 4000);
  const window = fileContents.slice(from, at);
  const re = /([$\w]+)\(([$\w]+),\{bold:!0,children:"Claude Code"\}\)/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(window); m !== null; m = re.exec(window)) last = m;
  if (!last) return null;
  return { jsx: last[1], text: last[2] };
};

// CC >= 2.1.285 inlines the banner row as the first child of a column:
// `$t=r(s,{flexDirection:"column",children:[r(s,{flexDirection:"row",gap:2,
// alignItems:"center",children:[Ee,_t]}),ct]})`. Group 3 is the row alone (same
// jsx helper and Box as the column, hence the backreferences), so the caller
// wraps exactly what IMPORTED_BANNER_ROW would have matched.
const IMPORTED_BANNER_COLUMN =
  /[=(,:?[]([$\w]+)\(([$\w]+),\{flexDirection:"column",children:\[(\1\(\2,\{flexDirection:"row",gap:2,alignItems:"center",children:\[[$\w]+,[$\w]+\]\}\)),/g;

type BannerRow = {
  /** [0] the row expression, [1] jsx(s) helper, [2] Box; .index = row start. */
  rowMatch: RegExpExecArray;
  /** Module-local Text resolved from the "Claude Code" title; null if absent. */
  title: { jsx: string; text: string } | null;
};

const titleFor = (
  content: string,
  at: number,
  box: string
): { jsx: string; text: string } | null => {
  const title = findNearbyJsxTitle(content, at);
  return title && title.text !== box ? title : null;
};

/**
 * Locate the startup banner row. Since 2.1.322 a second module (an animated
 * Clawd row, `ft=r(s,{flexDirection:"row",gap:2,alignItems:"center",
 * children:[Xe,qt]})`) emits the same row shape EARLIER in the bundle, with no
 * "Claude Code" title in its module — so first-hit selection bound to it and
 * failed Text resolution. Every candidate must now resolve Text in its own
 * module; the first that does wins.
 *   Method 1 (CC >= 2.1.285): the row inlined as a column child.
 *   Method 2 (CC 2.1.246-2.1.284 fallback): the bare row, assigned to a var.
 * If no candidate resolves Text, the first row found is returned with a null
 * title so the caller logs the Text failure rather than splicing a Box.
 */
const findImportedBannerRow = (content: string): BannerRow | null => {
  let firstRow: RegExpExecArray | null = null;

  IMPORTED_BANNER_COLUMN.lastIndex = 0;
  for (const m of content.matchAll(IMPORTED_BANNER_COLUMN)) {
    const rowText = m[3];
    const rowStart = m.index! + m[0].length - 1 - rowText.length;
    IMPORTED_BANNER_ROW.lastIndex = rowStart;
    const row = IMPORTED_BANNER_ROW.exec(content);
    if (!row || row[0] !== rowText) continue;
    firstRow ??= row;
    const title = titleFor(content, rowStart, row[2]);
    if (title) return { rowMatch: row, title };
  }

  const anchor = ',{flexDirection:"row",gap:2,alignItems:"center",children:[';
  for (
    let at = content.indexOf(anchor);
    at !== -1;
    at = content.indexOf(anchor, at + anchor.length)
  ) {
    const head = /[$\w]+\([$\w]+$/.exec(
      content.slice(Math.max(0, at - 40), at)
    );
    if (!head) continue;
    IMPORTED_BANNER_ROW.lastIndex = at - head[0].length;
    const row = IMPORTED_BANNER_ROW.exec(content);
    if (!row) continue;
    firstRow ??= row;
    const title = titleFor(content, row.index, row[2]);
    if (title) return { rowMatch: row, title };
  }

  return firstRow ? { rowMatch: firstRow, title: null } : null;
};

const renderImportedJsxPatchList = (
  jsx: string,
  jsxs: string,
  box: string,
  text: string,
  patchesApplies: string[]
): string => {
  const rows = [
    `${jsxs}(${box},{children:[${jsx}(${text},{color:"success",bold:!0,children:"\\u2503 "}),${jsx}(${text},{color:"success",bold:!0,children:"\\u2713 tweakcc-fixed patches are applied"})]})`,
  ];
  for (const item of patchesApplies) {
    // \uXXXX-escape after JSON.stringify, never before: a prompt title carrying
    // an em dash spliced raw mojibakes against CC's Latin-1 module storage on a
    // Bun-compiled binary. The legacy renderer has always escaped; the imported
    // path is new, and skipping it here is what put a raw U+2014 in the bundle.
    const label = escapeNonAscii(JSON.stringify(`  * ${item}`));
    rows.push(
      `${jsxs}(${box},{children:[${jsx}(${text},{color:"success",bold:!0,children:"\\u2503 "}),${jsx}(${text},{dimColor:!0,children:${label}})]})`
    );
  }
  return `${jsxs}(${box},{flexDirection:"column",children:[${rows.join(',')}]})`;
};

/**
 * CC >= 2.1.246: jsx/jsxs are imported bindings, so the startup header is
 * `da=l(c,{children:[QS," ",l(c,{dimColor:!0,children:["v",Xm]})]})` rather
 * than `HELPER.jsxs(TEXT,{...})`. Spliced UI must use those same locals —
 * `React.createElement` is not in scope in the header module.
 */
const applyImportedJsxHeader = (
  content: string,
  tweakccVersion: string,
  patchesApplies: string[],
  showTweakccVersion: boolean,
  showPatchesApplied: boolean
): { content: string; didVersion: boolean; didList: boolean } => {
  // A marker already in the bundle counts as done, so a re-run is a no-op
  // instead of falling through to the legacy paths (which refuse on a split
  // bundle and would turn a second application into a null result).
  let didVersion = content.includes(`+ tweakcc v${tweakccVersion}`);
  let didList = content.includes('tweakcc-fixed patches are applied');

  if (showTweakccVersion && !didVersion) {
    const dim = ',{dimColor:!0,children:["v"';
    let dimAt = content.indexOf(dim);
    while (dimAt !== -1 && !didVersion) {
      const lookbackStart = Math.max(0, dimAt - 180);
      const window = content.slice(lookbackStart, dimAt + 80);
      const verMatch = window.match(IMPORTED_VERSION_ROW);
      if (verMatch && verMatch.index !== undefined) {
        const absIndex = lookbackStart + verMatch.index;
        const title = findNearbyJsxTitle(content, absIndex);
        const jsx = title?.jsx ?? verMatch[4];
        const text = title?.text ?? verMatch[5];
        const marker = `," ",${jsx}(${text},{color:"warning",bold:!0,children:${escapeNonAscii(JSON.stringify(`+ tweakcc v${tweakccVersion}`))}})`;
        const insertAt = absIndex + verMatch[0].length - 3;
        const old = content;
        content = content.slice(0, insertAt) + marker + content.slice(insertAt);
        showDiff(old, content, marker, insertAt, insertAt);
        didVersion = true;
        break;
      }
      dimAt = content.indexOf(dim, dimAt + dim.length);
    }
  }

  if (showPatchesApplied && !didList) {
    const banner = findImportedBannerRow(content);
    if (!banner) {
      if (content.includes(TWEAKCC_MODULE_MARK)) {
        console.error(
          'patch: patchesAppliedIndication: failed to find the startup banner row for the patches list'
        );
      }
      return { content, didVersion, didList };
    }
    const { rowMatch, title } = banner;
    const absIndex = rowMatch.index;
    const jsxs = rowMatch[1];
    const box = rowMatch[2];
    // No fallback here: `box` renders its children as a layout node, so
    // handing it a bare string throws Ink's "must be rendered inside <Text>"
    // at startup — an unrecoverable interface error that boots fine under
    // --print. Refuse to splice rather than emit a Box where Text is needed.
    if (!title) {
      console.error(
        'patch: patchesAppliedIndication: failed to find the Text component near the startup banner'
      );
      return { content, didVersion, didList };
    }
    const patchesElement = renderImportedJsxPatchList(
      title.jsx,
      jsxs,
      box,
      title.text,
      patchesApplies
    );
    const wrapped = `${jsxs}(${box},{flexDirection:"column",children:[${rowMatch[0]},${patchesElement}]})`;
    const old = content;
    content =
      content.slice(0, absIndex) +
      wrapped +
      content.slice(absIndex + rowMatch[0].length);
    showDiff(old, content, wrapped, absIndex, absIndex + wrapped.length);
    didList = true;
  }

  return { content, didVersion, didList };
};

export const writePatchesAppliedIndication = (
  fileContents: string,
  tweakccVersion: string,
  patchesApplies: string[],
  showTweakccVersion: boolean = true,
  showPatchesApplied: boolean = true
): string | null => {
  // PATCH 1: Version output modification
  const versionOutputLocation = findVersionOutputLocation(fileContents);
  if (!versionOutputLocation) {
    console.error(
      'patch: patchesAppliedIndication: failed to version output location'
    );
    return null;
  }

  const newText = `\\n${tweakccVersion} (tweakcc-fixed)`;
  // Patch ALL occurrences of the version pattern (commander help text + console.log early exit)
  const versionPattern = '}.VERSION} (Claude Code)';
  // Skip when already applied so a second run does not stack a second line.
  let content = fileContents.includes(versionPattern + newText)
    ? fileContents
    : fileContents.replaceAll(versionPattern, versionPattern + newText);

  showDiff(
    fileContents,
    content,
    newText,
    versionOutputLocation.endIndex,
    versionOutputLocation.endIndex
  );

  // CC >= 2.1.246 header: imported jsx/jsxs. Does not need the global React
  // var (which the ESM split no longer exposes as `X=loader(react(),1)`).
  const imported = applyImportedJsxHeader(
    content,
    tweakccVersion,
    patchesApplies,
    showTweakccVersion,
    showPatchesApplied
  );
  content = imported.content;

  const needLegacyVersion = showTweakccVersion && !imported.didVersion;
  const needLegacyList = showPatchesApplied && !imported.didList;
  if (!needLegacyVersion && !needLegacyList) {
    return content;
  }

  // Every path below splices `React.createElement(...)`, which is a module
  // global only on a single-bundle build. On a code-split bundle that name is
  // not in the header module's scope, so a "successful" legacy splice is a
  // ReferenceError at first render — worse than leaving the indicator off.
  if (content.includes(TWEAKCC_MODULE_MARK)) {
    console.error(
      'patch: patchesAppliedIndication: failed to patch the imported-jsx header; the legacy createElement paths do not apply to a code-split bundle'
    );
    return imported.didVersion || imported.didList ? content : null;
  }

  // Find shared components needed by the pre-2.1.246 header paths.
  const chalkVar = findChalkVar(fileContents);
  if (!chalkVar) {
    if (!imported.didVersion && !imported.didList) {
      console.error(
        'patch: patchesAppliedIndication: failed to find chalk variable'
      );
      return null;
    }
    return content;
  }

  const textComponent = findTextComponent(fileContents);
  if (!textComponent) {
    if (!imported.didVersion && !imported.didList) {
      console.error(
        'patch: patchesAppliedIndication: failed to find text component'
      );
      return null;
    }
    return content;
  }

  const reactVar = getReactVar(fileContents);
  if (!reactVar) {
    if (!imported.didVersion && !imported.didList) {
      console.error(
        'patch: patchesAppliedIndication: failed to find React variable'
      );
      return null;
    }
    return content;
  }

  // PATCH 2: Add tweakcc version to all header paths.
  // Path A: SyK banner borderText (chalk template literal)
  // Path B: SyK compact borderText (chalk call)
  // Path C: VyK compact React createElement (separate variable, like CC does)
  if (showTweakccVersion) {
    // Path A: Banner borderText — ` ${N7("claude",e)("Claude Code")} ${N7("inactive",e)(`v${x}`)} `
    const bannerPattern =
      /(\$\{([$\w]+)\("inactive",([$\w]+)\)\(`v\$\{[$\w]+\}`\)\}) `,/;
    const bannerMatch = content.match(bannerPattern);
    if (bannerMatch && bannerMatch.index !== undefined) {
      const oldStr = bannerMatch[0];
      const n7Fn = bannerMatch[2];
      const themeVar = bannerMatch[3];
      const newStr = `${bannerMatch[1]} \${${n7Fn}("warning",${themeVar})("+ tweakcc v${tweakccVersion}")} \`,`;
      content = content.replace(oldStr, newStr);
    }

    // Path B: SyK compact borderText — K6=N7("claude",e)(" Claude Code ")
    content = content.replace(
      /([$\w]+\("claude",[$\w]+\)\(" Claude Code) ("\))/,
      `$1 + tweakcc v${tweakccVersion} $2`
    );
    const locs = findTweakccVersionLocations(content);
    if (!locs) {
      console.error(
        'patch: patchesAppliedIndication: patch 2 skipped (header version pattern changed)'
      );
    } else if ('jsxInline' in locs) {
      // CC ≥2.1.186 JSX runtime: append one inline child element to the header
      // version row's children array. No separate `let _tw=` declaration —
      // the title row is a JSX element, so we splice a sibling jsx() call.
      const { insertIndex, helper, textComponent } = locs.jsxInline;
      const refCode = `," ",${helper}.jsx(${textComponent},{children:${chalkVar}.hex("#FF8400").bold("+ tweakcc v${tweakccVersion}")})`;

      const oldContent2 = content;
      content =
        content.slice(0, insertIndex) + refCode + content.slice(insertIndex);

      showDiff(oldContent2, content, refCode, insertIndex, insertIndex);
    } else {
      // Step 1: Insert variable declaration after the "Claude Code" bold element
      const varName = '_tw';
      const varDecl = `let ${varName}=${locs.reactVar}.createElement(${locs.textComponent},null,${chalkVar}.hex("#FF8400").bold("+ tweakcc v${tweakccVersion}"));`;

      const oldContent2a = content;
      content =
        content.slice(0, locs.varInsertIndex) +
        varDecl +
        content.slice(locs.varInsertIndex);

      showDiff(
        oldContent2a,
        content,
        varDecl,
        locs.varInsertIndex,
        locs.varInsertIndex
      );

      // Step 2: Insert variable reference as sibling in the parent createElement
      // (adjust refInsertIndex for the inserted varDecl)
      const adjustedRefIndex = locs.refInsertIndex + varDecl.length;
      const refCode = `," ",${varName}`;

      const oldContent2b = content;
      content =
        content.slice(0, adjustedRefIndex) +
        refCode +
        content.slice(adjustedRefIndex);

      showDiff(
        oldContent2b,
        content,
        refCode,
        adjustedRefIndex,
        adjustedRefIndex
      );
    }
  }

  // PATCH 3: Add patches applied list (if enabled)
  if (showPatchesApplied) {
    const boxComponent = findBoxComponent(content);
    if (!boxComponent) {
      console.error(
        'patch: patchesAppliedIndication: PATCH 3 skipped (Box component not located on this CC version)'
      );
      return content;
    }
    // PATCH 3 (jsx, CC ≥2.1.186): the startup banner is a flex ROW —
    //   R=H.jsxs($,{flexDirection:"row",gap:2,alignItems:"center",children:[
    //       LOGO, H.jsxs($,{flexDirection:"column",children:[hdr…]})]})
    // with the Clawd logo as the LEFT child. Inserting the (tall) patches list
    // INTO the header column makes the vertically-centered logo float to the
    // MIDDLE of the list and indents the whole list by the logo column. Instead,
    // wrap the row in a column and render the list BELOW it: the logo then spans
    // only the header, and the list is full-width. Falls back to the createElement
    // header insertion for CC ≤2.1.185.
    const bannerRowRe =
      /([$\w]+)=([$\w]+)\.jsxs\(([$\w]+),\{flexDirection:"row",gap:2,alignItems:"center",children:\[[$\w]+,[$\w]+\.jsxs\([$\w]+,\{flexDirection:"column",children:\[[$\w,]+\]\}\)\]\}\)/;
    const bannerMatch = content.match(bannerRowRe);
    if (bannerMatch && bannerMatch.index !== undefined) {
      const assignVar = bannerMatch[1];
      const helper = bannerMatch[2];
      const rowBox = bannerMatch[3]; // the Box component the banner row uses
      const rowExpr = bannerMatch[0].slice(assignVar.length + 1); // strip "VAR="
      // The patches list as a standalone column element (createElement interops
      // with jsx); no surrounding array commas — it's placed as the 2nd child.
      const el = [
        `${reactVar}.createElement(${boxComponent}, { flexDirection: "column" },`,
        `${reactVar}.createElement(${boxComponent}, null, ${reactVar}.createElement(${textComponent}, {color: "success", bold: true}, "\\u2503 "), ${reactVar}.createElement(${textComponent}, {color: "success", bold: true}, "\\u2713 tweakcc-fixed patches are applied")),`,
      ];
      for (let item of patchesApplies) {
        item = item.replace('CHALK_VAR', chalkVar);
        el.push(
          renderPatchListItemRow(reactVar, boxComponent, textComponent, item)
        );
      }
      el.push(')');
      const patchesElement = el.join('\n');
      const wrapped = `${assignVar}=${helper}.jsxs(${rowBox},{flexDirection:"column",children:[${rowExpr},${patchesElement}]})`;
      const oldContent3 = content;
      content =
        content.slice(0, bannerMatch.index) +
        wrapped +
        content.slice(bannerMatch.index + bannerMatch[0].length);
      showDiff(
        oldContent3,
        content,
        wrapped,
        bannerMatch.index,
        bannerMatch.index + wrapped.length
      );
    } else {
      const patchesListLoc = findPatchesListLocation(content);
      if (!patchesListLoc) {
        // findPatchesListLocation already logged the specific cause (e.g. header
        // component function not found on CC >= 2.1.86). Don't duplicate as an
        // error — this is a cascade from the underlying shape change.
        console.log(
          'patch: patchesAppliedIndication: patch 3 skipped (see prior message)'
        );
      } else {
        const lines = [];
        lines.push(
          `,${reactVar}.createElement(${boxComponent}, { flexDirection: "column" },`
        );
        lines.push(
          `${reactVar}.createElement(${boxComponent}, null, ${reactVar}.createElement(${textComponent}, {color: "success", bold: true}, "\\u2503 "), ${reactVar}.createElement(${textComponent}, {color: "success", bold: true}, "\\u2713 tweakcc-fixed patches are applied")),`
        );
        for (let item of patchesApplies) {
          item = item.replace('CHALK_VAR', chalkVar);
          lines.push(
            renderPatchListItemRow(reactVar, boxComponent, textComponent, item)
          );
        }
        lines.push('),');
        let patchesListCode = lines.join('\n');

        // Avoid double comma at the start
        if (
          patchesListLoc.startIndex > 0 &&
          content[patchesListLoc.startIndex - 1] === ',' &&
          patchesListCode.startsWith(',')
        ) {
          patchesListCode = patchesListCode.slice(1);
        }

        // Avoid double comma at the end — if patches list ends with ',' and
        // the next char is also ','
        if (
          patchesListCode.endsWith(',') &&
          content[patchesListLoc.startIndex] === ','
        ) {
          patchesListCode = patchesListCode.slice(0, -1);
        }

        const oldContent3 = content;
        content =
          content.slice(0, patchesListLoc.startIndex) +
          patchesListCode +
          content.slice(patchesListLoc.endIndex);

        showDiff(
          oldContent3,
          content,
          patchesListCode,
          patchesListLoc.startIndex,
          patchesListLoc.endIndex
        );
      }
    }
  }

  // PATCH 4 & 5 disabled on CC ≥2.1.86 — the indicator view insertion
  // creates a double-comma syntax error due to changed code structure.
  // Tweakcc version is shown via PATCH 1/2/3.

  return content;
};
