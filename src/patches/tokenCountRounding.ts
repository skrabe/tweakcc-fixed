// Please see the note about writing patches in ./index

import { showDiff } from './index';

/**
 * Rounds the displayed token count to the nearest multiple of a given base value.
 *
 * This patch modifies the token count display so that instead of showing exact
 * values like "1234 tokens", it shows rounded values like "1200 tokens" (when
 * base is 100).
 *
 * The patch supports two different patterns for different Claude Code versions:
 *
 * Newer versions (CC 2.x+):
 * ```
 * overrideMessage:..., VAR=FUNC(EXPR),...key:"tokens"..., VAR," tokens"
 * ```
 *
 * Older versions (CC 1.x):
 * ```
 * overrideMessage:...,key:"tokens"...FUNC(Math.round(...))
 * ```
 *
 * The token expression is wrapped with: Math.round((EXPR)/base)*base
 */
const getRoundingBase = (rounding: number | { threshold?: number }): number => {
  if (typeof rounding === 'number') return rounding;
  return rounding.threshold ?? 1000;
};

interface SpliceParts {
  fullMatch: string;
  pre: string;
  partToWrap: string;
  post: string;
  startIndex: number;
}

/**
 * CC >=2.1.186 renders the spinner's token count through the jsx() runtime, so
 * the `key:"tokens"` prop the older patterns anchored on became a positional
 * key argument and the children are inlined:
 *
 * ```
 * Ae=yd(ve),...,jsxs(h,{dimColor:!0,children:[Ae," tokens"]})]},"tokens")
 * ```
 *
 * Anchor on the surviving key literal first and only then search a bounded
 * window backwards for the formatter call. Running the whole shape as one
 * regex over the 21MB bundle is both slow and prone to false starts, since
 * `VAR=FUNC(` matches at millions of offsets.
 */
const matchJsxRuntimeShape = (
  oldFile: string,
  simpleExpression: string
): SpliceParts | null => {
  const anchor = oldFile.match(
    /children:\[([$\w]+)," tokens"\][^]{0,80}?,"tokens"\)/
  );
  if (!anchor || anchor.index === undefined) return null;

  const escapedVar = anchor[1].replace(/\$/g, '\\$');
  const regionStart = Math.max(0, anchor.index - 4000);
  const region = oldFile.slice(regionStart, anchor.index + anchor[0].length);

  // The count variable is assigned once in a minified `let` chain, but anchor on
  // the last assignment before the render so a re-binding can never be wrapped.
  const starts = [
    ...region.matchAll(new RegExp(`(?<![$\\w])${escapedVar}=[$\\w]+\\(`, 'g')),
  ];
  const shape = new RegExp(
    `(${escapedVar}=[$\\w]+\\()(${simpleExpression})` +
      `(\\)[^]{0,4000}?children:\\[${escapedVar}," tokens"\\])`,
    'y'
  );

  let m: RegExpExecArray | null = null;
  for (const start of starts.reverse()) {
    shape.lastIndex = start.index;
    m = shape.exec(region);
    if (m) break;
  }
  if (!m) return null;

  return {
    fullMatch: m[0],
    pre: m[1],
    partToWrap: m[2],
    post: m[3],
    startIndex: regionStart + m.index,
  };
};

/**
 * CC >=2.1.257 hoisted the spinner state (including the formatted token
 * count) into a helper that returns an object, which the render function
 * then destructures under a *different* local name:
 *
 * ```
 * function Co(...){...,Pt=Qo(ut),...;return{...,tokenCount:Pt,...}}
 * function Wo(...){let{...,tokenCount:ue,...}=Co(...),...;
 *   ...children:[ue," tokens"]...
 * ```
 *
 * The count variable no longer keeps the same name between its formatter
 * assignment (`Pt`) and its use at the render site (`ue`) — they're linked
 * only by the shared property key (`tokenCount`) at the return/destructure
 * boundary. Chase that link: anchor on the render var, find what property
 * it was destructured from, then find that property's producer assignment.
 */
