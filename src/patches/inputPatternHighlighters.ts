import { stringifyRegex } from '@/utils';
import { InputPatternHighlighter } from '../types';
import { findChalkVar, findChalkVarInModule, showDiff } from './index';

// ======================================================================

const buildChalkChain = (
  chalkVar: string,
  highlighter: InputPatternHighlighter
): string => {
  let chain = chalkVar;

  if (highlighter.foregroundColor) {
    const fgMatch = highlighter.foregroundColor.match(/\d+/g);
    if (fgMatch) {
      chain += `.rgb(${fgMatch.join(',')})`;
    }
  }

  if (highlighter.backgroundColor) {
    const bgMatch = highlighter.backgroundColor.match(/\d+/g);
    if (bgMatch) {
      chain += `.bgRgb(${bgMatch.join(',')})`;
    }
  }

  if (highlighter.styling.includes('bold')) chain += '.bold';
  if (highlighter.styling.includes('italic')) chain += '.italic';
  if (highlighter.styling.includes('underline')) chain += '.underline';
  if (highlighter.styling.includes('strikethrough')) chain += '.strikethrough';
  if (highlighter.styling.includes('inverse')) chain += '.inverse';

  return chain;
};

// ======================================================================

const rewriteJsxHighlightRenderer = (
  oldFile: string,
  jsxMatch: RegExpMatchArray,
  dottedJsx: boolean
): string | null => {
  if (jsxMatch.index === undefined) return null;
  const [, jsxVar, textComp, props, segVar, innerComp, keyVar] = jsxMatch;
  const propVars = [...props.matchAll(/[$\w]+:([$\w]+)\.highlight\?\./g)].map(
    m => m[1]
  );
  if (propVars.some(v => v !== segVar)) {
    console.error(
      'patch: inputPatternHighlighters: highlight prop run mixes segment variables'
    );
    return null;
  }

  const call = dottedJsx ? `${jsxVar}.jsx` : jsxVar;
  const styleFn =
    `(${segVar}.highlight?.style??` +
    `(typeof ${segVar}.highlight?.color==="function"?` +
    `${segVar}.highlight.color:void 0))`;
  const off = (prop: string): string =>
    `,${prop}:${styleFn}?void 0:${segVar}.highlight?.${prop}`;

  const replacement =
    `return ${call}(${textComp},{` +
    `${off('color').slice(1)}` +
    off('backgroundColor') +
    `,dimColor:${segVar}.highlight?.dimColor` +
    off('inverse') +
    off('bold') +
    off('italic') +
    off('underline') +
    off('strikethrough') +
    `,children:${call}(${innerComp},{children:${styleFn}?` +
    `${styleFn}(${segVar}.text):${segVar}.text})},${keyVar})`;

  const newFile =
    oldFile.slice(0, jsxMatch.index) +
    replacement +
    oldFile.slice(jsxMatch.index + jsxMatch[0].length);

  showDiff(
    oldFile,
    newFile,
    replacement,
    jsxMatch.index,
    jsxMatch.index + jsxMatch[0].length
  );

  return newFile;
};

