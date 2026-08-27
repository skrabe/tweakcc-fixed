// Patch: Add ignore_whitespace support to FileEditTool's matching chain.
//
// The Edit tool you actually use is `FileEditTool`. Every `old_string` it receives goes through a
// matching function (minified as `$1t` or `W2t` depending on CC version) that returns either the
// exact old_string from the file, null, or a normalized copy. The apply path is:
//   W = $1t(P,d) || d
// so whatever it returns becomes the real old_string — edits never touch anything outside the
// matched span.
//
// This patch adds three things to that matching chain:
//   1. A line-by-line trimmed fallback (when ignore_whitespace=true): compare each side's lines
//      after trim(), and when exactly one run of lines matches, return the original span slice
//      from the file — never a trimmed copy, because writing back whitespace that isn't there
//      corrupts the file. Only activates when LLM explicitly opts in via tool parameter.
//   2. Right after the matching function is `b4r(e,t,r)` / `LWr`, which mirrors quote
//      normalization onto the new_string. Without indentation going through there too, new_string
//      lands at column zero in an indented file. We patch that function to also mirror whitespace.
//   3. The call site where FileEditTool invokes `$1t(P,d)` — we modify it to pass a third parameter
//      (default false) so the matching chain can opt into whitespace-tolerant mode when needed.
//
// Both functions are found by anchoring on English strings the minifier can't rename: grep for
// "Edit also tried swapping" and the call right before it is `m=$1t(f,n)`.

const EDIT_ALSO_TRIED_SWAPPING_RE = /Edit also tried swapping/;

/**
 * Find a function definition by scanning backward from anchorIndex. Returns {name, start, end} or null.
 * Uses brace-balanced counting to find the closing brace of the function body.
 * Only considers functions whose body ends with `return null}` (the matching chain pattern).
 */
function findFunctionDefBefore(
  src: string,
  anchorIndex: number,
  lookBackBytes = 2000
): { name: string; start: number; end: number } | null {
  const searchStart = Math.max(0, anchorIndex - lookBackBytes);
  const snippet = src.slice(searchStart, anchorIndex + 500);

  // Find all `function NAME(` occurrences in the snippet.
  let pos = 0;
  let lastMatch: { name: string; start: number; end: number } | null = null;
  while (pos < snippet.length) {
    const idx = snippet.indexOf('function ', pos);
    if (idx === -1) break;

    // Extract the function name.
    const afterFn = snippet.slice(idx + 9).match(/^([$\w]+)/);
    if (!afterFn) {
      pos = idx + 9;
      continue;
    }
    const funcName = afterFn[1];

    // Find the opening paren.
    const openParenIdx = snippet.indexOf('(', idx + 9);
    if (openParenIdx === -1) {
      pos = idx + 9;
      continue;
    }

    // Find the matching closing paren to get the full signature.
    let depth = 1;
    let p = openParenIdx + 1;
    while (p < snippet.length && depth > 0) {
      if (snippet[p] === '(') depth++;
      else if (snippet[p] === ')') depth--;
      p++;
    }
    if (depth !== 0) {
      pos = idx + 9;
      continue;
    }

    // Now find the opening brace.
    const openBraceIdx = snippet.indexOf('{', p - 1);
    if (openBraceIdx === -1 || openBraceIdx < p - 2) {
      pos = idx + 9;
      continue;
    }

    // Count braces to find matching close — properly handle nested braces.
    let braceDepth = 1;
    let b = openBraceIdx + 1;
    while (b < snippet.length && braceDepth > 0) {
      if (snippet[b] === '{') braceDepth++;
      else if (snippet[b] === '}') braceDepth--;
      b++;
    }
    if (braceDepth !== 0) {
      pos = idx + 9;
      continue;
    }

    // Only consider functions that end with `return null}` — the matching chain pattern.
    const bodyEnd = snippet.slice(openBraceIdx, b);
    if (!bodyEnd.endsWith('return null}')) {
      pos = idx + 9;
      continue;
    }

    const absStart = searchStart + idx; // Start from 'function NAME(' not just '{'
    const absEnd = searchStart + b; // one past the '}'
    lastMatch = { name: funcName, start: absStart, end: absEnd };
    pos = idx + 9;
  }

  return lastMatch;
}

/**
 * Find a function definition by scanning forward from startIndex. Same brace-balanced approach.
 */
