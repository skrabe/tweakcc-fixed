// Patch: Add ignore_whitespace support to the edit tool in Claude Code.
// Works across versions by anchoring on stable structural strings rather than
// minified identifiers (function names, variable names) that change between releases.

import { LocationResult, showDiff } from './index';

/** Regex anchor — matches the run function signature regardless of variable names used. */
const BODY_START_RE =
  /run:async\(\{file_path:([a-zA-Z_$]+),old_string:([a-zA-Z_$]+),new_string:([a-zA-Z_$]+),replace_all:([a-zA-Z_$]+)\}\)=>/;

/** Regex anchor — matches the error message regardless of variable names used. */
const MID_BODY_RE =
  /`edit: old_string appears \$\{[a-zA-Z_$]+\} times in \$\{[a-zA-Z_$]+\} \(must be unique\)`/;

// Regex anchors that tolerate optional newlines between key structural parts, so patches survive
// prior injections that may have added blank lines at the same file positions. The replacement text
// itself is always injected verbatim (no blank lines) — we only relax matching, not output.

/** Step 1 anchor: matches `replace_all:{type:"boolean"}}}` before `required:[...]` allowing an optional comma and whitespace/newlines between them. */
const SCHEMA_RE =
  /replace_all:\{type:"boolean"\}\},?\s*required:\["file_path","old_string","new_string"\]}/;

/** Captured identifiers from a single scan of the edit tool body. */
interface VarNames {
  // Original minified variable names (for matching existing code)
  fp: string; // file_path param
  os: string; // old_string param
  ns: string; // new_string param
  ra: string; // replace_all param
  content: string; // local var holding file content (e.g. "s")
  count: string; // local count variable (e.g. "a")
  result: string; // local result variable (e.g. "l")
  errClass: string; // error class constructor (e.g. "cS")

  /** Safe single-letter variable for ignore_whitespace flag */
  wsFlag: string;
  /** Safe single-letter variable for arrow function params (avoids masking outer vars) */
  lambdaParam: string;
}

// ============================================================================
// Location helpers — find edit tool boundaries by stable structural anchors
// ============================================================================

