// Please see the note about writing patches in ./index

import {
  showDiff,
  findChalkVar,
  findTextComponent,
  findBoxComponent,
  getReactVar,
} from './index';
import {
  findSlashCommandListEndPosition,
  writeSlashCommandDefinition as writeSlashCommandDefinitionToArray,
} from './slashCommands';
import { Toolset } from '../types';

// ============================================================================
// UTILITY FUNCTIONS - Minified-JS scanning
// ============================================================================

const REGEX_ALLOWED_BEFORE = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
]);

const REGEX_ALLOWED_KEYWORDS = [
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
];

// A '/' starts a regex literal only where an expression may begin. Look back at
// the previous significant character: an operator/punctuator means regex, an
// identifier/number/closing bracket means division.
const isRegexStart = (file: string, index: number): boolean => {
  let i = index - 1;
  while (i >= 0 && /\s/.test(file[i])) i--;
  if (i < 0) return true;
  const c = file[i];
  if (REGEX_ALLOWED_BEFORE.has(c)) return true;
  if (!/[$\w]/.test(c)) return false;
  let start = i;
  while (start >= 0 && /[$\w]/.test(file[start])) start--;
  return REGEX_ALLOWED_KEYWORDS.includes(file.slice(start + 1, i + 1));
};

const skipQuoted = (file: string, index: number): number => {
  const quote = file[index];
  let i = index + 1;
  while (i < file.length) {
    const c = file[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return -1;
};

const skipRegexLiteral = (file: string, index: number): number => {
  let i = index + 1;
  let inClass = false;
  while (i < file.length) {
    const c = file[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') return -1;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < file.length && /[a-z]/.test(file[i])) i++;
      return i;
    }
    i++;
  }
  return -1;
};

const skipTemplate = (file: string, index: number): number => {
  let i = index + 1;
  while (i < file.length) {
    const c = file[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return i + 1;
    if (c === '$' && file[i + 1] === '{') {
      const end = matchDelimiter(file, i + 1);
      if (end === null) return -1;
      i = end + 1;
      continue;
    }
    i++;
  }
  return -1;
};

/**
 * Find the index of the delimiter matching the '{' or '(' at openIndex,
 * skipping over strings, template literals, comments and regex literals so
 * braces that only appear inside a string cannot throw the count off.
 */
export const matchDelimiter = (
  file: string,
  openIndex: number
): number | null => {
  const open = file[openIndex];
  const close = open === '{' ? '}' : open === '(' ? ')' : '';
  if (!close) return null;

  let depth = 0;
  let i = openIndex;
  while (i < file.length) {
    const c = file[i];
    if (c === '/' && file[i + 1] === '/') {
      const nl = file.indexOf('\n', i);
      if (nl === -1) return null;
      i = nl + 1;
      continue;
    }
    if (c === '/' && file[i + 1] === '*') {
      const end = file.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const next = skipQuoted(file, i);
      if (next < 0) return null;
      i = next;
      continue;
    }
    if (c === '`') {
      const next = skipTemplate(file, i);
      if (next < 0) return null;
      i = next;
      continue;
    }
    if (c === '/' && isRegexStart(file, i)) {
      const next = skipRegexLiteral(file, i);
      if (next < 0) return null;
      i = next;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return null;
};

// ============================================================================
// UTILITY FUNCTIONS - Variable Discovery
// ============================================================================

/**
 * Find Select component using function signature pattern
 */
export const findSelectComponentName = (
  fileContents: string
): string | null => {
  // Method 1 (CC >=2.1.186): the jsx runtime replaced createElement, and the
  // children/props moved into the object literal:
  //   Mb.jsx(ya,{confirmLabel:"Yes, use recommended settings",...})
  const jsxPattern =
    /\.jsxs?\(([$\w]+),\{[\s\S]{0,100}"Yes, use recommended settings"/;
  const jsxMatch = fileContents.match(jsxPattern);
  if (jsxMatch) {
    return jsxMatch[1];
  }

  // Method 2 (CC <2.1.186): classic createElement call.
  const selectPattern =
    /\.createElement\(([$\w]+),.{0,100}"Yes, use recommended settings"/;
  const match = fileContents.match(selectPattern);
  if (!match) {
    console.error(
      'patch: findSelectComponentName: failed to find selectPattern'
    );
    return null;
  }

  return match[1];
};

/**
 * Find Divider component using function signature pattern
 */
export const findDividerComponentName = (
  fileContents: string
): string | null => {
  // Pattern matches the Divider component's function signature
  // TODO: this could be refactored to a single function that takes a list of params, and maybe even finds and returns the longest match.
  const dividerPattern =
    /function ([$\w]+)(?:\([$\w]+\)\{let [$\w]+=[$\w]+\(\d+\),\{(?:(?:orientation|title|width|padding|titlePadding|titleColor|titleDimColor|dividerChar|dividerColor|dividerDimColor|boxProps):[$\w]+,?)+\}=|\(\{(?:(?:orientation|title|width|padding|titlePadding|titleColor|titleDimColor|dividerChar|dividerColor|dividerDimColor|boxProps):[$\w]+(?:=(?:[^,]+,|[^}]+\})|[,}]))+\))/g;

  const matches = Array.from(fileContents.matchAll(dividerPattern));
  if (matches.length === 0) {
    return null;
  }

  // Return the longest match (most complete signature)
  let longestMatch = matches[0];
  for (const match of matches) {
    if (match[0].length > longestMatch[0].length) {
      longestMatch = match;
    }
  }

  return longestMatch[1];
};

/**
 * Find the start of the main app component body
 */
export const getMainAppComponentBodyStart = (
  fileContents: string
): number | null => {
  // Pattern matches the main app component function signature with all its props
  // Updated for 2.1.20: added initialAgentName, initialAgentColor, taskListId, remoteSessionConfig, autoTickIntervalMs
  const appComponentPattern =
    /function ([$\w]+)\(\{(?:\w+:[$\w]+(?:=(?:[^,]+,|[^}]+\})|[,}]))+initialFileHistorySnapshots:[$\w]+,(?:\w+:[$\w]+(?:=(?:[^,]+,|[^}]+\})|[,}]))+\)/g;

  const allMatches = Array.from(fileContents.matchAll(appComponentPattern));
  // Filter to only matches that contain 'commands:' - unique to main app component
  const matches = allMatches.filter(m => m[0].includes('commands:'));
  if (matches.length === 0) {
    console.error(
      'patch: getMainAppComponentBodyStart: failed to find appComponentPattern'
    );
    return null;
  }

  // Take the very longest match
  let longestMatch = matches[0];
  for (const match of matches) {
    if (match[0].length > longestMatch[0].length) {
      longestMatch = match;
    }
  }

  if (longestMatch.index === undefined) {
    console.error(
      'patch: getMainAppComponentBodyStart: failed to find appComponentPattern longestMatch'
    );
    return null;
  }

  return longestMatch.index + longestMatch[0].length;
};

/**
 * Get app state selector and useState function names
 */
export const getAppStateSelectorAndUseState = (
  fileContents: string
): { appStateUseSelectorFn: string; appStateSetState: string } | null => {
  // CC <2.1.83: function D8(...`Your selector in...function iA(){return STORE().setState}
  const oldPattern =
    /function ([$\w]+)\(.{0,110}`Your selector in.{0,1000}?function ([$\w]+)\(\)\{return [$\w]+\(\)\.setState\}/;
  const oldMatch = fileContents.match(oldPattern);

  if (oldMatch) {
    return {
      appStateUseSelectorFn: oldMatch[1],
      appStateSetState: oldMatch[2],
    };
  }

  // CC >=2.1.83: Find selector function that uses useSyncExternalStore with a store
  // that contains thinkingEnabled. Pattern:
  //   function D8(A){...STORE(),...useSyncExternalStore(...)...}
  //   function iA(){return STORE().setState}
  // where STORE is used in context with thinkingEnabled

  // Step 1: Find setState functions: function NAME(){return STORE().setState}
  const setStatePat = /function ([$\w]+)\(\)\{return ([$\w]+)\(\)\.setState\}/g;
  const setStateMatches = Array.from(fileContents.matchAll(setStatePat));

  for (const ssMatch of setStateMatches) {
    const setStateFn = ssMatch[1];
    const storeFn = ssMatch[2];

    // Step 2: Find the selector function that calls STORE() and useSyncExternalStore
    // within its own body (no crossing function boundaries)
    const escapedStore = storeFn.replace(/\$/g, '\\$');
    const selectorPat = new RegExp(
      `function ([$\\w]+)\\([$\\w]+\\)\\{(?:(?!\\bfunction\\b).){0,300}${escapedStore}\\(\\)(?:(?!\\bfunction\\b).){0,300}useSyncExternalStore\\(`
    );
    const selectorMatch = fileContents.match(selectorPat);
    if (!selectorMatch) continue;

    const selectorFn = selectorMatch[1];

    // Step 3: Verify this is the app state store (has thinkingEnabled)
    const escapedSelector = selectorFn.replace(/\$/g, '\\$');
    const verifyPat = new RegExp(`${escapedSelector}\\(.{0,80}thinkingEnabled`);
    if (!verifyPat.test(fileContents)) continue;

    return {
      appStateUseSelectorFn: selectorFn,
      appStateSetState: setStateFn,
    };
  }

  console.error(
    'patch: getAppStateSelectorAndUseState: failed to find pattern'
  );
  return null;
};

/**
 * Find the top-level position before the slash command list
 * This is where we'll insert the toolset component definition
 */
export const findTopLevelPositionBeforeSlashCommand = (
  fileContents: string
): number | null => {
  const arrayEnd = findSlashCommandListEndPosition(fileContents);
  if (arrayEnd === null) {
    console.error(
      'patch: findTopLevelPositionBeforeSlashCommand: failed to find arrayEnd'
    );
    return null;
  }

  // Example code structure (from spec):
  // var Nb2, Dj, bD, ttA, YeA, etA;
  // var OH = R(() => {
  //   _A1();
  //   mTQ();
  //   ...
  //   ((Nb2 = G0(() => [
  //     Lb2,
  //     Cv2,
  //     pTQ,  <-- We're at the end of this array
  //   ]
  //
  // We need to walk backwards from arrayEnd to find the opening '{' of the block
  // that contains this array, then find the semicolon before it.

  // Use stack machine to walk backwards out of the block
  let level = 1; // We're inside a block
  let i = arrayEnd;

  while (i >= 0 && level > 0) {
    if (fileContents[i] === '}') {
      level++; // Going backwards, so } means entering a deeper block
    } else if (fileContents[i] === '{') {
      level--; // Going backwards, so { means exiting a block
      if (level === 0) {
        break; // Found the opening brace
      }
    }
    i--;
  }

  if (i < 0) {
    console.error(
      'patch: findTopLevelPositionBeforeSlashCommand: failed to find matching open-brace'
    );
    return null;
  }

  // Now walk backwards from the '{' to find the previous semicolon
  while (i >= 0 && fileContents[i] !== ';') {
    i--;
  }

  if (i < 0) {
    console.error(
      'patch: findTopLevelPositionBeforeSlashCommand: failed to find matching semicolon'
    );
    return null;
  }

  // Return the position AFTER the semicolon
  return i + 1;
};

// ============================================================================
// SUB-PATCH IMPLEMENTATIONS
// ============================================================================

/**
 * Sub-patch 1: Add toolset field to app state initialization
 */
export const writeToolsetFieldToAppState = (
  oldFile: string,
  defaultToolset: string | null
): string | null => {
  // Find all occurrences of thinkingEnabled:SOMETHING()
  const thinkingEnabledPattern = /thinkingEnabled:([$\w]+)\(\)/g;
  const matches = Array.from(oldFile.matchAll(thinkingEnabledPattern));

  if (matches.length === 0) {
    console.error('patch: toolsets: failed to find thinkingEnabled pattern');
    return null;
  }

  // Collect all end indices
  const modifications: { index: number }[] = [];
  for (const match of matches) {
    if (match.index !== undefined) {
      const endIndex = match.index + match[0].length;
      modifications.push({ index: endIndex });
    }
  }

  // Sort in descending order to avoid index shifts
  modifications.sort((a, b) => b.index - a.index);

  // Apply modifications
  let newFile = oldFile;
  const toolsetValue = defaultToolset
    ? JSON.stringify(defaultToolset)
    : 'undefined';
  const textToInsert = `,toolset:${toolsetValue}`;
  for (const mod of modifications) {
    newFile =
      newFile.slice(0, mod.index) + textToInsert + newFile.slice(mod.index);
  }

  if (newFile === oldFile) {
    console.error('patch: toolsets: failed to modify app state initialization');
    return null;
  }

  // Show diff for the last modification (representative of all changes)
  const lastMod = modifications[modifications.length - 1];
  showDiff(oldFile, newFile, textToInsert, lastMod.index, lastMod.index);

  return newFile;
};

/**
 * Sub-patch 2: Modify tool fetching useMemo to respect toolset
 */
export const writeToolFetchingUseMemo = (
  oldFile: string,
  toolsets: Toolset[],
  defaultToolset: string | null
): string | null => {
  const stateInfo = getAppStateSelectorAndUseState(oldFile);
  if (!stateInfo) {
    console.error(
      'patch: toolsets: toolFetchingMemo: failed to find app state info'
    );
    return null;
  }

  const { appStateUseSelectorFn } = stateInfo;

  // Pattern to find: let toolAggregationVar=toolAggregationCode(arg1,arg2.tools,arg3);
  const pattern = /let ([$\w]+)=([$\w]+\([$\w]+,[$\w]+\.tools,[$\w]+\)),/;
  const match = oldFile.match(pattern);

  if (!match || match.index === undefined) {
    console.error('patch: toolsets: failed to find tool aggregation pattern');
    return null;
  }

  const toolAggregationVar = match[1];
  const toolAggregationCode = match[2];

  // Create toolsets mapping: { "toolset-name": ["tool1", "tool2", ...] }
  const toolsetsJSON = JSON.stringify(
    Object.fromEntries(
      toolsets.map(ts => [
        ts.name,
        ts.allowedTools === '*' ? '*' : ts.allowedTools,
      ])
    )
  );

  // When persisted app state is loaded it may not have a toolset field (saved before
  // the toolset patch existed), causing currentToolset to be undefined. Fall back to
  // defaultToolset so the restriction is active from the very first render.
  const fallback = defaultToolset
    ? JSON.stringify(defaultToolset)
    : 'undefined';

  // Generate the replacement code
  const replacement = `let currentToolset = ${appStateUseSelectorFn}(state => state.toolset) ?? ${fallback};
let ${toolAggregationVar} = undefined;
const toolsets = ${toolsetsJSON};
if (toolsets.hasOwnProperty(currentToolset)) {
  const allowedTools = toolsets[currentToolset];
  if (allowedTools === "*") {
    ${toolAggregationVar} = ${toolAggregationCode};
  } else {
    ${toolAggregationVar} = ${toolAggregationCode}.filter((toolDef) => allowedTools.includes(toolDef.name));
  }
} else {
  ${toolAggregationVar} = ${toolAggregationCode};
}let `;

  const startIndex = match.index;
  const endIndex = startIndex + match[0].length;

  const newFile =
    oldFile.slice(0, startIndex) + replacement + oldFile.slice(endIndex);

  showDiff(oldFile, newFile, replacement, startIndex, endIndex);

  return newFile;
};

/**
 * Sub-patch 2b: Patch computeTools() to also filter the tools sent to the API.
 *
 * Sub-patch 2 only filters the UI display list (useMergedTools). The actual tools
 * sent to the Claude API come from computeTools() inside getToolUseContext(), which
 * independently recomputes the full unfiltered tool list from the store.
 *
 * In the minified code, computeTools looks like:
 *   VARNAME=()=>{let STATE=STORE.getState(),
 *     ASSEMBLED=assembleToolPool(STATE.toolPermissionContext,STATE.mcp.tools),
 *     MERGED=mergeAndFilterTools(INIT,ASSEMBLED,STATE.toolPermissionContext.mode);
 *     if(!AGENT)return MERGED;
 *     return resolve(AGENT,MERGED,!1,!0).resolvedTools}
 *
 * We wrap both return statements with the toolset filter.
 */
export const writeComputeToolsFilter = (
  oldFile: string,
  toolsets: Toolset[],
  defaultToolset: string | null
): string | null => {
  const stateInfo = getAppStateSelectorAndUseState(oldFile);
  if (!stateInfo) {
    console.error(
      'patch: toolsets: computeToolsFilter: failed to find app state info'
    );
    return null;
  }

  // stateInfo validated above — computeTools reads toolset from STORE.getState() directly

  // Create toolsets mapping (shared by both methods)
  const toolsetsMapJSON = JSON.stringify(
    Object.fromEntries(
      toolsets.map(ts => [
        ts.name,
        ts.allowedTools === '*' ? '*' : ts.allowedTools,
      ])
    )
  );
  const toolsetFallback = defaultToolset
    ? JSON.stringify(defaultToolset)
    : 'undefined';

  // Method 1 (CC >=2.1.219): the closure gained a ref-backed memo cache and the
  // agent-resolution branch collapsed into a ternary inside a post-filter call:
  //   VAR=NS.useCallback(()=>{let STATE=STORE.getState(),CACHE=REF.current;
  //     if(CACHE!==null&&CACHE.tpc===STATE.toolPermissionContext&&...)return CACHE.result;
  //     SIDE(...);
  //     let ASSEMBLED=ASSEMBLE(STATE.toolPermissionContext,STATE.mcp.tools,{skillTools:STATE.skillTools}),
  //       MERGED=MERGE(INIT,ASSEMBLED,STATE.toolPermissionContext.mode),
  //       RESULT=POST(AGENT?RESOLVE(AGENT,MERGED,!1,!0).resolvedTools:MERGED,STATE.toolPermissionContext);
  //     return REF.current={tpc:...,result:RESULT},RESULT},[deps])
  // Both exits are wrapped; the cache keeps storing the UNFILTERED list so a
  // /toolset switch takes effect without invalidating the memo.
  //
  // CC 2.1.232 kept this shape but grew two optional pieces, both tolerated
  // below so older builds still match: the assemble call's options object
  // gained `,activeAgents:STATE.agentDefinitions.activeAgents`, and the agent
  // arm wraps MERGED in a nested call —
  // `RESOLVE(AGENT,INNER(AGENT,MERGED,STATE.toolPermissionContext,{...}),!1,!0)`
  // instead of `RESOLVE(AGENT,MERGED,!1,!0)`. The cache-guard and cache-object
  // windows also widened to 600 because the guard gained an `ad` key.
  //
  // CC 2.1.233 added a THIRD declarator to the opening `let` — the todo-tools
  // read (`,Nn=pJ()`) that feeds the new `todoTools` cache key — landing between
  // `REF.current` and the `if(`. The optional declarator list below tolerates
  // that and any further ones, since Anthropic keeps hanging cache keys here.
  const memoPattern =
    /([,;{])([$\w]+)=([$\w]+\.useCallback\()\(\)=>\{let ([$\w]+)=([$\w]+)\.getState\(\),([$\w]+)=([$\w]+)\.current(?:,[$\w]+=[^;]{0,80})*;if\(\6!==null&&[\s\S]{0,600}?\)return \6\.result;[\s\S]{0,300}?let ([$\w]+)=[$\w]+\(\4\.toolPermissionContext,\4\.mcp\.tools(?:,\{skillTools:\4\.skillTools(?:,activeAgents:[^{}]*)?\})?\),([$\w]+)=[$\w]+\([$\w]+,\8,\4\.toolPermissionContext\.mode\),([$\w]+)=[$\w]+\([$\w]+\?[$\w]+\([$\w]+,(?:\9|[$\w]+\([$\w]+,\9,[^()]*\)),!1,!0\)\.resolvedTools:\9,\4\.toolPermissionContext\);return \7\.current=\{[\s\S]{0,600}?result:\10\},\10\},\[/;

  const memoMatch = oldFile.match(memoPattern);
  if (memoMatch && memoMatch.index !== undefined) {
    const full = memoMatch[0];
    const stateVar = memoMatch[4];
    const cacheVar = memoMatch[6];
    const resultVar = memoMatch[10];

    const helper = `const __ts=${toolsetsMapJSON},__tf=(t,s)=>{const n=s.toolset??${toolsetFallback};globalThis.__tweakcc_toolset={name:n,tools:__ts[n]};if(__ts.hasOwnProperty(n)){const a=__ts[n];if(a==="*")return t;return t.filter(d=>a.includes(d.name))}return t};`;

    const bodyStart = full.indexOf('()=>{');
    const cachedReturn = `return ${cacheVar}.result;`;
    const cachedIndex = full.indexOf(cachedReturn);
    const tail = `,${resultVar}},[`;

    if (bodyStart === -1 || cachedIndex === -1 || !full.endsWith(tail)) {
      console.error(
        'patch: toolsets: computeToolsFilter: memoized shape matched but landmarks missing'
      );
      return null;
    }

    // Splice from the highest index down so earlier offsets stay valid.
    let patched =
      full.slice(0, full.length - tail.length) +
      `,__tf(${resultVar},${stateVar})},[`;
    patched =
      patched.slice(0, cachedIndex) +
      `return __tf(${cacheVar}.result,${stateVar});` +
      patched.slice(cachedIndex + cachedReturn.length);
    patched =
      patched.slice(0, bodyStart + 5) + helper + patched.slice(bodyStart + 5);

    const startIndex = memoMatch.index;
    const endIndex = startIndex + full.length;
    const newFile =
      oldFile.slice(0, startIndex) + patched + oldFile.slice(endIndex);

    showDiff(oldFile, newFile, patched, startIndex, endIndex);

    return newFile;
  }

  // Method 2 (CC <=2.1.218): find the computeTools closure pattern:
  // Old form: VAR=()=>{let STATE=STORE.getState(),ASSEMBLED=ASSEMBLE(STATE.toolPermissionContext,STATE.mcp.tools),MERGED=MERGE(INIT,ASSEMBLED,STATE.toolPermissionContext.mode);if(!AGENT)return MERGED;return RESOLVE(AGENT,MERGED,!1,!0).resolvedTools}
  // CC 2.1.140+: VAR=NS.useCallback(()=>{...let ASSEMBLED=ASSEMBLE(STATE.toolPermissionContext,STATE.mcp.tools,{skillTools:STATE.skillTools}),...},[deps])
  const pattern =
    /([$\w]+)=(?:([$\w]+\.useCallback\())?\(\)=>\{let ([$\w]+)=([$\w]+)\.getState\(\),([$\w]+)=([$\w]+)\(\3\.toolPermissionContext,\3\.mcp\.tools(?:,\{skillTools:\3\.skillTools\})?\),([$\w]+)=([$\w]+)\([$\w]+,\5,\3\.toolPermissionContext\.mode\);if\(!([$\w]+)\)return \7;return ([$\w]+)\(\9,\7,!1,!0\)\.resolvedTools\}/;

  const match = oldFile.match(pattern);
  if (!match || match.index === undefined) {
    console.error(
      'patch: toolsets: computeToolsFilter: failed to find computeTools pattern'
    );
    return null;
  }

  const closureVar = match[1];
  const useCallbackPrefix = match[2] || '';
  const stateVar = match[3];
  const storeVar = match[4];
  const assembledVar = match[5];
  const assembleFn = match[6];
  const mergedVar = match[7];
  const mergeFn = match[8];
  const agentVar = match[9];
  const resolveFn = match[10];
  const skillToolsArg = match[0].includes(`{skillTools:${stateVar}.skillTools}`)
    ? `,{skillTools:${stateVar}.skillTools}`
    : '';

  // Create toolsets mapping
  const toolsetsJSON = JSON.stringify(
    Object.fromEntries(
      toolsets.map(ts => [
        ts.name,
        ts.allowedTools === '*' ? '*' : ts.allowedTools,
      ])
    )
  );

  const fallback = defaultToolset
    ? JSON.stringify(defaultToolset)
    : 'undefined';

  // Actually let me re-examine the match to get the init tools var
  const fullMatch = match[0];
  // Extract the init var from MERGE(INIT,ASSEMBLED,...)
  const mergeCallMatch = fullMatch.match(
    new RegExp(
      `${mergeFn.replace(/\$/g, '\\$')}\\(([$\\w]+),${assembledVar.replace(/\$/g, '\\$')},`
    )
  );
  if (!mergeCallMatch) {
    console.error(
      'patch: toolsets: computeToolsFilter: failed to extract init var from merge call'
    );
    return null;
  }
  const initVar = mergeCallMatch[1];

  // Set globalThis.__tweakcc_toolset so the error message helper can read it
  const newClosure = `${closureVar}=${useCallbackPrefix}()=>{let ${stateVar}=${storeVar}.getState(),${assembledVar}=${assembleFn}(${stateVar}.toolPermissionContext,${stateVar}.mcp.tools${skillToolsArg}),${mergedVar}=${mergeFn}(${initVar},${assembledVar},${stateVar}.toolPermissionContext.mode);const __ts=${toolsetsJSON},__tc=${stateVar}.toolset??${fallback},__tf=(t)=>{globalThis.__tweakcc_toolset={name:__tc,tools:__ts[__tc]};if(__ts.hasOwnProperty(__tc)){const a=__ts[__tc];if(a==="*")return t;return t.filter(d=>a.includes(d.name))}return t};if(!${agentVar})return __tf(${mergedVar});return __tf(${resolveFn}(${agentVar},${mergedVar},!1,!0).resolvedTools)}`;

  const startIndex = match.index;
  const endIndex = startIndex + fullMatch.length;

  const newFile =
    oldFile.slice(0, startIndex) + newClosure + oldFile.slice(endIndex);

  showDiff(oldFile, newFile, newClosure, startIndex, endIndex);

  return newFile;
};

/**
 * Sub-patch 2c: Patch the non-interactive --print tool context.
 *
 * The interactive app passes tools from computeTools(), patched above. The
 * print path builds its own tools list from app state and passes it directly
 * to the query loop, so it needs the same filter at that callsite.
 */
export const writePrintToolsFilter = (
  oldFile: string,
  toolsets: Toolset[],
  defaultToolset: string | null
): string | null => {
  const toolsetsJSON = JSON.stringify(
    Object.fromEntries(
      toolsets.map(ts => [
        ts.name,
        ts.allowedTools === '*' ? '*' : ts.allowedTools,
      ])
    )
  );
  const fallback = defaultToolset
    ? JSON.stringify(defaultToolset)
    : 'undefined';

  // Anchored on unique code SHAPES, with every relationship derived by search
  // rather than by distance. Two earlier forms broke on the same class of
  // change: `let X=F(S)` plus a 2500-char lookahead (CC 2.1.235 pushed the pair
  // 2,672 apart), then `tools:X,refreshTools:()=>F(G())` in one object literal.
  //
  // CC 2.1.238 split that object. The print path now hoists its arrows into
  // named consts and hands the SAME thunk to both slots, and the eager array
  // moved to a different call:
  //
  //   let Pk=zs(sH), …                                   // eager, for ACy(...)
  //   Yh=()=>zs(l()), If=()=>Iiu(…),
  //   CS={session:e,refreshTools:Yh,refreshMcpClients:If,verbose:…}
  //   Qe??=ICy({...CS, tools:Yh, mcpClients:If, …})      // lazy branch
  //   ACy({...CS, …, tools:Pk, mcpClients:fM, …})        // eager branch
  //
  // So there are two initialisation sites, not one, and filtering only the
  // thunk would leave `--print`'s actual submission unfiltered. Pin the thunk
  // off the `{session:…,refreshTools:…}` object (one match), read `computeFn`
  // and `getterFn` out of its declaration, then find the eager declaration by
  // `computeFn` and confirm it against its own `tools:` use site.
  const csPattern =
    /\{session:[$\w]+,refreshTools:([$\w]+),refreshMcpClients:([$\w]+),verbose:/;
  const csMatch = oldFile.match(csPattern);
  // Method 2 (below) handles every build up to and including CC 2.1.237, where
  // `tools:` and `refreshTools:` still shared one object literal. Fall through
  // rather than failing, so this patch keeps working on the older shape.
  const escapeIdent = (name: string) => name.replace(/\$/g, '\\$');
  if (csMatch && csMatch.index !== undefined) {
    const thunkVar = csMatch[1];

    const thunkDecl = oldFile.match(
      new RegExp(
        `${escapeIdent(thunkVar)}=\\(\\)=>([$\\w]+)\\(([$\\w]+)\\(\\)\\)`
      )
    );
    if (!thunkDecl || thunkDecl.index === undefined) {
      console.error(
        'patch: toolsets: printToolsFilter: failed to find the print tools thunk'
      );
      return null;
    }
    const computeFn = thunkDecl[1];
    const getterFn = thunkDecl[2];

    // The filter, written as a self-contained parenthesised arrow EXPRESSION
    // rather than a `const` statement. Both splice sites are declarators inside a
    // `let` list (`let bu={…},Yh=()=>zs(l()),…` and `let Pk=zs(sH),a5=…`), so a
    // statement spliced in front of either one closes the list mid-declarator and
    // yields JS Bun cannot parse. They are also in different blocks, so a shared
    // binding declared at one site is not in scope at the other. An expression is
    // valid in every position and needs no scope analysis; the cost is repeating
    // the toolset table once, which is a few KB.
    const filterExpr =
      `((t,s)=>{const p=${toolsetsJSON},n=s.toolset??${fallback};` +
      `globalThis.__tweakcc_toolset={name:n,tools:p[n]};` +
      `if(p.hasOwnProperty(n)){const a=p[n];if(a==="*")return t;` +
      `return t.filter(d=>a.includes(d.name))}return t})`;

    // Site 1: the shared thunk. Covers `tools:` on the lazy branch AND
    // `refreshTools:` on both, because 2.1.238 passes one value to all of them.
    const thunkReplacement = `${thunkVar}=()=>{let s=${getterFn}();return ${filterExpr}(${computeFn}(s),s)}`;
    let newFile =
      oldFile.slice(0, thunkDecl.index) +
      thunkReplacement +
      oldFile.slice(thunkDecl.index + thunkDecl[0].length);

    showDiff(
      oldFile,
      newFile,
      thunkReplacement,
      thunkDecl.index,
      thunkDecl.index + thunkReplacement.length
    );

    // Site 2: the eager array the non-SDK branch submits. Identify it by its own
    // `tools:X,mcpClients:` use site so a same-shaped declaration elsewhere in
    // the bundle cannot be picked up by accident, then rewrite its declaration.
    const eagerUse = [
      ...newFile.matchAll(
        /tools:([$\w]+),mcpClients:([$\w]+),appendSystemPrompt:/g
      ),
    ]
      .map(m => m[1])
      .find(name => name !== thunkVar);
    if (eagerUse === undefined) {
      // Only the lazy branch exists in this build — the thunk covers everything.
      return newFile;
    }
    const eagerDecl = newFile.match(
      new RegExp(
        `${escapeIdent(eagerUse)}=${escapeIdent(computeFn)}\\(([$\\w]+)\\)`
      )
    );
    if (!eagerDecl || eagerDecl.index === undefined) {
      console.error(
        'patch: toolsets: printToolsFilter: failed to find print tools initialization'
      );
      return null;
    }
    const stateVar = eagerDecl[1];
    const eagerReplacement = `${eagerUse}=${filterExpr}(${computeFn}(${stateVar}),${stateVar})`;
    const beforeEager = newFile;
    newFile =
      newFile.slice(0, eagerDecl.index) +
      eagerReplacement +
      newFile.slice(eagerDecl.index + eagerDecl[0].length);

    showDiff(
      beforeEager,
      newFile,
      eagerReplacement,
      eagerDecl.index,
      eagerDecl.index + eagerReplacement.length
    );

    return newFile;
  }

  // ---------------------------------------------------------------------
  // Method 2 — CC <= 2.1.237: `tools:X,refreshTools:()=>F(G())` in one object.
  // ---------------------------------------------------------------------
  // Anchor on the USE site, not the declaration. `tools:X,refreshTools:()=>F(G())`
  // is a unique code shape; the declaration is not, so the old form matched
  // `let X=F(S)` and demanded the use within 2500 chars. CC 2.1.235 pushed them
  // 2,672 apart (MCP prewait code landed between) and the sub-patch silently
  // stopped matching. A declaration dominates its use, so once X and F are
  // pinned by the use site, the nearest preceding `let X=F(S)` is correct at any
  // distance and no window needs maintaining.
  const usePattern =
    /tools:([$\w]+),refreshTools:\(\)=>([$\w]+)\(([$\w]+)\(\)\)/;
  const useMatch = oldFile.match(usePattern);
  if (!useMatch || useMatch.index === undefined) {
    console.error(
      'patch: toolsets: printToolsFilter: failed to find print tools initialization'
    );
    return null;
  }

  const toolsVar = useMatch[1];
  const computeFn = useMatch[2];
  const getterFn = useMatch[3];

  // CC >=2.1.219 folded the declaration into a multi-declarator `let`, so the
  // statement can end on `,` instead of `;`: `let TOOLS=COMPUTE(STATE),NEXT=...`.
  const declPattern = new RegExp(
    `let ${escapeIdent(toolsVar)}=${escapeIdent(computeFn)}\\(([$\\w]+)\\)([;,])`,
    'g'
  );
  let declMatch: RegExpExecArray | null = null;
  for (
    let candidate = declPattern.exec(oldFile);
    candidate !== null;
    candidate = declPattern.exec(oldFile)
  ) {
    // Nearest declaration at or before the use; keep the first one after it only
    // as a fallback for a hoisted/closured shape.
    if (candidate.index < useMatch.index) declMatch = candidate;
    else {
      if (declMatch === null) declMatch = candidate;
      break;
    }
  }
  if (declMatch === null) {
    console.error(
      'patch: toolsets: printToolsFilter: failed to find print tools initialization'
    );
    return null;
  }

  const toolsMatch = declMatch;
  const stateVar = toolsMatch[1];
  const terminator = toolsMatch[2];

  // A `,` terminator means more declarators follow — reopen the `let` after the
  // injected statements so they keep their original binding form.
  const reopen = terminator === ',' ? 'let ' : '';
  const filterCode = `let ${toolsVar}=${computeFn}(${stateVar});const __tpts=${toolsetsJSON},__tptf=(t,s)=>{const n=s.toolset??${fallback};globalThis.__tweakcc_toolset={name:n,tools:__tpts[n]};if(__tpts.hasOwnProperty(n)){const a=__tpts[n];if(a==="*")return t;return t.filter(d=>a.includes(d.name))}return t};${toolsVar}=__tptf(${toolsVar},${stateVar});${reopen}`;

  let newFile =
    oldFile.slice(0, toolsMatch.index) +
    filterCode +
    oldFile.slice(toolsMatch.index + toolsMatch[0].length);

  showDiff(
    oldFile,
    newFile,
    filterCode,
    toolsMatch.index,
    toolsMatch.index + toolsMatch[0].length
  );

  const refreshPattern = new RegExp(
    `refreshTools:\\(\\)=>${computeFn.replace(/\$/g, '\\$')}\\(${getterFn.replace(/\$/g, '\\$')}\\(\\)\\)`
  );
  const refreshMatch = newFile.match(refreshPattern);
  if (!refreshMatch || refreshMatch.index === undefined) {
    console.error(
      'patch: toolsets: printToolsFilter: failed to find print refreshTools'
    );
    return null;
  }

  const refreshReplacement = `refreshTools:()=>{let s=${getterFn}();return __tptf(${computeFn}(s),s)}`;
  const beforeRefresh = newFile;
  newFile =
    newFile.slice(0, refreshMatch.index) +
    refreshReplacement +
    newFile.slice(refreshMatch.index + refreshMatch[0].length);

  showDiff(
    beforeRefresh,
    newFile,
    refreshReplacement,
    refreshMatch.index,
    refreshMatch.index + refreshMatch[0].length
  );

  return newFile;
};

/**
 * Sub-patch 2d: Replace "No such tool available" errors with toolset-aware messages.
 *
 * When a toolset is active and the model tries to call a filtered-out tool,
 * the generic "No such tool available: X" error wastes output context because
 * the model often tries alternative tools that are also unavailable.
 *
 * This patch replaces those errors with messages that list the available tools
 * and the active toolset, so the model knows what it CAN use.
 */
export const writeToolsetAwareErrors = (
  oldFile: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _toolsets: Toolset[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _defaultToolset: string | null
): string | null => {
  // Note: toolsets/defaultToolset params are unused — the helper reads from
  // globalThis.__tweakcc_toolset at runtime (set by writeComputeToolsFilter).

  // Replace the error template strings with toolset-aware versions.
  // CC <2.1.140 pattern: `<tool_use_error>Error: No such tool available: ${VARNAME}</tool_use_error>`
  // CC >=2.1.140 pattern: `<tool_use_error>Error: No such tool available: ${VARNAME}${HINT}</tool_use_error>`
  //   (second interpolation is an extra hint produced by a helper like $N6,
  //    e.g. ". <tool> exists but is not enabled in this context.")
  const errorPattern =
    /`<tool_use_error>Error: No such tool available: \$\{([$\w.]+)\}(?:\$\{([$\w.]+)\})?<\/tool_use_error>`/g;

  let newFile = oldFile;
  let matchCount = 0;

  // Helper reads from globalThis.__tweakcc_toolset (set by computeTools filter in sub-patch 2b)
  const helperName = '__tweakcc_toolErrorMsg';
  const helperFn =
    `function ${helperName}(toolName,hint){` +
    `hint=hint||"";` +
    `var info=globalThis.__tweakcc_toolset;` +
    `if(info&&info.tools&&info.tools!=="*"&&Array.isArray(info.tools)){` +
    `return "<tool_use_error>Error: No such tool available: "+toolName+hint+". The active toolset is '"+info.name+"' which only includes: "+info.tools.join(", ")+". Do not attempt to use "+toolName+" again — it will fail. If the user switches toolsets via /toolset, you may retry.</tool_use_error>"` +
    `}return "<tool_use_error>Error: No such tool available: "+toolName+hint+"</tool_use_error>"` +
    `};`;

  // Replace all error template literals with helper calls
  newFile = newFile.replace(errorPattern, (_match, varName, hintVar) => {
    matchCount++;
    return hintVar
      ? `${helperName}(${varName},${hintVar})`
      : `${helperName}(${varName})`;
  });

  if (matchCount === 0) {
    console.error(
      'patch: toolsets: toolsetAwareErrors: failed to find error pattern'
    );
    return null;
  }

  // Also replace the toolUseResult versions (without XML tags)
  const resultPattern =
    /`Error: No such tool available: \$\{([$\w.]+)\}(?:\$\{([$\w.]+)\})?`/g;
  newFile = newFile.replace(resultPattern, (_match, varName, hintVar) => {
    const call = hintVar
      ? `${helperName}(${varName},${hintVar})`
      : `${helperName}(${varName})`;
    return `${call}.replace(/<\\/?tool_use_error>/g,"")`;
  });

  // Inject the helper function at the top of the file (after the shebang/comments)
  const insertPoint = newFile.indexOf('\n', newFile.indexOf('// Version:'));
  if (insertPoint === -1) {
    console.error(
      'patch: toolsets: toolsetAwareErrors: failed to find insertion point for helper'
    );
    return null;
  }

  newFile =
    newFile.slice(0, insertPoint + 1) +
    helperFn +
    newFile.slice(insertPoint + 1);

  return newFile;
};

/**
 * Sub-patch 3: Add the toolset component definition
 */
export const writeToolsetComponentDefinition = (
  oldFile: string,
  toolsets: Toolset[],
  defaultToolset: string | null
): string | null => {
  const insertionPoint = findTopLevelPositionBeforeSlashCommand(oldFile);
  if (insertionPoint === null) {
    console.error(
      'patch: toolsets: failed to find slash command insertion point'
    );
    return null;
  }

  const reactVar = getReactVar(oldFile);
  if (!reactVar) {
    console.error('patch: toolsets: failed to find React variable');
    return null;
  }

  const boxComponent = findBoxComponent(oldFile);
  if (!boxComponent) {
    console.error('patch: toolsets: failed to find Box component');
    return null;
  }

  const textComponent = findTextComponent(oldFile);
  if (!textComponent) {
    console.error('patch: toolsets: failed to find Text component');
    return null;
  }

  const selectComponent = findSelectComponentName(oldFile);
  if (!selectComponent) {
    console.error('patch: toolsets: failed to find Select component');
    return null;
  }

  const dividerComponent = findDividerComponentName(oldFile);

  const stateInfo = getAppStateSelectorAndUseState(oldFile);
  if (!stateInfo) {
    console.error('patch: toolsets: failed to find app state getter');
    return null;
  }

  const chalkVar = findChalkVar(oldFile);
  if (!chalkVar) {
    console.error('patch: toolsets: failed to find chalk variable');
    return null;
  }

  const { appStateUseSelectorFn, appStateSetState } = stateInfo;

  // Generate toolset names array
  const toolsetNames = JSON.stringify(toolsets.map(ts => ts.name));

  // Generate select options
  const selectOptions = JSON.stringify(
    toolsets.map(ts => ({
      label: ts.name,
      value: ts.name,
      description:
        ts.allowedTools === '*'
          ? 'All tools'
          : ts.allowedTools.length === 0
            ? 'No tools'
            : `${ts.allowedTools.length} tool${ts.allowedTools.length !== 1 ? 's' : ''}: ${ts.allowedTools.join(', ')}`,
    }))
  );

  const fallback = defaultToolset
    ? JSON.stringify(defaultToolset)
    : 'undefined';

  // Generate the component code
  const componentCode = `const toolsetComp = ({ onExit, input }) => {
  const currentToolset = ${appStateUseSelectorFn}(state => state.toolset) ?? ${fallback};

  const setState = ${appStateSetState}();

  // Handle command-line argument
  if (input !== "" && input != null) {
    if (!${toolsetNames}.includes(input)) {
      onExit(${chalkVar}.red(\`\${${chalkVar}.bold(input)} is not a valid toolset. Valid toolsets: \` + ${JSON.stringify(
        toolsets.map(t => t.name).join(', ')
      )}));
      return;
    } else {
      setState(prev => ({ ...prev, toolset: input }));
      onExit(\`Toolset changed to \${${chalkVar}.bold(input)}\`);
      return;
    }
  }

  // Render interactive UI
  return ${reactVar}.createElement(
    ${boxComponent},
    { flexDirection: "column" },
    ${dividerComponent ? `${reactVar}.createElement(${dividerComponent}, { dividerColor: "permission" }),` : `${reactVar}.createElement(${textComponent}, { dimColor: true }, "─".repeat(40)),`}
    ${reactVar}.createElement(
      ${boxComponent},
      { paddingX: 1, marginBottom: 1, flexDirection: "column" },
      ${reactVar}.createElement(${boxComponent}, null,
        ${reactVar}.createElement(${textComponent}, { bold: true, color: "remember" }, "Select toolset")
      ),
      ${reactVar}.createElement(${boxComponent}, null,
        ${reactVar}.createElement(${textComponent}, { dimColor: true }, "A toolset is a collection of tools that Claude sees and is allowed to call.")
      ),
      ${reactVar}.createElement(${boxComponent}, { marginBottom: 1 },
        ${reactVar}.createElement(${textComponent}, { dimColor: true }, "Claude cannot call tools that are not included in the selected toolset.")
      ),
      ${reactVar}.createElement(${boxComponent}, null,
        ${reactVar}.createElement(${textComponent}, { color: "warning" }, "Note that Claude may hallucinate that it has access to tools outside of the toolset.")
      ),
      ${reactVar}.createElement(${boxComponent}, { marginBottom: 1 },
        ${reactVar}.createElement(${textComponent}, { dimColor: true }, "If so, explicitly remind it what its tool list is, or tell it to check it itself.")
      ),
      ${reactVar}.createElement(${boxComponent}, null,
        ${reactVar}.createElement(${textComponent}, { dimColor: true, bold: true }, "Toolsets are managed with tweakcc-fixed. "),
        ${reactVar}.createElement(${textComponent}, { dimColor: true }, "Run "),
        ${reactVar}.createElement(${textComponent}, { color: "permission" }, "npx tweakcc-fixed"),
        ${reactVar}.createElement(${textComponent}, { dimColor: true }, " to manage them.")
      ),
      ${reactVar}.createElement(${boxComponent}, { marginBottom: 1 },
        ${reactVar}.createElement(${textComponent}, { color: "permission" }, "https://github.com/skrabe/tweakcc-fixed")
      ),
      ${reactVar}.createElement(${boxComponent}, { marginBottom: 1 },
        ${reactVar}.createElement(${textComponent}, null, "Current toolset: "),
        ${reactVar}.createElement(${textComponent}, { bold: true }, currentToolset || "undefined")
      ),
      ${reactVar}.createElement(${boxComponent}, { marginBottom: 1 },
        ${reactVar}.createElement(${selectComponent}, {
          options: ${selectOptions},
          onChange: (input) => {
            setState(prev => ({ ...prev, toolset: input }));
            onExit(\`Toolset changed to \${${chalkVar}.bold(input)}\`);
          },
          onCancel: () => onExit(\`Toolset not changed (left as \${${chalkVar}.bold(currentToolset)})\`)
        })
      ),
      ${reactVar}.createElement(${textComponent}, { dimColor: true, italic: true }, "Enter to confirm · Esc to exit")
    )
  );
};`;

  const newFile =
    oldFile.slice(0, insertionPoint) +
    componentCode +
    oldFile.slice(insertionPoint);

  showDiff(oldFile, newFile, componentCode, insertionPoint, insertionPoint);

  return newFile;
};

// ============================================================================
// STATUS LINE COMPONENT (mode display + "? for shortcuts")
// ============================================================================

export interface StatusLineComponent {
  /** Minified name of the component function. */
  name: string;
  /** Name of the React-compiler memo cache array (`let bm=NS.c(143)`). */
  cacheVar: string;
  /** Index of the '{' that opens the component body. */
  braceIndex: number;
  /** Index just after that '{' — where `currentToolset` gets declared. */
  bodyStart: number;
  /** Index of the '}' that closes the component body. */
  bodyEnd: number;
}

// CC >=2.1.204 compiles the status line with the React compiler, so the
// component opens with its memo-cache allocation:
//   function ctl(LpI){let bm=wOn.c(143),{mode:MpI,...}=LpI,...
// The optional `currentToolset` prefix makes the locator idempotent: step 5
// injects there, and steps 6/7 must still be able to find the same component.
const compilerComponentHeader = () =>
  /function ([$\w]+)\([$\w]+\)\{(?:let currentToolset=[^;]*;)?let ([$\w]+)=[$\w]+\.c\(\d+\),/g;

// `Que(dne)," on",EWf` — the permission-mode label in the status line.
// CC 2.1.232 split the label into its own component and precomputes the mode
// name into a local first (`isc=Zme(B4t)` … `[osc,isc," on",T4h]`), so the
// call form is optional and a bare identifier must match too.
const modeLabelPattern = () => /([$\w]+(?:\([$\w]+\))?)," on"/g;

const SHORTCUTS_LABEL = '"? for shortcuts"';

/**
 * Locate the React-compiler-memoized status line component — the single
 * function body that renders BOTH the permission-mode label and the
 * "? for shortcuts" hint.
 *
 * Steps 5-7 must all act on this one component: step 5 declares
 * `currentToolset` in it, steps 6/7 read that binding. Injecting into a
 * different component than the readers live in is a ReferenceError at render
 * (CC 2.1.219 moved the shell-mode hint ~1.1 MB away into its own component,
 * which is exactly the trap the old bashBorder anchor fell into).
 */
/**
 * Every compiler-memoized component whose body contains `needle`.
 *
 * CC 2.1.232 broke the single-component assumption above: the permission-mode
 * label moved into its own `function JKi(props){...[osc,isc," on",T4h]...}` while
 * "? for shortcuts" stayed in the parent status line. Each component that reads
 * `currentToolset` therefore needs its own declaration, so step 5 injects into
 * all of them instead of one.
 */
export const findComponentsContaining = (
  file: string,
  needle: string
): StatusLineComponent[] => {
  const headers = Array.from(file.matchAll(compilerComponentHeader()));
  const out: StatusLineComponent[] = [];
  for (const site of matchAllIndexes(file, needle)) {
    let header: RegExpMatchArray | null = null;
    for (const h of headers) {
      if (h.index !== undefined && h.index < site) header = h;
      else break;
    }
    if (!header || header.index === undefined) continue;
    const braceIndex = header.index + header[0].indexOf('){') + 1;
    const bodyEnd = matchDelimiter(file, braceIndex);
    if (bodyEnd === null || site > bodyEnd) continue;
    if (out.some(c => c.braceIndex === braceIndex)) continue;
    out.push({
      name: header[1],
      cacheVar: header[2],
      braceIndex,
      bodyStart: braceIndex + 1,
      bodyEnd,
    });
  }
  return out;
};

const matchAllIndexes = (file: string, needle: string): number[] => {
  const out: number[] = [];
  let at = file.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = file.indexOf(needle, at + needle.length);
  }
  return out;
};

export const findStatusLineComponent = (
  file: string
): StatusLineComponent | null => {
  const headers = Array.from(file.matchAll(compilerComponentHeader()));
  if (headers.length === 0) return null;

  const build = (header: RegExpMatchArray): StatusLineComponent | null => {
    if (header.index === undefined) return null;
    const braceIndex = header.index + header[0].indexOf('){') + 1;
    const bodyEnd = matchDelimiter(file, braceIndex);
    if (bodyEnd === null) return null;
    return {
      name: header[1],
      cacheVar: header[2],
      braceIndex,
      bodyStart: braceIndex + 1,
      bodyEnd,
    };
  };

  // Once step 5 has run, the declaration itself is the definitive anchor —
  // steps 6/7 rewrite the mode label, which would otherwise destroy the
  // discovery anchor below and send step 7 off into another component.
  for (const header of headers) {
    if (!header[0].includes('let currentToolset=')) continue;
    const comp = build(header);
    if (comp) return comp;
  }

  const candidates: StatusLineComponent[] = [];
  for (const site of file.matchAll(modeLabelPattern())) {
    if (site.index === undefined) continue;

    let header: RegExpMatchArray | null = null;
    for (const h of headers) {
      if (h.index !== undefined && h.index < site.index) header = h;
      else break;
    }
    if (!header) continue;

    const comp = build(header);
    if (!comp || site.index > comp.bodyEnd) continue;
    if (candidates.some(c => c.braceIndex === comp.braceIndex)) continue;

    candidates.push(comp);
  }

  if (candidates.length === 0) return null;

  // Prefer the component that also owns the "? for shortcuts" hint — that is
  // the status line rather than any other mode-labelled surface.
  return (
    candidates.find(
      c => file.slice(c.bodyStart, c.bodyEnd).indexOf(SHORTCUTS_LABEL) !== -1
    ) ?? candidates[0]
  );
};

/**
 * The React compiler wraps most of the status line's JSX in memo guards:
 *   let xX;if(bm[35]!==dne||bm[36]!==EWf)xX=<jsx/>,bm[35]=dne,...;else xX=bm[38];
 * A guard that does not compare `currentToolset` would keep serving the
 * element built for the previous toolset, so /toolset would appear to do
 * nothing until an unrelated dep changed. The memo cache is a pure
 * optimisation, so widening the guard to always recompute is safe.
 *
 * Returns the index of the guard's closing ')' (where `||!0` gets spliced in),
 * or null when the site is not inside a cache guard (nothing to do).
 */
const findCacheGuardConditionEnd = (
  file: string,
  comp: StatusLineComponent,
  siteIndex: number
): number | null => {
  const ifIndex = file.lastIndexOf('if(', siteIndex);
  if (ifIndex < comp.bodyStart) return null;
  if (!file.startsWith(`${comp.cacheVar}[`, ifIndex + 3)) return null;
  const close = matchDelimiter(file, ifIndex + 2);
  if (close === null || close >= siteIndex) return null;
  return close;
};

interface Splice {
  start: number;
  end: number;
  text: string;
}

const applySplices = (file: string, splices: Splice[]): string => {
  let out = file;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }
  return out;
};

/**
 * Rewrite every occurrence of `label` inside the status line component,
 * widening the enclosing memo guard of each so the new text stays live.
 */
const rewriteStatusLineLabels = (
  oldFile: string,
  comp: StatusLineComponent,
  sites: { start: number; end: number; text: string }[]
): string | null => {
  if (sites.length === 0) return null;

  const splices: Splice[] = [];
  const guardsSeen = new Set<number>();
  for (const site of sites) {
    splices.push({ start: site.start, end: site.end, text: site.text });
    const guardEnd = findCacheGuardConditionEnd(oldFile, comp, site.start);
    if (guardEnd !== null && !guardsSeen.has(guardEnd)) {
      guardsSeen.add(guardEnd);
      splices.push({ start: guardEnd, end: guardEnd, text: '||!0' });
    }
  }

  const newFile = applySplices(oldFile, splices);
  const first = sites.reduce((a, b) => (a.start <= b.start ? a : b));
  showDiff(oldFile, newFile, first.text, first.start, first.end);
  return newFile;
};

/**
 * Find where to insert the app state variable getter in the statusline component
 */
export const findShiftTabAppStateVarInsertionPoint = (
  oldFile: string
): number | null => {
  // Search for the bash mode indicator.
  // CC <2.1.140 used "! for bash mode"; CC >=2.1.140 renamed it to "! for shell mode".
  const bashModePattern = /\{color:"bashBorder"\},"! for (?:bash|shell) mode"/;
  const match = oldFile.match(bashModePattern);

  if (!match || match.index === undefined) {
    console.error(
      'patch: toolsets: findShiftTabAppStateVarInsertionPoint: failed to find bash mode pattern'
    );
    return null;
  }

  // Get 10000 chars before the match
  // where earlier patches push the function declaration further away)
  const lookbackStart = Math.max(0, match.index - 10000);
  const chunk = oldFile.slice(lookbackStart, match.index);

  // Find the function declaration pattern - handles both:
  // - function NAME({...}){ (older CC, destructured params)
  // - function NAME(T){ (CC 2.1.20+, single param destructured in body)
  const functionPattern = /function ([$\w]+)\((?:\{[^}]+\}|[$\w]+)\)\{/g;
  const matches = Array.from(chunk.matchAll(functionPattern));

  if (matches.length === 0) {
    console.error(
      'patch: toolsets: findShiftTabAppStateVarInsertionPoint: failed to find function pattern'
    );
    return null;
  }

  // Take the last match (closest to the bash mode indicator)
  const lastMatch = matches[matches.length - 1];
  if (lastMatch.index === undefined) {
    console.error(
      'patch: toolsets: findShiftTabAppStateVarInsertionPoint: match has no index'
    );
    return null;
  }

  // Return position AFTER the opening brace
  return lookbackStart + lastMatch.index + lastMatch[0].length;
};

/**
 * Insert the state getter variable at the start of the statusline component
 * This is for appendToolsetToModeDisplay which injects `currentTool` but can't define it itself.
 */
export const insertShiftTabAppStateVar = (
  oldFile: string,
  defaultToolset: string | null
): string | null => {
  const stateInfo = getAppStateSelectorAndUseState(oldFile);
  if (!stateInfo) {
    console.error(
      'patch: toolsets: insertShiftTabAppStateVar: failed to find app state getter'
    );
    return null;
  }

  const { appStateUseSelectorFn } = stateInfo;
  const fallback = defaultToolset
    ? JSON.stringify(defaultToolset)
    : 'undefined';
  const codeToInsert = `let currentToolset=${appStateUseSelectorFn}(state => state.toolset) ?? ${fallback};`;

  // Method 1 (CC >=2.1.204): declare it at the top of every React-compiler
  // component steps 6/7 rewrite a label in. Up to CC 2.1.231 that was a single
  // component owning both labels; 2.1.232 split the mode label out, so injecting
  // into just one of them leaves the other reading an undeclared binding —
  // a ReferenceError at render, not a failed match.
  const comp = findStatusLineComponent(oldFile);
  const targets = [
    ...(comp ? [comp] : []),
    ...findComponentsContaining(oldFile, SHORTCUTS_LABEL),
  ];
  const seen = new Set<number>();
  const points = targets
    .filter(c =>
      seen.has(c.braceIndex) ? false : (seen.add(c.braceIndex), true)
    )
    .filter(c => !oldFile.startsWith('let currentToolset=', c.bodyStart))
    .map(c => c.bodyStart);

  if (targets.length > 0) {
    // Every target already carries the declaration — idempotent re-run.
    if (points.length === 0) return oldFile;
    const splices: Splice[] = points.map(at => ({
      start: at,
      end: at,
      text: codeToInsert,
    }));
    const newFile = applySplices(oldFile, splices);
    const first = Math.min(...points);
    showDiff(oldFile, newFile, codeToInsert, first, first);
    return newFile;
  }

  // Method 2 (CC <2.1.204): the statusline component was found by walking back
  // from the bash/shell mode hint, which used to live in the same component.
  const insertionPoint = findShiftTabAppStateVarInsertionPoint(oldFile);
  if (insertionPoint === null) {
    console.error(
      'patch: toolsets: insertShiftTabAppStateVar: failed to find insertion point'
    );
    return null;
  }

  const newFile =
    oldFile.slice(0, insertionPoint) +
    codeToInsert +
    oldFile.slice(insertionPoint);

  showDiff(oldFile, newFile, codeToInsert, insertionPoint, insertionPoint);

  return newFile;
};

/**
 * Append the toolset name to the mode display text
 */
export const appendToolsetToModeDisplay = (oldFile: string): string | null => {
  // Method 1 (CC >=2.1.204): the label lost its `.toLowerCase()` and is now
  // rendered from a memoized slot inside the status line component:
  //   Que(dne)," on",EWf]},"mode"):null,bm[35]=dne,...
  // Rewrite every mode label inside that component so the toolset shows in
  // both the normal and the dense layout variant.
  // Target the component that actually owns the label. Since CC 2.1.232 that is
  // not necessarily the one owning "? for shortcuts", and once step 5 has run
  // several components carry the `currentToolset` declaration, so selecting by
  // declaration alone picks the wrong body and finds no label to rewrite.
  // Prefer a label-owning component that already carries the declaration (after
  // step 5 several components do, and only this one owns the label), but fall
  // back to the first label owner so the step still works called on its own.
  if (oldFile.includes('currentToolset?` on [')) return oldFile;
  const labelComps = findComponentsContaining(oldFile, '," on"');
  const comp =
    labelComps.find(c =>
      oldFile.startsWith('let currentToolset=', c.bodyStart)
    ) ?? labelComps[0];
  if (comp) {
    const body = oldFile.slice(comp.bodyStart, comp.bodyEnd);
    if (body.includes('currentToolset?` on [')) return oldFile;
    const sites = Array.from(body.matchAll(modeLabelPattern()))
      .filter(m => m.index !== undefined)
      .map(m => {
        const start = comp.bodyStart + (m.index as number);
        return {
          start,
          end: start + m[0].length,
          text: `${m[1]},currentToolset?\` on [\${currentToolset}]\`:" on"`,
        };
      });
    const patched = rewriteStatusLineLabels(oldFile, comp, sites);
    if (patched) return patched;
  }

  // Method 2 (CC <2.1.204): the mode name was lower-cased inline.
  // Find the pattern where mode text is rendered
  // Looking for: tl(Y).toLowerCase(), " on"
  // We want to change it to: tl(Y).toLowerCase(), " on: ", currentToolset || "undefined"

  const modeDisplayPattern = /([$\w]+)\(([$\w]+)\)\.toLowerCase\(\)," on"/;
  const match = oldFile.match(modeDisplayPattern);

  if (!match || match.index === undefined) {
    console.error(
      'patch: toolsets: appendToolsetToModeDisplay: failed to find mode display pattern'
    );
    return null;
  }

  const tlFunction = match[1];
  const modeVar = match[2];

  // Replace with the new pattern that includes toolset
  const oldText = match[0];
  // insertShiftTabAppStateVar provides the definition for currentToolset.
  const newText = `${tlFunction}(${modeVar}).toLowerCase(),currentToolset?\` on [\${currentToolset}]\`:""`;

  // Splice by index: String.replace would reinterpret '$' sequences in both the
  // needle and the replacement, and minified identifiers routinely contain '$'.
  const newFile =
    oldFile.slice(0, match.index) +
    newText +
    oldFile.slice(match.index + oldText.length);

  showDiff(
    oldFile,
    newFile,
    newText,
    match.index,
    match.index + oldText.length
  );

  return newFile;
};

/**
 * Append the toolset name to the "? for shortcuts" display
 */
export const appendToolsetToShortcutsDisplay = (
  oldFile: string
): string | null => {
  // Method 1 (CC >=2.1.204): "? for shortcuts" occurs in several unrelated
  // components (the REPL footer, the transcript footer, ...). Only the ones
  // inside the status line component may reference `currentToolset`; rewriting
  // the last occurrence in the file — as Method 2 does — lands ~2.9 MB away in
  // a component where that binding does not exist (ReferenceError at render).
  // The hint may live in a different component from the mode label (CC 2.1.232
  // split them), so target every component that owns it — step 5 declared
  // `currentToolset` in each of those same components.
  const hintComps = findComponentsContaining(oldFile, SHORTCUTS_LABEL);
  const declared = hintComps.filter(c =>
    oldFile.startsWith('let currentToolset=', c.bodyStart)
  );
  // After step 5 only the components that will read `currentToolset` carry the
  // declaration, so restrict to those. Called standalone (no step 5 yet) nothing
  // carries it, and every hint owner is a candidate.
  const statusLine = hintComps.length ? findStatusLineComponent(oldFile) : null;
  const comps = declared.length
    ? declared
    : statusLine
      ? hintComps.filter(c => c.braceIndex === statusLine.braceIndex)
      : [];
  let result = oldFile;
  let rewroteAny = false;
  for (const comp of comps) {
    const body = result.slice(comp.bodyStart, comp.bodyEnd);
    if (body.includes('currentToolset?`? for shortcuts [')) {
      rewroteAny = true;
      continue;
    }
    const sites: { start: number; end: number; text: string }[] = [];
    let at = body.indexOf(SHORTCUTS_LABEL);
    while (at !== -1) {
      const start = comp.bodyStart + at;
      sites.push({
        start,
        end: start + SHORTCUTS_LABEL.length,
        text: `currentToolset?\`? for shortcuts [\${currentToolset}]\`:${SHORTCUTS_LABEL}`,
      });
      at = body.indexOf(SHORTCUTS_LABEL, at + SHORTCUTS_LABEL.length);
    }
    const patched = rewriteStatusLineLabels(result, comp, sites);
    if (patched) {
      // Each rewrite shifts later offsets, so re-derive the remaining
      // components against the updated file rather than reusing stale ranges.
      result = patched;
      rewroteAny = true;
      return appendToolsetToShortcutsDisplay(result);
    }
  }
  if (rewroteAny) return result;

  // Method 2 (CC <2.1.204): a single statusline component owned the hint.
  const shortcutsPattern = /"\? for shortcuts"/g;
  const matches = Array.from(oldFile.matchAll(shortcutsPattern));

  // Use the last match (there are two in 2.0.37, 1 in .41).
  const match = matches.at(-1);
  if (!match || match.index === undefined) {
    console.error(
      "patch: toolsets: appendToolsetToShortcutsDisplay: could not find '? for shortcuts'"
    );
    return null;
  }

  // Replace with the new pattern that includes toolset
  const oldText = match[0];
  const newText = `currentToolset?\`? for shortcuts [\${currentToolset}]\`:"? for shortcuts"`;

  // Splice by index: String.replace with a string needle rewrites the FIRST
  // occurrence, not the last one this method deliberately selected.
  const newFile =
    oldFile.slice(0, match.index) +
    newText +
    oldFile.slice(match.index + oldText.length);

  showDiff(
    oldFile,
    newFile,
    newText,
    match.index,
    match.index + oldText.length
  );

  return newFile;
};

/**
 * Sub-patch 4: Add the slash command definition
 */
export const writeSlashCommandDefinition = (oldFile: string): string | null => {
  const reactVar = getReactVar(oldFile);
  if (!reactVar) {
    console.error('patch: toolsets: failed to find React variable');
    return null;
  }

  // Generate the slash command definition
  const commandDef = `, {
  aliases: ["change-tools"],
  type: "local-jsx",
  name: "toolset",
  description: "Select a toolset (managed by tweakcc)",
  argumentHint: "[toolset-name]",
  isEnabled: () => true,
  isHidden: false,
  load: () => Promise.resolve().then(() => ({call: (onExit, ctx, input) => {
    return ${reactVar}.createElement(toolsetComp, { onExit, input });
  }})),
  userFacingName() {
    return "toolset";
  }
}`;

  // Use the imported function to write the command definition
  return writeSlashCommandDefinitionToArray(oldFile, commandDef);
};

// ============================================================================
// MODE CHANGE TOOLSET FUNCTIONS
// ============================================================================

/**
 * Find the tool change component scope
 * Pattern: X(Y,function(Z){W("tengu_ext_at_mentioned",{});
 * CC >=2.1.219 folded the following statement into a sequence expression, so
 * the call can be terminated by ',' instead of ';':
 *   Wai(I,function(Wt){M("tengu_ext_at_mentioned",{}),eQ(Gai(Wt,te[xe-1]))});
 * Returns the start index
 */
export const findToolChangeComponentScope = (
  fileContents: string
): number | null => {
  const pattern =
    /[\w$]+\([\w$]+,function\([\w$]+\)\{[\w$]+\("tengu_ext_at_mentioned",\{\}\)[;,]/;
  const match = fileContents.match(pattern);

  if (!match || match.index === undefined) {
    console.error(
      'patch: findToolChangeComponentScope: failed to find tool change component scope'
    );
    return null;
  }

  return match.index;
};

/**
 * Add setState function access at the tool change component scope
 * So that writeModeChangeUpdateToolset can use them.
 */
export const addCurrentToolsetAtToolChangeComponentScope = (
  oldFile: string,
  defaultToolset: string | null
): string | null => {
  const scopeIndex = findToolChangeComponentScope(oldFile);
  if (scopeIndex === null) {
    return null;
  }

  const stateInfo = getAppStateSelectorAndUseState(oldFile);
  if (!stateInfo) {
    console.error(
      'patch: addCurrentToolsetAtToolChangeComponentScope: failed to get app state getter function'
    );
    return null;
  }

  const { appStateUseSelectorFn } = stateInfo;
  const fallback = defaultToolset
    ? JSON.stringify(defaultToolset)
    : 'undefined';

  // Inject the currentToolset access right at the start of the component scope
  const injectionCode = `const currentToolset = ${appStateUseSelectorFn}(state => state.toolset) ?? ${fallback};`;

  const newFile =
    oldFile.slice(0, scopeIndex) + injectionCode + oldFile.slice(scopeIndex);

  showDiff(oldFile, newFile, injectionCode, scopeIndex, scopeIndex);

  return newFile;
};

/**
 * Find the mode change location in the code
 * Pattern: if(X==="acceptEdits")Y("auto-accept-mode");...mode:Z
 * Returns the index after the semicolon (insertion point) and the mode variable
 */
export const findModeChange = (
  fileContents: string
): { index: number; modeVar: string; setStateVar: string } | null => {
  // Method 1 (CC 2.1.233+): the mode change moved out of an inline `if(...)`
  // into a validated setter, so there is no leading `if(` to anchor on any more:
  //
  //   return r((o)=>{let i=o.toolPermissionContext.mode;if(i===e)return o;
  //     let s=lje(i,e,o.toolPermissionContext);
  //     return{...o,toolPermissionContext:{...s,mode:e}}}),setImmediate(...),{ok:!0}
  //
  // `r` is the setState and `e` the requested mode. Everything before this
  // `return` has already rejected an unavailable mode, so injecting there runs
  // only for a mode change that is actually going to happen.
  const setterPattern =
    /return ([$\w]+)\(\([$\w]+\)=>\{let ([$\w]+)=[$\w]+\.toolPermissionContext\.mode;if\(\2===([$\w]+)\)return [$\w]+;let ([$\w]+)=[$\w]+\(\2,\3,[$\w]+\.toolPermissionContext\);return\{\.\.\.[$\w]+,toolPermissionContext:\{\.\.\.\4,mode:\3\}\}\}\)/;
  const setterMatch = fileContents.match(setterPattern);
  if (setterMatch && setterMatch.index !== undefined) {
    return {
      index: setterMatch.index,
      modeVar: setterMatch[3],
      setStateVar: setterMatch[1],
    };
  }

  // Method 2 (CC <=2.1.232): the mode change was the condition of an `if`.
  const pattern =
    /if\(([$\w]+)\(\([$\w]+\)=>\(\{\.\.\.[$\w]+,toolPermissionContext.{0,200}?mode:([$\w]+)/;
  const match = fileContents.match(pattern);

  if (!match || match.index === undefined) {
    console.error('patch: findModeChange: failed to find mode change location');
    return null;
  }

  return {
    index: match.index,
    modeVar: match[2],
    // We can't get a setState ourselves because it's a hook that gets it and this code is not in
    // the top-level component.But there's already an instantiation 600+ lines back (as of 2.1.31,
    // and it's `h1 = h7()`), but even simpler, in newer versions they use in like the next line.
    setStateVar: match[1],
  };
};

/**
 * Write the mode change toolset update code
 * This injects code before the mode change to automatically switch toolsets
 */
export const writeModeChangeUpdateToolset = (
  oldFile: string,
  planModeToolset: string,
  defaultToolset: string
): string | null => {
  const modeChangeResult = findModeChange(oldFile);
  if (!modeChangeResult) {
    return null;
  }

  const { index: modeChangeIndex, modeVar, setStateVar } = modeChangeResult;

  // Build the injection code using setState directly
  const injectionCode = `if(${modeVar}==="plan"){${setStateVar}((prev)=>({...prev,toolset:${JSON.stringify(planModeToolset)}}));}else{${setStateVar}((prev)=>({...prev,toolset:${JSON.stringify(defaultToolset)}}));}`;

  // Inject right before the mode change
  const newFile =
    oldFile.slice(0, modeChangeIndex) +
    injectionCode +
    oldFile.slice(modeChangeIndex);

  showDiff(oldFile, newFile, injectionCode, modeChangeIndex, modeChangeIndex);

  return newFile;
};

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

/**
 * Apply all toolset patches to the file
 * @param oldFile - The file content to patch
 * @param toolsets - Array of toolset configurations
 * @param defaultToolset - The default toolset name (or null)
 * @param planModeToolset - Optional toolset to switch to when entering plan mode
 */
export const writeToolsets = (
  oldFile: string,
  toolsets: Toolset[],
  defaultToolset: string | null,
  planModeToolset?: string | null
): string | null => {
  // Return if no toolsets are configured
  if (!toolsets || toolsets.length === 0) {
    return oldFile;
  }

  let result: string | null = oldFile;

  // Step 1: Add toolset field to app state
  result = writeToolsetFieldToAppState(result, defaultToolset);
  if (!result) {
    console.error(
      'patch: toolsets: step 1 failed (writeToolsetFieldToAppState)'
    );
    return null;
  }

  // Step 2: Modify tool fetching useMemo
  result = writeToolFetchingUseMemo(result, toolsets, defaultToolset);
  if (!result) {
    console.error('patch: toolsets: step 2 failed (writeToolFetchingUseMemo)');
    return null;
  }

  // Step 2b: Patch computeTools() to filter API-bound tools
  result = writeComputeToolsFilter(result, toolsets, defaultToolset);
  if (!result) {
    console.error('patch: toolsets: step 2b failed (writeComputeToolsFilter)');
    return null;
  }

  // Step 2c: Patch the non-interactive --print tool context
  result = writePrintToolsFilter(result, toolsets, defaultToolset);
  if (!result) {
    console.error('patch: toolsets: step 2c failed (writePrintToolsFilter)');
    return null;
  }

  // Step 2d: Patch "No such tool available" error messages to be toolset-aware
  const result2d = writeToolsetAwareErrors(result, toolsets, defaultToolset);
  if (!result2d) {
    console.error(
      'patch: toolsets: step 2d failed (writeToolsetAwareErrors) — continuing without friendlier errors'
    );
  } else {
    result = result2d;
  }

  // Step 3: Add toolset component definition
  result = writeToolsetComponentDefinition(result, toolsets, defaultToolset);
  if (!result) {
    console.error(
      'patch: toolsets: step 3 failed (writeToolsetComponentDefinition)'
    );
    return null;
  }

  // Step 4: Add slash command definition
  result = writeSlashCommandDefinition(result);
  if (!result) {
    console.error(
      'patch: toolsets: step 4 failed (writeSlashCommandDefinition)'
    );
    return null;
  }

  // Step 5: Insert state getter in statusline component
  result = insertShiftTabAppStateVar(result, defaultToolset);
  if (!result) {
    console.error('patch: toolsets: step 5 failed (insertShiftTabAppStateVar)');
    return null;
  }

  // Step 6: Append toolset name to mode display
  result = appendToolsetToModeDisplay(result);
  if (!result) {
    console.error(
      'patch: toolsets: step 6 failed (appendToolsetToModeDisplay)'
    );
    return null;
  }

  // Step 7: Append toolset name to shortcuts display
  result = appendToolsetToShortcutsDisplay(result);
  if (!result) {
    console.error(
      'patch: toolsets: step 7 failed (appendToolsetToShortcutsDisplay)'
    );
    return null;
  }

  // Step 8: Mode-change toolset switching (optional)
  if (planModeToolset && defaultToolset) {
    // First, add setState access at the tool change component scope
    result = addCurrentToolsetAtToolChangeComponentScope(
      result,
      defaultToolset
    );
    if (!result) {
      console.error(
        'patch: toolsets: step 8a failed (addCurrentToolsetAtToolChangeComponentScope)'
      );
      return null;
    }

    // Then, inject the mode change toolset switching code
    result = writeModeChangeUpdateToolset(
      result,
      planModeToolset,
      defaultToolset
    );
    if (!result) {
      console.error(
        'patch: toolsets: step 8b failed (writeModeChangeUpdateToolset)'
      );
      return null;
    }
  }

  return result;
};