const writeCustomHighlighterImpl = (oldFile: string): string | null => {
  // Idempotency: the augmented renderer (any method) is the only place that
  // emits this exact guard, so a second pass is a no-op instead of a failure.
  if (
    oldFile.includes('.highlight?.style?void 0:') ||
    oldFile.includes('.highlight?.style??(typeof ')
  ) {
    return oldFile;
  }

  // Method 0 — CC >= 2.1.246: jsx/jsxs are imported bindings, so the renderer
  // is a bare call (`return c(u,{color:C.highlight?.color,...,children:c(E,
  // {children:C.text})},Pt)`) rather than `JSX.jsx(TEXT,{...})`. Same prop-run
  // matching as Method 1 so a newly inserted highlight field does not break us.
  const importedJsxRegex =
    /return ([$\w]+)\(([$\w]+),\{((?:[$\w]+:([$\w]+)\.highlight\?\.[$\w]+,)+)children:\1\(([$\w]+),\{children:\4\.text\}\)\},([$\w]+)\)/;

  const importedJsxMatch = oldFile.match(importedJsxRegex);
  if (importedJsxMatch && importedJsxMatch.index !== undefined) {
    return rewriteJsxHighlightRenderer(oldFile, importedJsxMatch, false);
  }

  // Method 1 — CC >=2.1.186 (jsx runtime). React.createElement was replaced by
  // jsx()/jsxs() with children passed inline as a `children:` prop and the key
  // moved to the third argument:
  //   return JSX.jsx(TEXT,{color:SEG.highlight?.color,dimColor:SEG.highlight
  //     ?.dimColor,inverse:SEG.highlight?.inverse,children:JSX.jsx(INNER,
  //     {children:SEG.text})},KEY)
  // The sibling shimmer branch is now gated on `highlight?.shimmerColor`
  // (which our pushed ranges never set), so no shimmer guard is needed here.
  // The prop list is matched as a RUN of `name:SEG.highlight?.name,` pairs
  // rather than as a fixed sequence: CC 2.1.234 inserted `underline:` between
  // `inverse:` and `children:` and a sequence-pinned anchor stopped matching,
  // which nothing surfaced because this patch is config-gated and `--apply`
  // never runs it (skrabe/lobotomized-claude-code#25 is the same class on the
  // reminder patches). The replacement emits its own complete prop list, so a
  // prop Anthropic adds here is covered without a further change.
  const jsxRegex =
    /return ([$\w]+)\.jsx\(([$\w]+),\{((?:[$\w]+:([$\w]+)\.highlight\?\.[$\w]+,)+)children:\1\.jsx\(([$\w]+),\{children:\4\.text\}\)\},([$\w]+)\)/;

  const jsxMatch = oldFile.match(jsxRegex);
  if (jsxMatch && jsxMatch.index !== undefined) {
    return rewriteJsxHighlightRenderer(oldFile, jsxMatch, true);
  }

  // Method 2 — CC <2.1.83: if(N.highlight?.color)return createElement(T,{key:E},color:N.highlight.color,...)
  const oldRegex =
    /(if\(([$\w]+)\.highlight\?\.color\))((return [$\w]+\.createElement\([$\w]+,\{key:[$\w]+),color:[$\w]+\.highlight\.color(\},[$\w]+\.createElement\([$\w]+,null,)([$\w]+\.text)(\)\)));/;

  const oldMatches = oldFile.match(oldRegex);
  if (oldMatches && oldMatches.index !== undefined) {
    const styledFormattedText = `${oldMatches[2]}.highlight.color(${oldMatches[6]})`;

    const replacement =
      oldMatches[1] +
      `{if(typeof ${oldMatches[2]}.highlight.color==='function')` +
      oldMatches[4] +
      oldMatches[5] +
      styledFormattedText +
      oldMatches[7] +
      ';else ' +
      oldMatches[3] +
      '}';

    const newFile =
      oldFile.slice(0, oldMatches.index) +
      replacement +
      oldFile.slice(oldMatches.index + oldMatches[0].length);

    showDiff(
      oldFile,
      newFile,
      replacement,
      oldMatches.index,
      oldMatches.index + oldMatches[0].length
    );

    return newFile;
  }

  // Method 3 — CC >=2.1.83: return createElement(T,{key:E,color:N.highlight?.color,...},createElement(IK,null,N.text))
  // No if guard — color is passed as optional chain prop
  const newRegex =
    /(return ([$\w]+)\.createElement\(([$\w]+),\{key:([$\w]+)),color:([$\w]+)\.highlight\?\.color,dimColor:\5\.highlight\?\.dimColor,inverse:\5\.highlight\?\.inverse\},(\2\.createElement\([$\w]+,null,\5\.text\))\)/;

  const newMatches = oldFile.match(newRegex);
  if (!newMatches || newMatches.index === undefined) {
    console.error(
      'patch: inputPatternHighlighters: failed to find highlight?.color renderer pattern'
    );
    return null;
  }

  const reactVar = newMatches[2];
  const textComp = newMatches[3];
  const keyVar = newMatches[4];
  const segVar = newMatches[5];
  const _innerElem = newMatches[6]; // eslint-disable-line @typescript-eslint/no-unused-vars

  // First, find and patch the shimmer branch that runs BEFORE the main return.
  // Pattern: if(SEG.highlight.color)return REACT.createElement(TEXT,{key:KEY},SEG.text.split("").map(...))
  // We need to insert a typeof check before it so function colors don't get caught by shimmer.
  const shimmerPattern = new RegExp(
    `if\\(${segVar.replace('$', '\\$')}\\.highlight\\.color\\)return ([$\\w]+)\\.createElement\\([$\\w]+,\\{key:[$\\w]+\\},${segVar.replace('$', '\\$')}\\.text\\.split\\(""\\)\\.map\\([^)]+\\)\\)`
  );

  let workingFile = oldFile;
  const shimmerMatch = workingFile.match(shimmerPattern);
  if (shimmerMatch && shimmerMatch.index !== undefined) {
    const shimmerGuard =
      `if(typeof ${segVar}.highlight?.color==='function')` +
      `return ${reactVar}.createElement(${textComp},{key:${keyVar}},` +
      `${reactVar}.createElement(${textComp},null,${segVar}.highlight.color(${segVar}.text)));`;
    workingFile =
      workingFile.slice(0, shimmerMatch.index) +
      shimmerGuard +
      workingFile.slice(shimmerMatch.index);
  }

  // Now patch the main return (which may have shifted due to shimmer insertion).
  // The pristine renderer only reads color/dimColor/inverse from the highlight
  // object. Extend it to also forward bold/italic/underline/strikethrough/
  // backgroundColor so the highlighter push entries can express those styles.
  const newMatches2 = workingFile.match(newRegex);
  if (!newMatches2 || newMatches2.index === undefined) {
    console.error(
      'patch: inputPatternHighlighters: failed to re-find renderer after shimmer patch'
    );
    return null;
  }

  const reactVar2 = newMatches2[2];
  const textComp2 = newMatches2[3];
  const keyVar2 = newMatches2[4];
  const segVar2 = newMatches2[5];
  const innerElem2 = newMatches2[6];

  const styledText =
    `${segVar2}.highlight?.style?` +
    `${segVar2}.highlight.style(${segVar2}.text):${segVar2}.text`;
  const styledInnerElem = innerElem2.replace(`${segVar2}.text`, styledText);
  const augmentedRenderer =
    `return ${reactVar2}.createElement(${textComp2},{key:${keyVar2}` +
    `,color:${segVar2}.highlight?.style?void 0:${segVar2}.highlight?.color` +
    `,backgroundColor:${segVar2}.highlight?.style?void 0:${segVar2}.highlight?.backgroundColor` +
    `,dimColor:${segVar2}.highlight?.dimColor` +
    `,inverse:${segVar2}.highlight?.style?void 0:${segVar2}.highlight?.inverse` +
    `,bold:${segVar2}.highlight?.style?void 0:${segVar2}.highlight?.bold` +
    `,italic:${segVar2}.highlight?.style?void 0:${segVar2}.highlight?.italic` +
    `,underline:${segVar2}.highlight?.style?void 0:${segVar2}.highlight?.underline` +
    `,strikethrough:${segVar2}.highlight?.style?void 0:${segVar2}.highlight?.strikethrough` +
    `},${styledInnerElem})`;

  const newFile =
    workingFile.slice(0, newMatches2.index) +
    augmentedRenderer +
    workingFile.slice(newMatches2.index + newMatches2[0].length);

  showDiff(oldFile, newFile, 'shimmer guard + renderer', 0, 0);

  return newFile;
};