const matchDestructuredJsxRuntimeShape = (
  oldFile: string,
  simpleExpression: string
): SpliceParts | null => {
  const anchor = oldFile.match(
    /children:\[([$\w]+)," tokens"\][^]{0,80}?,"tokens"\)/
  );
  if (!anchor || anchor.index === undefined) return null;

  const varName = anchor[1];
  const escapedVar = varName.replace(/\$/g, '\\$');
  const regionStart = Math.max(0, anchor.index - 6000);
  const region = oldFile.slice(regionStart, anchor.index + anchor[0].length);

  const destructureMatches = [
    ...region.matchAll(new RegExp(`([$\\w]+):${escapedVar}(?=[,}])`, 'g')),
  ];
  if (destructureMatches.length === 0) return null;
  const destructureMatch = destructureMatches[destructureMatches.length - 1];
  const propName = destructureMatch[1];
  const escapedProp = propName.replace(/\$/g, '\\$');
  const destructurePos = destructureMatch.index ?? 0;

  const producerMatches = [
    ...region
      .slice(0, destructurePos)
      .matchAll(new RegExp(`${escapedProp}:([$\\w]+)(?=[,}])`, 'g')),
  ].filter(pm => pm[1] !== varName);
  if (producerMatches.length === 0) return null;
  const producerMatch = producerMatches[producerMatches.length - 1];
  const localVar = producerMatch[1];
  const escapedLocal = localVar.replace(/\$/g, '\\$');
  const producerPos = producerMatch.index ?? 0;

  const assignMatches = [
    ...region
      .slice(0, producerPos)
      .matchAll(new RegExp(`(?<![$\\w])${escapedLocal}=[$\\w]+\\(`, 'g')),
  ];
  if (assignMatches.length === 0) return null;
  const assignStart = assignMatches[assignMatches.length - 1].index ?? 0;

  const shape = new RegExp(
    `(${escapedLocal}=[$\\w]+\\()(${simpleExpression})(\\))`,
    'y'
  );
  shape.lastIndex = assignStart;
  const m = shape.exec(region);
  if (!m) return null;

  return {
    fullMatch: m[0],
    pre: m[1],
    partToWrap: m[2],
    post: m[3],
    startIndex: regionStart + m.index,
  };
};

export const writeTokenCountRounding = (
  oldFile: string,
  roundingBaseConfig: number | { threshold?: number }
): string | null => {
  const roundingBase = getRoundingBase(roundingBaseConfig);
  let fullMatch: string;
  let pre: string;
  let partToWrap: string;
  let post: string;
  let startIndex: number;

  // Try multiple patterns for different CC versions.
  // Keep the expression match intentionally narrow. A broad `.+?` can cross
  // later comma-separated initializers and rewrite `M$=M9(aH),dH=...M$...` into
  // a TDZ crash where `M$` is referenced while initializing itself.
  const simpleExpression = '[$\\w]+(?:\\?\\.[$\\w]+)*(?:\\([^()]*\\))?';

  // Pattern -1 (CC >=2.1.257): the spinner state helper now returns an
  // object and the render site destructures the token count under a
  // different local name (see matchDestructuredJsxRuntimeShape above).
  const mNeg1 = matchDestructuredJsxRuntimeShape(oldFile, simpleExpression);

  // Pattern 0 (CC >=2.1.186): React's createElement->jsx() migration turned the
  // element key into a positional argument, so `key:"tokens"` is gone and the
  // children are inlined. Shape (verified 2.1.219 / 2.1.220):
  //   VAR=FUNC(EXPR),...jsxs(h,{dimColor:!0,children:[VAR," tokens"]})]},"tokens")
  const m0 = mNeg1 ?? matchJsxRuntimeShape(oldFile, simpleExpression);

  if (m0) {
    ({ fullMatch, pre, partToWrap, post, startIndex } = m0);
  } else {
    // Pattern 1 (CC >=2.1.83): Direct match on formatter call near key:"tokens"
    // Matches: VAR=FUNC(EXPR),...key:"tokens"...,VAR," tokens"
    const m1 = oldFile.match(
      new RegExp(
        `(([$\\w]+)=[$\\w]+\\()(${simpleExpression})(\\),.{0,2000}key:"tokens".{0,200},\\2," tokens")`
      )
    );

    if (m1 && m1.index !== undefined) {
      [fullMatch, pre, , partToWrap, post] = m1;
      startIndex = m1.index;
    } else {
      // Pattern 2 (CC <2.1.83): overrideMessage anchor nearby
      const m2 = oldFile.match(
        new RegExp(
          `(overrideMessage:.{0,10000},([$\\w]+)=[$\\w]+\\()(${simpleExpression})(\\),.{0,1000}key:"tokens".{0,200},\\2," tokens")`
        )
      );

      if (m2 && m2.index !== undefined) {
        [fullMatch, pre, , partToWrap, post] = m2;
        startIndex = m2.index;
      } else {
        // Pattern 3 (CC 1.x): older format
        const m3 = oldFile.match(
          /(overrideMessage:.{0,10000},key:"tokens".{0,200}[$\w]+\()(Math\.round\(.+?\))(\))/
        );

        if (m3 && m3.index !== undefined) {
          [fullMatch, pre, partToWrap, post] = m3;
          startIndex = m3.index;
        } else {
          console.error(
            'patch: tokenCountRounding: cannot find token count pattern in any CC format'
          );
          return null;
        }
      }
    }
  }

  const replacement = `${pre}Math.round((${partToWrap})/${roundingBase})*${roundingBase}${post}`;
  const endIndex = startIndex + fullMatch.length;

  const newFile =
    oldFile.slice(0, startIndex) + replacement + oldFile.slice(endIndex);

  showDiff(oldFile, newFile, replacement, startIndex, endIndex);

  return newFile;
};