function findFunctionDefAfter(
  src: string,
  startIndex: number,
  lookForwardBytes = 2000
): { name: string; start: number; end: number } | null {
  const snippet = src.slice(startIndex, startIndex + lookForwardBytes);

  let pos = 0;
  let lastMatch: { name: string; start: number; end: number } | null = null;
  while (pos < snippet.length) {
    const idx = snippet.indexOf('function ', pos);
    if (idx === -1) break;

    const afterFn = snippet.slice(idx + 9).match(/^([$\w]+)/);
    if (!afterFn) {
      pos = idx + 9;
      continue;
    }
    const funcName = afterFn[1];

    const openParenIdx = snippet.indexOf('(', idx + 9);
    if (openParenIdx === -1) {
      pos = idx + 9;
      continue;
    }

    let depth = 1;
    let p = openParenIdx + 1;
    while (p < snippet.length && depth > 0) {
      if (snippet[p] === '(') depth++;
      else if (snippet[p] === ')') depth--;
      p++;
    }
    if (depth !== 0) {
      pos = idx + 9;
      continue;
    }

    const openBraceIdx = snippet.indexOf('{', p - 1);
    if (openBraceIdx === -1 || openBraceIdx < p - 2) {
      pos = idx + 9;
      continue;
    }

    let braceDepth = 1;
    let b = openBraceIdx + 1;
    while (b < snippet.length && braceDepth > 0) {
      if (snippet[b] === '{') braceDepth++;
      else if (snippet[b] === '}') braceDepth--;
      b++;
    }
    if (braceDepth !== 0) {
      pos = idx + 9;
      continue;
    }

    const absStart = startIndex + idx; // Start from 'function NAME(' not just '{'
    const absEnd = startIndex + b;
    lastMatch = { name: funcName, start: absStart, end: absEnd };
    pos = idx + 9;
  }

  return lastMatch;
}

/**
 * Insert code before the `return null}` at the end of a function body.
 * The function ends with `...return null}` — we find that pattern and insert before it.
 */
function insertBeforeReturnNull(
  src: string,
  funcStart: number,
  funcEnd: number,
  codeToInsert: string
): string {
  const body = src.slice(funcStart, funcEnd);
  // Find the last `return null}` pattern in the body.
  const returnNullIdx = body.lastIndexOf('return null}');
  if (returnNullIdx === -1) return src;

  const insertAbsPos = funcStart + returnNullIdx;
  return (
    src.slice(0, insertAbsPos) + codeToInsert + '\n' + src.slice(insertAbsPos)
  );
}

/**
 * Insert code before the last `return` statement in a function body.
 * For functions like b4r/LWr that end with `return something`, not `return null}`.
 */
function insertBeforeLastReturn(
  src: string,
  funcStart: number,
  funcEnd: number,
  codeToInsert: string
): string {
  const body = src.slice(funcStart, funcEnd);
  // Find the last `return` statement in the body.
  const returnIdx = body.lastIndexOf('return ');
  if (returnIdx === -1) return src;

  const insertAbsPos = funcStart + returnIdx;
  return (
    src.slice(0, insertAbsPos) + codeToInsert + '\n' + src.slice(insertAbsPos)
  );
}