// ======================================================================

const writeCustomHighlighterCreation = (
  oldFile: string,
  chalkVar: string,
  highlighters: InputPatternHighlighter[]
): string | null => {
  // CC <2.1.83: ,VAR=REACT.useMemo(()=>{let ARR=[];if(...)ARR.push(...)
  // CC >=2.1.83: ;let VAR=REACT.useMemo(()=>{let ARR=[];for(...)...;if(...)ARR.push(...)
  // CC >=2.1.140: same shape, but unrelated useMemos earlier in the file
  // require the inner span to be length-bounded so the regex doesn't span
  // across functions and latch onto the wrong useMemo opening.
  //
  // Method 0 (CC >= 2.1.257): the React Compiler removed the useMemo() call
  // entirely — no `.useMemo(` or arrow wrapper survives to anchor on. The
  // ranges builder is now a bare memo-cache-guarded block:
  //   let $to;if(is[103]!==Fat||is[104]!==jd||...){let Aw=[];for(...)...;
  //     if(Hd&&x_&&!dat)Aw.push({start:jd,end:jd+uat.length,color:"warning",
  //     priority:20});...;$to=nRe(Aw,qat);is[103]=Fat,...}else $to=is[119];
  // An inserted prop-detection loop now sits between `let Aw=[]` and the
  // "warning" push, so that middle span is matched as an unbounded run
  // rather than a fixed lookahead distance, same as the older methods below.
  // The guard's dependency list is captured separately so it can be widened
  // with `||!0` (the same trick `toolsets.ts`'s cache-guard widening uses) —
  // relying on the existing deps to always catch our injected input read
  // would be a silent-staleness bet the codebase avoids elsewhere.
  const compilerMemoRegex =
    /([$\w]+;if\()([^()]{0,1500}?)(\)\{let [$\w]+=\[\];[\s\S]{0,3000}?)(if\([$\w]+&&[$\w]+&&![$\w]+\)([$\w]+)\.push\(\{start:[$\w]+,end:[$\w]+\+[$\w]+\.length,color:"warning",priority:\d+\}\))/;
  const compilerMemoMatch = oldFile.match(compilerMemoRegex);

  // Method 1 (CC >= 2.1.246): useMemo is an imported binding, so the ranges
  // builder is `let Mc=z(()=>{let E=[];...if(be&&en&&!Gi)E.push({start:U,
  // end:U+Pn.length,color:"warning",priority:20})` — no `.useMemo`.
  const importedMemoRegex =
    /((?:let |;|,)[$\w]+=[$\w]+\(\(\)=>\{let [$\w]+=\[\];[\s\S]{0,2000}?)(if\([$\w]+&&[$\w]+&&![$\w]+\)([$\w]+)\.push\(\{start:[$\w]+,end:[$\w]+\+[$\w]+\.length,color:"warning",priority:\d+\})/;

  // Method 2 (CC <2.1.246): `,VAR=REACT.useMemo(()=>{let ARR=[];...` or
  // `;let VAR=REACT.useMemo(()=>{let ARR=[];...`
  const regex =
    /((?:,|;let )[$\w]+=[$\w]+\.useMemo\(\(\)=>\{let [$\w]+=\[\];[\s\S]{0,2000}?)(if\([$\w]+&&[$\w]+&&![$\w]+\)([$\w]+)\.push\(\{start:[$\w]+,end:[$\w]+\+[$\w]+\.length,color:"warning",priority:\d+\})/;

  let matchIndex: number;
  let matchLength: number;
  let prefix: string;
  let pushChunk: string;
  let rangesVar: string;

  if (compilerMemoMatch && compilerMemoMatch.index !== undefined) {
    const [, ifHead, cond, afterCond, pushText, rangesName] = compilerMemoMatch;
    matchIndex = compilerMemoMatch.index;
    matchLength = compilerMemoMatch[0].length;
    prefix = ifHead + cond + '||!0' + afterCond;
    pushChunk = pushText;
    rangesVar = rangesName;
  } else {
    const importedMemoMatch = oldFile.match(importedMemoRegex);
    const match =
      importedMemoMatch && importedMemoMatch.index !== undefined
        ? importedMemoMatch
        : oldFile.match(regex);
    if (!match || match.index === undefined) {
      console.error(
        'patch: inputPatternHighlighters: failed to find useMemo/push pattern'
      );
      return null;
    }
    matchIndex = match.index;
    matchLength = match[0].length;
    prefix = match[1];
    pushChunk = match[2];
    rangesVar = match[3];
  }

  // Chalk as named in THIS module. The bundle-wide winner is a different
  // module's local on a code-split build, so splicing it here throws the first
  // time a highlighter matches. When the module has no chalk, drop the `style`
  // closure: every option this config exposes is also carried by the plain
  // color/backgroundColor/bold/italic/underline/inverse/dimColor/strikethrough
  // props, which is the branch the renderer already falls back to.
  const localChalkVar = findChalkVarInModule(oldFile, matchIndex);
  if (!localChalkVar) {
    console.log(
      'patch: inputPatternHighlighters: no chalk binding in the target module — using declarative styling props'
    );
  }

  const searchStart = Math.max(0, matchIndex - 20000);
  const searchWindow = oldFile.slice(searchStart, matchIndex);
  // CC >=2.1.257: the React Compiler form above reads the current text off a
  // `draft` prop object (`{draft:Ur,...}=Props`) rather than a plain string
  // prop, so the text lives at `Ur.value`. The prop KEY stays literal even
  // though its local alias is minified, so search for it by name.
  const draftPattern = /[,{]draft:([$\w]+)[,}]/g;
  const draftMatches = [...searchWindow.matchAll(draftPattern)];
  const draftVar = draftMatches.at(-1)?.[1];

  // CC >=2.1.140: input is destructured from a hook as `inputValue:VAR,`.
  // CC <2.1.140:  the input variable is passed as a prop named `input:VAR,`.
  // Prefer the new form when present (the old form may also match unrelated
  // function parameters in the same lookback window in 2.1.140).
  const newInputPattern = /\binputValue:([$\w]+),/g;
  const oldInputPattern = /\binput:([$\w]+),/g;
  const newInputMatches = [...searchWindow.matchAll(newInputPattern)];
  const oldInputMatches = [...searchWindow.matchAll(oldInputPattern)];
  const inputMatch = newInputMatches.at(-1) ?? oldInputMatches.at(-1) ?? null;

  const inputVar = draftVar ? `${draftVar}.value` : (inputMatch?.[1] ?? null);
  if (!inputVar) {
    console.error(
      'patch: inputPatternHighlighters: failed to find input variable pattern (looked for draft:, inputValue: and input:)'
    );
    return null;
  }

  const useMemoCode = '';

  let genCode = '';
  for (let i = 0; i < highlighters.length; i++) {
    const highlighter = highlighters[i];
    const chalkChain = localChalkVar
      ? buildChalkChain(localChalkVar, highlighter)
      : null;
    const formatStr = highlighter.format ?? '{MATCH}';
    JSON.stringify(formatStr).replace(/\{MATCH\}/g, '"+x+"'); // preserve legacy side-effect-free transform shape for diff stability

    // Note: format handling for this branch is currently color/style-only.

    let colorStr = highlighter.foregroundColor;
    if (colorStr) {
      const rgbMatch = colorStr.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
      if (rgbMatch) {
        const [, r, g, b] = rgbMatch.map(Number);
        colorStr = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      }
    }
    const colorValue = colorStr ? JSON.stringify(colorStr) : 'undefined';
    let bgColorStr = highlighter.backgroundColor;
    if (bgColorStr) {
      const bgRgbMatch = bgColorStr.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
      if (bgRgbMatch) {
        const [, r, g, b] = bgRgbMatch.map(Number);
        bgColorStr = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      }
    }
    const bgColorValue = bgColorStr ? JSON.stringify(bgColorStr) : null;
    const styling = highlighter.styling ?? [];
    const isBold = styling.includes('bold');
    const isItalic = styling.includes('italic');
    const isUnderline = styling.includes('underline');
    const isInverse = styling.includes('inverse');
    const isDim = styling.includes('dim');
    const isStrikethrough = styling.includes('strikethrough');

    const regexSource =
      highlighter.regex ??
      (highlighter as unknown as { pattern?: string }).pattern;
    if (!regexSource) {
      console.error(
        `patch: inputPatternHighlighters: highlighter "${highlighter.name}" has no regex/pattern; skipping`
      );
      continue;
    }
    let flags = highlighter.regexFlags ?? '';
    if (!flags.includes('g')) {
      flags += 'g';
    }
    let regex: RegExp;
    try {
      regex = new RegExp(regexSource, flags);
    } catch (error) {
      console.error(
        `patch: inputPatternHighlighters: highlighter "${highlighter.name}" has invalid regex; skipping`,
        error
      );
      continue;
    }
    const regexStr = stringifyRegex(regex);

    genCode += `if(typeof ${inputVar}==="string"){for(let m of ${inputVar}.matchAll(${regexStr})){${rangesVar}.push({start:m.index,end:m.index+m[0].length,color:${colorValue}${bgColorValue ? `,backgroundColor:${bgColorValue}` : ''}${isBold ? ',bold:!0' : ''}${isItalic ? ',italic:!0' : ''}${isUnderline ? ',underline:!0' : ''}${isInverse ? ',inverse:!0' : ''}${isDim ? ',dimColor:!0' : ''}${isStrikethrough ? ',strikethrough:!0' : ''}${chalkChain ? `,style:(x)=>${chalkChain}(x)` : ''},priority:100})}}`;
  }

  if (!genCode) {
    console.error(
      'patch: inputPatternHighlighters: no usable highlighters generated (all skipped)'
    );
    return null;
  }

  const replacement = prefix + genCode + pushChunk;

  const beforeMatch = oldFile.slice(0, matchIndex);
  const afterMatch = oldFile.slice(matchIndex + matchLength);

  let newFile = beforeMatch + useMemoCode + replacement + afterMatch;

  // Add inputVar to the rw useMemo's dependency array so it re-runs when
  // input changes. Find the useMemo that contains our for loop by tracking
  // parens from the useMemo opening to its closing. Not applicable to the
  // Method 0 (React Compiler) shape above — there is no dependency array to
  // append to, and the widened `||!0` guard already forces a recompute every
  // render, so skip this to avoid latching onto an unrelated `()=>{...}]`
  // array within the 2000-char lookback.
  const forLoopIdx = compilerMemoMatch
    ? -1
    : newFile.indexOf(`for(let m of ${inputVar}.matchAll(`);
  if (forLoopIdx > -1) {
    const searchBack = newFile.slice(
      Math.max(0, forLoopIdx - 2000),
      forLoopIdx
    );
    const memoMatches = [...searchBack.matchAll(/[$\w]+\(\(\)=>\{/g)];
    if (memoMatches.length > 0) {
      const memoOffset =
        Math.max(0, forLoopIdx - 2000) +
        memoMatches[memoMatches.length - 1].index!;
      const region = newFile.slice(memoOffset);
      let depth = 0;
      for (let i = 0; i < region.length; i++) {
        if (region[i] === '(') depth++;
        else if (region[i] === ')') {
          depth--;
          if (depth === 0) {
            const absClose = memoOffset + i;
            const before = newFile.slice(absClose - 1, absClose);
            if (before === ']') {
              const depsCheck = newFile.slice(absClose - 200, absClose);
              if (!depsCheck.includes(`,${inputVar}]`)) {
                newFile =
                  newFile.slice(0, absClose - 1) +
                  `,${inputVar}]` +
                  newFile.slice(absClose);
              }
            }
            break;
          }
        }
      }
    }
  }

  showDiff(
    oldFile,
    newFile,
    useMemoCode + replacement,
    matchIndex,
    matchIndex + matchLength
  );

  return newFile;
};

// ======================================================================

export const writeInputPatternHighlighters = (
  oldFile: string,
  highlighters: InputPatternHighlighter[]
): string | null => {
  // Treat missing `enabled` as enabled (only `false` disables a highlighter).
  // Robust against partially-typed callers (e.g. defaults loaded from older
  // configs or the probe harness).
  const enabledHighlighters = highlighters.filter(h => h.enabled !== false);

  if (enabledHighlighters.length === 0) {
    console.error(
      'patch: inputPatternHighlighters: no enabled highlighters provided'
    );
    return null;
  }

  const chalkVar = findChalkVar(oldFile);
  if (!chalkVar) {
    // No `^` chain: findChalkVar returns undefined silently (it can't know the
    // caller's patch name), so this is the primary error, like the other
    // chalk-var callers (userMessageDisplay/toolsets/patchesAppliedIndication).
    console.error(
      'patch: inputPatternHighlighters: failed to find chalk variable'
    );
    return null;
  }

  let newFile: string | null;

  newFile = writeCustomHighlighterImpl(oldFile);
  if (!newFile) {
    console.error(
      '^ patch: inputPatternHighlighters: writeCustomHighlighterImpl failed'
    );
    return null;
  }

  newFile = writeCustomHighlighterCreation(
    newFile,
    chalkVar,
    enabledHighlighters
  );
  if (!newFile) {
    console.error(
      '^ patch: inputPatternHighlighters: writeCustomHighlighterCreation failed'
    );
    return null;
  }

  return newFile;
};