export const getEditToolLocation = (oldFile: string): LocationResult | null => {
  // Find the start of the edit tool's run function body using flexible regex.
  const bodyMatch = oldFile.match(BODY_START_RE);
  if (!bodyMatch || bodyMatch.index === undefined) return null;

  // Walk backward to find the `function <name>(e){` start of this tool.
  let searchFrom = Math.max(0, bodyMatch.index - 250);
  const prevBoundary = oldFile.lastIndexOf(
    '}})}function',
    bodyMatch.index - 10
  );
  if (prevBoundary !== -1) {
    searchFrom = prevBoundary + '}})}function'.length;
  }

  const funcDefMatch = oldFile
    .substring(searchFrom)
    .match(/([a-zA-Z_$][\w$]*)\(e\)\{return\s+[a-zA-Z_$][\w$]*/);
  if (!funcDefMatch) {
    console.error(
      'patch: ignoreWhitespaceEdit: failed to find edit tool function definition'
    );
    return null;
  }

  const funcName = funcDefMatch[1];
  const actualStart = searchFrom + (funcDefMatch.index || 0);

  // Find the end boundary: next }})}function after MID_BODY (next tool)
  const midMatch = oldFile.match(MID_BODY_RE);
  if (!midMatch || midMatch.index === undefined) {
    console.error(
      'patch: ignoreWhitespaceEdit: failed to find mid-body anchor'
    );
    return null;
  }

  const endSearchFrom = Math.max(
    midMatch.index + midMatch[0].length,
    bodyMatch.index + bodyMatch[0].length
  );
  const nextBoundary = oldFile.indexOf('}})}function', endSearchFrom);
  if (nextBoundary === -1) {
    console.error(
      'patch: ignoreWhitespaceEdit: failed to find edit tool end boundary'
    );
    return null;
  }

  return {
    startIndex: actualStart,
    endIndex: nextBoundary + '}})}function'.length,
    identifiers: [funcName],
  };
};

// ============================================================================
// Core patching logic — step-by-step replacements within the edit tool body.
// First pass extracts variable names; subsequent passes reuse them.
// ============================================================================

export const writeIgnoreWhitespaceEdit = (oldFile: string): string | null => {
  // 1. Find the edit tool boundaries dynamically using stable strings
  const location = getEditToolLocation(oldFile);
  if (!location) return null;

  const funcStart = location.startIndex;
  const funcEndIdx = location.endIndex;
  let funcContent = oldFile.slice(funcStart, funcEndIdx);

  // Check if we've already patched this — look for our specific marker
  if (funcContent.includes('additionalProperties:{ignore_whitespace')) {
    console.log('patch: ignoreWhitespaceEdit: already patched, skipping');
    return null;
  }

  const _funcName = location.identifiers?.[0] ?? 'edit';
  void _funcName; // suppress unused warning — used by showDiff caller

  // -----------------------------------------------------------------------
  // Extract variable names from the original code via single-pass regex.
  // This captures whatever minifier chose — no hardcoded assumptions.
  // -----------------------------------------------------------------------
  const vars = captureVarNames(funcContent);
  if (!vars) {
    // Debug: show what's available in funcContent for matching
    const debugDestructure = funcContent.match(BODY_START_RE);
    if (debugDestructure) {
      const os2 = debugDestructure[2];
      // Try count regex as written in code
      const testCountRe = new RegExp(
        `let ([a-zA-Z_$]+)=([a-zA-Z_])\\.split\\(${os2}\\)\\.length-1`
      );
      console.log(
        'patch: ignoreWhitespaceEdit: FUNC LENGTH=' +
          funcContent.length +
          ', destructure match: ' +
          debugDestructure[1]
      );
      const testCM = funcContent.match(testCountRe);
      if (testCM) {
        console.log(
          'patch: ignoreWhitespaceEdit: count pattern found:',
          testCM[0].substring(0, 60)
        );
      } else {
        // Show snippet around offset 850-950 (where count pattern should be)
        const midSnippet = funcContent.substring(
          Math.max(0, 800),
          Math.min(funcContent.length, 1000)
        );
        console.log(
          'patch: ignoreWhitespaceEdit: mid snippet:',
          JSON.stringify(midSnippet)
        );
      }
    }

    console.error(
      'patch: ignoreWhitespaceEdit: failed to extract variable names'
    );
    return null;
  }
  console.log(
    'patch: ignoreWhitespaceEdit: captured vars: fp=' +
      vars.fp +
      ' os=' +
      vars.os +
      ' ns=' +
      vars.ns +
      ' ra=' +
      vars.ra +
      ' content=' +
      vars.content +
      ' count=' +
      vars.count +
      ' result=' +
      vars.result +
      ' errClass=' +
      vars.errClass
  );

  // -----------------------------------------------------------------------
  // Normalize whitespace for anchor matching. Build a lookup table mapping
  // normalized character positions back to original byte offsets, so regexes
  // run on clean text (no blank lines, \r\n trimmed) but replacements land at
  // the correct positions in funcContent regardless of spacing changes.
  // -----------------------------------------------------------------------

  interface NormLine {
    origStart: number; // byte offset where this line starts in original funcContent
    origEnd: number; // byte offset where this line ends (exclusive) — exclusive handles \r\n or trailing spaces
    trimmedLen: number; // length of the whitespace-trimmed version used in normalized text
  }

  const rawLines = funcContent.split('\n');
  const normLines: NormLine[] = [];
  let cursor = 0;

  for (const line of rawLines) {
    const trimmedLen = line.trim().length;
    if (trimmedLen > 0) {
      normLines.push({
        origStart: cursor,
        origEnd: cursor + line.length,
        trimmedLen,
      });
    }
    cursor += line.length + 1; // +1 for the \n we split on
  }

  const normalizedFunc = normLines
    .map(l => funcContent.substring(l.origStart, l.origEnd).trim())
    .join('\n');
  /** "Normalized-aware" search: find matchText (from normalizedFunc) inside funcContent by skipping \n and spaces. Returns byte offset or -1. */
  function findNormalizedMatch(
    haystack: string,
    _needleNorm: string,
    needleStartInNorm: number,
    matchText: string
  ): number {
    // Walk through funcContent looking for matchText while skipping collapsed whitespace (\n + spaces from blank-line collapse)
    for (let i = 0; i <= haystack.length - matchText.length; i++) {
      let mi = 0; // index into matchText
      let hi = i; // index into haystack
      while (mi < matchText.length) {
        const hc = haystack[hi];
        if (!hc) return -1; // ran out of haystack
        if (hc === matchText[mi]) {
          mi++;
          hi++;
        } else if (hc === '\n' || hc === ' ') {
          hi++; // skip collapsed whitespace
        } else {
          break; // mismatch on a real character
        }
      }
      if (mi === matchText.length) return i;
    }
    return -1;
  }

  /** Apply a replacement: find match in normalized text, map to original byte offsets, replace there. Handles both RegExp and string patterns. */
  function applyNormalizedReplace(
    pattern: RegExp | string,
    replacement: string | ((...args: string[]) => string)
  ): boolean {
    let re: RegExp;
    if (typeof pattern === 'string') {
      // Escape regex special chars for literal string matching
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(escaped);
    } else {
      re = pattern;
    }

    const m = re.exec(normalizedFunc);
    if (!m || m.index === undefined) return false;

    const matchText = m[0];
    const normStart = m.index;
    void normStart; // used for debugging / future position-mapping

    // Try indexOf first — works when match is on a single original line (no collapsed newlines inside it).
    // This handles the common case cleanly without position-mapping overhead.
    let origIdx = funcContent.indexOf(matchText);

    // Fallback: "normalized-aware" search that skips \n and spaces in funcContent to find
    // text split across lines by collapsed blank-line injections. Walks char-by-char, comparing
    // matchText[i] against funcContent[j] where j advances through funcContent but i only advances
    // on successful character matches (newlines/spaces are skipped).
    if (origIdx < 0) {
      origIdx = findNormalizedMatch(
        funcContent,
        normalizedFunc,
        normStart,
        matchText
      );
    }

    if (origIdx < 0) {
      console.error(
        'Step failed: could not locate normalized match in original text'
      );
      return false;
    }

    let replStr: string;
    if (typeof replacement === 'function') {
      replStr = replacement(...m.slice(1));
    } else {
      replStr = replacement as string;
    }

    funcContent =
      funcContent.substring(0, origIdx) +
      replStr +
      funcContent.substring(origIdx + matchText.length);
    return true;
  }
  // -----------------------------------------------------------------------
  // Step 1: Add ignore_whitespace to input schema properties and description.
  // Uses normalized text matching so blank-line injections don't break anchors.
  // Replacement lands at exact original byte offsets regardless of whitespace.
  // -----------------------------------------------------------------------
  const step1Replacement =
    'replace_all:{type:"boolean"}},additionalProperties:{ignore_whitespace:{type:"boolean",description:"Trim leading/trailing whitespace from each line in old_string and new_string before matching."}},required:["file_path","old_string","new_string"]}';

  if (!applyNormalizedReplace(SCHEMA_RE, step1Replacement)) {
    console.error('Step 1 failed: schema anchor not found');
    return null;
  }

  // Step 1b: Update the hardcoded edit tool description text so the LLM sees it prominently.
  const step1bDescription =
    'Replace old_string with new_string in a file. old_string must be unique unless replace_all. (Optionally set ignore_whitespace to trim leading/trailing whitespace from each line in old_string and new_string before matching.)';

  // Replace description text, preserving whatever follows it (whitespace/newlines) via capture
  const step1bRe =
    /Replace old_string with new_string in a file\. old_string must be unique unless replace_all\.\s*/;
  if (!applyNormalizedReplace(step1bRe, step1bDescription)) {
    console.error('Step 1b failed: tool description anchor not found');
    return null;
  }

  // -----------------------------------------------------------------------
  // Step 2: Add ignore_whitespace parameter to the run function signature.
  // Uses normalized text matching so blank-line injections don't break anchors.
  // Word boundary (?<![a-zA-Z_$]) prevents cross-line false matches (e.g., "xrun:async..." from line-end + line-start).
  // -----------------------------------------------------------------------

  // Check exact variable names first, then fall back to flexible pattern
  const step2ExactRe = new RegExp(
    `(?<![a-zA-Z_$])run:async\\(\\{file_path:${vars.fp},old_string:${vars.os},new_string:${vars.ns},replace_all:${vars.ra}\\}\\)=>`
  );

  if (
    applyNormalizedReplace(
      step2ExactRe,
      `run:async({file_path:${vars.fp},old_string:${vars.os},new_string:${vars.ns},replace_all:${vars.ra},ignore_whitespace:${vars.wsFlag}=false})=>`
    )
  ) {
    // applied via normalized replace above
  } else {
    // Flexible fallback: matches any variable names in the destructuring (with word boundary guard)
    const step2FlexRe =
      /(?<![a-zA-Z_$])run:async\(\{file_path:[a-zA-Z_$]+,old_string:[a-zA-Z_$]+,new_string:[a-zA-Z_$]+,replace_all:[a-zA-Z_$]+\}\)=>/;
    if (step2FlexRe.test(normalizedFunc)) {
      applyNormalizedReplace(
        step2FlexRe,
        `run:async({file_path:${vars.fp},old_string:${vars.os},new_string:${vars.ns},replace_all:${vars.ra},ignore_whitespace:${vars.wsFlag}=false})=>`
      );
    } else {
      console.error(
        'patch: ignoreWhitespaceEdit: Step 2 failed — parameter pattern not found'
      );
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Step 3: Modify the replacement-count logic to handle ignore_whitespace.
  // Original: `let a=s.split(r).length-1;if(a===0)throw new cS(\`edit...\`);`
  // Where: a=count, r=os, s=file content, cS=errClass, t=fp (template string var), wsFlag=ignore_ws flag
  // -----------------------------------------------------------------------
  const step3Exact = `let ${vars.count}=${vars.content}.split(${vars.os}).length-1;if(${vars.count}===0)throw new ${vars.errClass}(\`edit: old_string not found in \${${vars.fp}}\`);`;

  if (funcContent.includes(step3Exact)) {
    const lp = vars.lambdaParam;
    const step3Replacement = `let ${vars.count}=${vars.wsFlag}?${vars.content}.split(String.fromCharCode(10)).map((${lp})=>${lp}.trim()).join(String.fromCharCode(10)).split(${vars.wsFlag}?${vars.os}.split(String.fromCharCode(10)).map(${lp}=>${lp}.trim()).join(String.fromCharCode(10)):${vars.os}).length-1:${vars.content}.split(${vars.os}).length-1;if(${vars.count}===0)throw new ${vars.errClass}(\`edit: old_string not found in \${${vars.fp}}\`);`;
    funcContent = funcContent.replace(step3Exact, step3Replacement);
  } else {
    // Flexible fallback: match any variable/error-class names (word boundary guard prevents cross-line collision)
    const step3FlexRe = new RegExp(
      `(?<![a-zA-Z_$])let ${vars.count}=[a-zA-Z_]\\.split\\([a-zA-Z_$]+\\)\\.length-1;if\\(${vars.count}===0\\)throw new [a-zA-Z_$]+`
    );
    if (step3FlexRe.test(funcContent)) {
      const lp = vars.lambdaParam;
      const step3Replacement = `let ${vars.count}=${vars.wsFlag}?${vars.content}.split(String.fromCharCode(10)).map((${lp})=>${lp}.trim()).join(String.fromCharCode(10)).split(${vars.wsFlag}?${vars.os}.split(String.fromCharCode(10)).map(${lp}=>${lp}.trim()).join(String.fromCharCode(10)):${vars.os}).length-1:${vars.content}.split(${vars.os}).length-1;if(${vars.count}===0)throw new ${vars.errClass}(\`edit: old_string not found in \${${vars.fp}}\`);`;
      funcContent = funcContent.replace(step3FlexRe, step3Replacement);
    } else {
      console.error(
        'patch: ignoreWhitespaceEdit: Step 3 failed — count pattern not found'
      );
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Step 4: Modify the join/replace logic for replace_all and single-match cases.
  // Original: `let l;if(o)l=s.split(r).join(n);else{if(a>1)throw new cS(...`
  // Where: l=result, o=ra, s=os (content), r=os (pattern), n=ns (replacement)
  // -----------------------------------------------------------------------
  const step4Exact = `let ${vars.result};if(${vars.ra})${vars.result}=${vars.content}.split(${vars.os}).join(${vars.ns});else{if(${vars.count}>1)throw new ${vars.errClass}(\`edit: old_string appears \${${vars.count}} times in \${${vars.fp}} (must be unique)\`);${vars.result}=${vars.content}.replace(${vars.os},()=>${vars.ns})}`;

  if (funcContent.includes(step4Exact)) {
    const lp = vars.lambdaParam;
    const step4Replacement = `let ${vars.result};if(${vars.ra}){if(${vars.wsFlag})${vars.result}=${vars.content}.split(String.fromCharCode(10)).map(${lp}=>${lp}.trim()).join(String.fromCharCode(10)).split(${vars.os}.split(String.fromCharCode(10)).map(${lp}=>${lp}.trim()).join(String.fromCharCode(10))).join(${vars.ns});else ${vars.result}=${vars.content}.split(${vars.os}).join(${vars.ns});}else{if(${vars.count}>1)throw new ${vars.errClass}(\`edit: old_string appears \${${vars.count}} times in \${${vars.fp}} (must be unique)\`);${vars.result}=${vars.wsFlag}?${vars.content}.split(String.fromCharCode(10)).map(${lp}=>${lp}.trim()).join(String.fromCharCode(10)).replace(${vars.os}.split(String.fromCharCode(10)).map(${lp}=>${lp}.trim()).join(String.fromCharCode(10)),()=>${vars.ns}.split(String.fromCharCode(10)).map(${lp}=>${lp}.trim()).join(String.fromCharCode(10))):${vars.content}.replace(${vars.os},()=>${vars.ns})}`;
    funcContent = funcContent.replace(step4Exact, step4Replacement);
  } else {
    // Flexible fallback: match any variable/error-class names (word boundary guard prevents cross-line collision)
    const step4FlexRe = new RegExp(
      `(?<![a-zA-Z_$])let ${vars.result};if\\(${vars.ra}\\)${vars.result}=[a-zA-Z_]\\.split\\([a-zA-Z_$]+\\)\\.join\\([a-zA-Z_$]+\\);else{if\\(${vars.count}>1\\)throw new [a-zA-Z_$]+`
    );
    if (step4FlexRe.test(funcContent)) {
      const lp = vars.lambdaParam;
      const step4Replacement = `let ${vars.result};if(${vars.ra}){if(${vars.wsFlag})${vars.result}=${vars.content}.split(String.fromCharCode(10)).map(${lp}=>${lp}.trim()).join(String.fromCharCode(10)).split(${vars.os}.split(String.fromCharCode(10)).map(${lp}=>${lp}.trim()).join(String.fromCharCode(10))).join(${vars.ns});else ${vars.result}=${vars.content}.split(${vars.os}).join(${vars.ns});}else{if(${vars.count}>1)throw new ${vars.errClass}(\`edit: old_string appears \${${vars.count}} times in \${${vars.fp}} (must be unique)\`);${vars.result}=${vars.wsFlag}?${vars.content}.split(String.fromCharCode(10)).map(${lp}=>${lp}.trim()).join(String.fromCharCode(10)).replace(${vars.os}.split(String.fromCharCode(10)).map(${lp}=>${lp}.trim()).join(String.fromCharCode(10)),()=>${vars.ns}.split(String.fromCharCode(10)).map(${lp}=>${lp}.trim()).join(String.fromCharCode(10))):${vars.content}.replace(${vars.os},()=>${vars.ns})}`;
      funcContent = funcContent.replace(step4FlexRe, step4Replacement);
    } else {
      console.error(
        'patch: ignoreWhitespaceEdit: Step 4 failed — join pattern not found'
      );
      return null;
    }
  }

  // Reassemble the full file with only the edit tool replaced
  const newFile =
    oldFile.slice(0, funcStart) + funcContent + oldFile.slice(funcEndIdx);

  showDiff(
    oldFile,
    newFile,
    'ignore_whitespace parameter added to edit tool',
    funcStart,
    funcContent.length
  );
  return newFile;
};

// ============================================================================
// Variable extraction — multi-pass scan of the edit tool body.
// Pass 1: collect ALL local variable names to avoid collisions.
// Pass 2: extract specific minified identifiers for structural patterns.
// Pass 3: generate safe single-letter names for new injected code.
// ============================================================================

/** Extract all locally-scoped identifier names from the edit tool body */
const collectUsedVars = (body: string): Set<string> => {
  const used = new Set<string>();

  // Destructure params (4 of them)
  const deMatch = body.match(BODY_START_RE);
  if (deMatch) {
    for (let i = 1; i <= 4; i++) {
      if (deMatch[i]) used.add(deMatch[i]);
    }
  }

  // let declarations — both single-letter and multi-char names
  const letMatches = [...body.matchAll(/let\s+([a-zA-Z_$][\w$]*)/g)];
  for (const m of letMatches) {
    used.add(m[1]);
  }

  // Catch declarations like `let i=await ITr(e,t),s;` — the comma-separated part
  const multiLetMatch = [...body.matchAll(/let\s+(\w+)=\w+\([^)]+\),(\w+);/g)];
  for (const m of multiLetMatch) {
    if (m[2]) used.add(m[2]);
  }

  // Function references used as external calls (e.g., ITr, Fbn, Axs, F9, Stat)
  // These are NOT local vars but we want to know them for collision checking
  const funcRefMatch = [...body.matchAll(/\b([A-Z][a-zA-Z_$]+)\(/g)];
  for (const m of funcRefMatch) {
    used.add(m[1]); // Track external function names too
  }

  // Arrow function parameters — they shadow outer scope, but we track them to avoid naming collisions
  // e.g., .map((x)=>x.trim()) or .replace(r,()=>n)
  const arrowParamMatch = [
    ...body.matchAll(/\(\s*([a-zA-Z_$][\w$]*)\s*\)\s*=>/g),
  ];
  for (const m of arrowParamMatch) {
    used.add(m[1]);
  }

  // Single-param arrows — e.g., .map(x => x.trim()) or .replace(r, () => n)
  const singleArrowParam = [...body.matchAll(/\(\s*([a-zA-Z_$])\s*\)=>/g)];
  for (const m of singleArrowParam) {
    used.add(m[1]);
  }

  return used;
};

/** Generate safe single-letter variable names not in the used set */
const generateSafeNames = (used: Set<string>): string[] => {
  const allLetters =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  return allLetters.filter(l => !used.has(l));
};

const captureVarNames = (body: string): VarNames | null => {
  // ---- Pass 1: Collect ALL used variable names ----
  const usedVars = collectUsedVars(body);

  // Generate safe unused single-letter names
  const safeLetters = generateSafeNames(usedVars);
  if (safeLetters.length === 0) {
    console.error('captureVarNames: no safe single-letter variables available');
    return null;
  }

  // ---- Pass 2: Extract specific minified identifiers ----
  const deMatch = body.match(BODY_START_RE);
  if (!deMatch) {
    console.error('captureVarNames: no destructure match');
    return null;
  }

  const fp = deMatch[1]; // file_path param (e.g. "t")
  const os = deMatch[2]; // old_string param (e.g. "r")
  const ns = deMatch[3]; // new_string param (e.g. "n")
  const ra = deMatch[4]; // replace_all param (e.g. "o")

  // Count variable: `let <count>=<content>.split(<os>).length-1`
  const countRe = new RegExp(
    `let ([a-zA-Z_$]+)=([a-zA-Z_])\\.split\\(${os}\\)\\.length-1`
  );
  const countMatch = body.match(countRe);
  if (!countMatch) {
    console.error('captureVarNames: no count match');
    return null;
  }
  const count = countMatch[1]; // e.g. "a"
  const content = countMatch[2]; // e.g. "s" (file content var)

  // Error class: first `throw new <Name>(` in the body
  const errClassMatch = body.match(/throw new ([a-zA-Z_$]+)/);
  if (!errClassMatch) return null;
  const errClass = errClassMatch[1];

  // Verify error class scope — must be used with ${fp} template var
  const verifyErrClass = new RegExp(`throw new ${errClass}.*\\$\\{${fp}\\}`);
  if (!verifyErrClass.test(body)) {
    console.error('captureVarNames: errClass not verified');
    return null;
  }

  // Result variable: `<name>=<content>.split(<os>).join(...)` or `<name>=<content>.replace(...)`
  const resultRe = new RegExp(
    `([a-zA-Z_$]+)=${content}\\.split\\(${os}\\)\\.join`
  );
  let result = resultRe.exec(body)?.[1];

  if (!result) {
    // Fallback: look for `<name>=<content>.replace(<os>,()=><ns>)` after else branch
    const replaceRe = new RegExp(
      `;([a-zA-Z_$]+)=${content}\\.replace\\(${os},\\(\\)=>${ns}\\)`
    );
    result = replaceRe.exec(body)?.[1];
  }

  if (!result) {
    // Last resort: find any `<name>=<content>.split` near else branch
    const beforeElse = body.indexOf('else{');
    if (beforeElse >= 0) {
      const snippet = body.substring(
        Math.max(0, beforeElse - 200),
        beforeElse + 5
      );
      const snippetMatch = snippet.match(/([a-zA-Z_$]+)=${content}\\.split/);
      result = snippetMatch?.[1];
    }
  }

  if (!result) {
    console.error('captureVarNames: no result var found');
    return null;
  }

  // ---- Pass 3: Assign safe names for injected code ----
  // wsFlag is the first unused letter, used for `ignore_whitespace` parameter value check
  const wsFlag = safeLetters[0];

  // lambdaParam is the second unused letter (first after wsFlag), used in arrow function params
  // e.g., .map(lambdaParam => lambdaParam.trim()) instead of hardcoded x
  const lambdaParam = safeLetters.length > 1 ? safeLetters[1] : safeLetters[0];

  return {
    fp,
    os,
    ns,
    ra,
    content,
    count,
    result,
    errClass,
    wsFlag,
    lambdaParam,
  };
};