export const writeIgnoreWhitespaceEdit = (oldFile: string): string | null => {
  // Idempotency check — if our marker is already there, we've been applied before.
  if (oldFile.includes('// tweakcc-ignore-whitespace-fallback')) return null;

  // Anchor on English string to find the matching function region.
  const editAlsoTried = oldFile.match(EDIT_ALSO_TRIED_SWAPPING_RE);
  if (!editAlsoTried) {
    console.log(
      'patch: ignoreWhitespaceEdit: "Edit also tried swapping" not found — skipping'
    );
    return null;
  }

  // Find the matching function ($1t / W2t / pjt depending on CC version) that is just before the anchor.
  // v241 has more code between the function and anchor, so we need a larger look-back window.
  const matcher = findFunctionDefBefore(oldFile, editAlsoTried.index!, 50_000);
  if (!matcher) {
    console.log(
      'patch: ignoreWhitespaceEdit: could not find matching function definition'
    );
    return null;
  }

  // Build the whitespace fallback code — line-by-line trimmed comparison, returning original span.
  // Only activates when ignore_whitespace=true (LLM explicitly requests it via tool parameter).
  const fallbackComment = '// tweakcc-ignore-whitespace-fallback';
  const fallbackCode = `
    ${fallbackComment}
    if(ignoreWhitespace){
      var _tL=t.split(/\\r?\\n|\\r/),_eL=e.split(/\\r?\\n|\\r/);
      if(_tL.length===_eL.length&&_tL.every(function(l,i){return l.trim()===_eL[i].trim()})){
        var _runs=0,_start=-1;
        for(var _i=0;_i<_tL.length;_i++){
          if(_tL[_i].trim()!==''||_eL[_i].trim()!==''){
            if(_runs===0){_start=_i}
            _runs++
          } else {
            if(_runs>0)break
          }
        }
        if(_runs<=1&&_start>=0){
          var _os=0;for(var _j=0;_j<_start;_j++)_os+=_eL[_j].length+1;
          var _oe=_os;for(var _k=_start;_k<_start+_runs;_k++)_oe+=_eL[_k].length+( _k<_start+_runs-1?1:0);
          return e.substring(_os,_oe)
        }
      }
    }`;

  // Add ignore_whitespace parameter to $1t signature for LLM opt-in control.
  // Default is false (strict exact matching). Set true only when formatting/indentation differs.
  // Guidance: Use ONLY for whitespace-tolerant files like JS/TS/HTML/CSS where indentation changes during formatting don't affect semantics. NEVER use for YAML, Python, TOML etc. where indentation IS significant — always use exact matching (ignore_whitespace=false).

  let result = insertBeforeReturnNull(
    oldFile,
    matcher.start,
    matcher.end,
    fallbackCode
  );

  // Patch $1t signature to accept ignoreWhitespace parameter (default false).
  // The function definition is at: "function $1t(e,t){" — we need to change it to "function $1t(e,t,ignoreWhitespace=false){".
  // Find the opening paren of the function signature.
  const sigStart = result.indexOf(`function ${matcher.name}(`);
  if (sigStart !== -1) {
    const openParenIdx = result.indexOf(
      '(',
      sigStart + matcher.name.length + 9
    );
    if (openParenIdx !== -1) {
      // Find the matching closing paren.
      let depth = 1;
      let p = openParenIdx + 1;
      while (p < result.length && depth > 0) {
        if (result[p] === '(') depth++;
        else if (result[p] === ')') depth--;
        p++;
      }
      if (depth === 0) {
        // Insert ",ignoreWhitespace=false" before the closing paren.
        result =
          result.slice(0, p - 1) +
          ',ignoreWhitespace=false' +
          result.slice(p - 1);
      }
    }
  }

  // Patch all call sites like $1t(f,n) → $1t(f,n,false). Use a simple string search + replace
  // to avoid regex escaping issues with dollar signs in minified names.
  const callSitePattern = `${matcher.name}(`;

  let searchStart = result.indexOf(callSitePattern);

  while (searchStart !== -1) {
    // Check if this is preceded by "function" — if so, it's a function def, not a call site.
    const before = result.slice(Math.max(0, searchStart - 30), searchStart);

    if (!before.includes('function ')) {
      // Found a real call site! Patch it.
      const openIdx = searchStart + callSitePattern.length;
      let depth = 1; // Start at 1 because we're already past the opening paren of $1t(
      let p = openIdx;
      while (p < result.length) {
        if (result[p] === '(') depth++;
        else if (result[p] === ')') {
          depth--;
          if (depth === 0) break;
        }
        p++;
      }

      const args = result.slice(openIdx, p);

      // Find all commas to determine argument count.
      const commaPositions: number[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === ',') commaPositions.push(i);
      }

      let replacement: string | null = null;

      if (commaPositions.length === 1) {
        // 2-arg call: $1t(arg1,arg2) → $1t(arg1,arg2,false)
        const arg1 = args.slice(0, commaPositions[0]).trim();
        const arg2 = args.slice(commaPositions[0] + 1).trim();
        replacement = `${matcher.name}(${arg1},${arg2},false)`;
      } else if (commaPositions.length === 2) {
        // 3-arg call: $1t(arg1,arg2,replaceAll) → $1t(arg1,arg2,replaceAll,false)
        const arg1 = args.slice(0, commaPositions[0]).trim();
        const arg2 = args
          .slice(commaPositions[0] + 1, commaPositions[1])
          .trim();
        const replaceAllArg = args.slice(commaPositions[1] + 1).trim();
        replacement = `${matcher.name}(${arg1},${arg2},${replaceAllArg},false)`;
      }

      if (replacement) {
        result =
          result.slice(0, searchStart) + replacement + result.slice(p + 1);
      }
    }

    // Continue searching for more call sites.
    searchStart = result.indexOf(
      callSitePattern,
      searchStart + callSitePattern.length
    );
  }

  // Now find and patch b4r/LWr — the normalization mirror function right after.
  // Search from matcher.end in the PATCHED result (which is now inside the patched $1t body).
  // findFunctionDefAfter scans forward for the next 'function NAME(' pattern, so it will find LWr.
  const norm = findFunctionDefAfter(result, matcher.end);
  if (!norm) {
    console.log(
      'patch: ignoreWhitespaceEdit: could not find normalization mirror function (b4r/LWr)'
    );
    return result; // matching function patched OK, normalizer is optional
  }

  // Build the normalization mirror patch — also mirror whitespace (indentation) onto new_string.
  const normPatchComment = '// tweakcc-ignore-whitespace-fallback';
  const normPatchCode = `
    ${normPatchComment}
    var _nL=r.split(/\\r?\\n|\\r/),_mL=n.split(/\\r?\\n|\\r/);
    if(_nL.length===_mL.length){
      r=_nL.map(function(l,i){var _o=_mL[i].length-_nL[i].trimStart().length;return _o>0?l.trimStart().slice(0,_o)+l:l}).join('\\n')
    }`;

  result = insertBeforeLastReturn(result, norm.start, norm.end, normPatchCode);

  console.log(
    `patch: ignoreWhitespaceEdit: patched ${matcher.name} (sig + call sites), LWr`
  );
  return result;
};
