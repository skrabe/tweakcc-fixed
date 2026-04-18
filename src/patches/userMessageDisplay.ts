// Please see the note about writing patches in ./index
import {
  findBoxComponent,
  findChalkVar,
  findTextComponent,
  showDiff,
} from './index';
import { UserMessageDisplayConfig } from '../types';

/**
 * CC 0.2.9:
 * ```diff
 *  function Cf2({ addMargin: I, param: { text: d } }) {
 *    let { columns: G } = G9();
 *    if (!d) return (X0("No content found in user prompt message"), null);
 *    return XU.default.createElement(
 *      p,
 *      { flexDirection: "row", marginTop: I ? 1 : 0, width: "100%" },
 * -    XU.default.createElement(
 * -      p,
 * -      { minWidth: 2, width: 2 },
 * -      XU.default.createElement(u, { color: r1().secondaryText }, ">"),
 * -    ),
 *      XU.default.createElement(
 *        p,
 *        { flexDirection: "column", width: G - 4 },
 *        XU.default.createElement(
 *          u,
 * -        { color: r1().secondaryText, wrap: "wrap" },
 * -        d,
 * +        null,
 * +        CHALK.styles.here(`${d}`)
 *        ),
 *      ),
 *    );
 *  }
 * ```
 *
 * CC 1.0.50
 * ```diff
 *  function vj2({ addMargin: A, param: { text: B } }) {
 *    let { columns: Q } = w9();
 *    if (!B)
 *      return (b1(new Error("No content found in user prompt message")), null);
 *    return ec.default.createElement(
 *      b,
 *      { flexDirection: "row", marginTop: A ? 1 : 0, width: "100%" },
 * -    ec.default.createElement(
 * -      b,
 * -      { minWidth: 2, width: 2 },
 * -      ec.default.createElement(S, { color: "secondaryText" }, ">"),
 * -    ),
 *      ec.default.createElement(
 *        b,
 *        { flexDirection: "column", width: Q - 4 },
 *        ec.default.createElement(
 *          S,
 * -        { color: "secondaryText", wrap: "wrap" },
 * -        B.trim(),
 * +        {},
 * +        CHALK_VAR.style1.style2(`format ${B.trim()}`),
 *        ),
 *      ),
 *    );
 *  }
 * ```
 *
 * CC 2.0.77
 * ```diff
 *  function an2({ addMargin: A, param: { text: Q }, thinkingMetadata: B }) {
 *    let { columns: G } = QB();
 *    if (!Q) return (r(Error("No content found in user prompt message")), null);
 *    let Z = Q.replace(GB7, "")
 *      .replace(ZB7, "")
 *      .replace(YB7, "")
 *      .replace(JB7, "")
 *      .trim();
 *    return uq0.default.createElement(
 *      T,
 *      { flexDirection: "column", marginTop: A ? 1 : 0, width: G - 4 },
 * -    uq0.default.createElement(in2, { text: Z, thinkingMetadata: B }),
 * +    uq0.default.createElement(BOX_COMP, {border:styles...}, uq0.default.createElement(TEXT_COMP, null, CHALK_VAR.style1.style2(`format ${Z}`))),
 *    );
 *  }
 * ```
 *
 * CC 2.1.21:
 * ```diff
 *  function H8K(A) {
 *    let K = s(7),
 *      { addMargin: q, param: Y, thinkingMetadata: z } = A,
 *      { text: w } = Y,
 *      { columns: H } = M8();
 *    if (!w) return (KA(Error("No content found in user prompt message")), null);
 *    let J = q ? 1 : 0,
 *      O = H - 4,
 *      X;
 *    if (K[0] !== w || K[1] !== z)
 * -    ((X = oR6.default.createElement(z8K, { text: w, thinkingMetadata: z })),
 * +    ((X = oR6.default.createElement(BOX_COMP, {border:styles...}, oR6.default.createElement(TEXT_COMP, null, CHALK_VAR.style1.style2(`format ${w}`))),
 *        (K[0] = w),
 *        (K[1] = z),
 *        (K[2] = X));
 *    else X = K[2];
 *    let $;
 *    if (K[3] !== J || K[4] !== O || K[5] !== X)
 *      (($ = oR6.default.createElement(
 *        I,
 *        { flexDirection: "column", marginTop: J, width: O },
 *        X,
 *      )),
 *        (K[3] = J),
 *        (K[4] = O),
 *        (K[5] = X),
 *        (K[6] = $));
 *    else $ = K[6];
 *    return $;
 *  }
 *  ```
 *
 * CC 2.1.79+ (attribute-preserving surgery — this path):
 *
 * CC hoisted the long-message collapse into the caller via useMemo and now
 * renders the user message as:
 *
 *     createElement(Box, {flexDirection:"column", marginTop:q?1:0,
 *                         backgroundColor: j?"messageActionsBackground"
 *                                            :w?void 0:"userMessageBackground",
 *                         paddingRight: w?0:1},
 *       createElement(EjK, {text:$, useBriefLayout:w, timestamp:...}))
 *
 * where `$` is either the raw text (string) or `{head,hiddenLines,tail}` for
 * messages > ~10,000 chars (typical for pasted blocks).
 *
 * The prior version of this patch REPLACED the whole outer Box+EjK with its
 * own Box+Text, which:
 *   - dropped `flexDirection:"column"` (Box defaulted to row), breaking
 *     width inheritance from the row-flex parent that wraps user messages,
 *     so the Box only painted its bg to the content width of line 1 — line 2
 *     of a wrapped message rendered against the terminal default bg.
 *   - dropped `marginTop` (minor cosmetic).
 *   - collapsed CC's context-aware `backgroundColor` ternary (message-actions
 *     mode uses a different theme token) to a static value.
 *   - lost CC's native `EjK` collapse rendering for long pastes (and produced
 *     `[object Object]` when naively interpolating the object variant).
 *
 * The new approach is ATTRIBUTE-PRESERVING: we keep the outer
 *   createElement(Box, ORIGINAL_ATTRS, INNER)
 * call and only MUTATE its attrs dict — specifically, we STRIP CC's
 * `backgroundColor` attr when the user picks "none" (null) or a custom rgb,
 * and leave it alone for "default" (so CC's native theme-token /
 * messageActionsBackground ternary keeps working). We never replace the Box
 * bg with a custom rgb literal: Ink paints Box `backgroundColor` across the
 * full Box width (which, with preserved flexDirection:"column", is the full
 * parent width), so putting the user's color there floods the ENTIRE
 * user-message rectangle — the "bg fills the whole message display" symptom.
 * Instead, the custom bg rides on the INNER Text's `backgroundColor` prop,
 * which Ink re-applies per character — including on every wrapped line,
 * which is the wrap-line-bg fix 9ef9328 was originally about. Border,
 * padding, and alignSelf overrides still append to the Box attrs CSV.
 * We also replace the inner EjK call with our own Text element so we can
 * apply the format string and per-text styling using Ink props rather than
 * chalk ANSI inside the text content (chalk's bg escape codes don't reliably
 * re-open on line 2 after Ink word-wraps; Ink's Text bg prop does).
 */

export const writeUserMessageDisplay = (
  oldFile: string,
  config: UserMessageDisplayConfig
): string | null => {
  const textComponent = findTextComponent(oldFile);
  if (!textComponent) {
    console.error('patch: userMessageDisplay: failed to find Text component');
    return null;
  }

  const boxComponent = findBoxComponent(oldFile);
  if (!boxComponent) {
    console.error('patch: userMessageDisplay: failed to find Box component');
    return null;
  }

  const chalkVar = findChalkVar(oldFile);
  if (!chalkVar) {
    console.error('patch: userMessageDisplay: failed to find chalk variable');
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Legacy pattern (CC ≤2.1.21): outer Box + optional ">" subcomponent +
  // inner Box wrapping a Text that directly receives the message string.
  // The replacement swaps the entire thing for our own Box+Text tree.
  // ────────────────────────────────────────────────────────────────────────
  const legacyPattern =
    /(No content found in user prompt message.{0,250}?\b)([$\w]+(?:\.default)?\.createElement.{0,30}\b[$\w]+(?:\.default)?\.createElement.{0,40}">.+?)?(([$\w]+(?:\.default)?\.createElement).{0,200})(\([$\w]+,(?:\{[^{}]+wrap:"wrap"\},([$\w]+)(?:\.trim\(\))?\)\)|\{text:([$\w]+)[^}]*\}\)\)?))/;

  // ────────────────────────────────────────────────────────────────────────
  // Modern pattern (CC ≥2.1.79): single outer Box wrapping a subcomponent
  // call shaped like `createElement(EjK, {text:$, ...})`. We capture the
  // Box's attrs dict as a whole so we can preserve CC's layout attributes
  // (flexDirection, marginTop, etc.) and only mutate the specific ones the
  // user is customizing. `\{[^{}]*\}` matches a flat object literal — no
  // nested braces observed in CC's native Box attrs for this function.
  // ────────────────────────────────────────────────────────────────────────
  const modernPattern =
    /(No content found in user prompt message[\s\S]{0,100}?;return )([$\w]+(?:\.default)?)\.createElement\(([$\w]+),(\{flexDirection:"column"[^{}]*\}),([$\w]+(?:\.default)?)\.createElement\(([$\w]+),\{text:([$\w]+)[^{}]*\}\)\)/;

  // Try the modern (attribute-preserving) pattern first — the legacy
  // pattern's `{text:VAR}` alternative ALSO matches CC 2.1.79+ shapes, so if
  // we checked legacy first the modern path would never run. Fall back to
  // legacy only when the modern pattern doesn't apply.
  const modernMatch = oldFile.match(modernPattern);
  const legacyMatch = modernMatch ? null : oldFile.match(legacyPattern);

  if (!modernMatch && (!legacyMatch || legacyMatch.index === undefined)) {
    console.error(
      'patch: userMessageDisplay: failed to find user message display pattern'
    );
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Shared: build the message expression that flattens the CC ≥2.1.79
  // head/tail object variant to a string, mirroring EjK/kjK's native output
  // for long pastes. For a plain-string message var (older CC, or short
  // messages on new CC) the ternary falls through to the variable as-is.
  //
  // The emitted expression contains a "$&&" sequence — String.prototype
  // .replace treats "$&" in a _string_ replacement as the matched substring,
  // so the `replace(/\{\}/g, ...)` call that splices this into the format
  // string MUST use a function replacer to bypass $-substitution. (Function
  // replacers also cover $', $`, $n, $<name>, so any future additions are
  // safe.)
  // ────────────────────────────────────────────────────────────────────────
  const buildUnwrappedMessageExpr = (messageVar: string): string =>
    `(typeof ${messageVar}==="object"&&${messageVar}!==null?` +
    `${messageVar}.head+"\\n("+${messageVar}.hiddenLines+" line"+` +
    `(${messageVar}.hiddenLines===1?"":"s")+" hidden)\\n"+${messageVar}.tail:` +
    `${messageVar})`;

  if (modernMatch) {
    // ──────────────────────────────────────────────────────────────────────
    // Modern path: preserve CC's Box attrs, surgically mutate what we need,
    // and replace the inner subcomponent with our own styled Text.
    // ──────────────────────────────────────────────────────────────────────
    const prefix = modernMatch[1]; // "No content found...;return "
    const reactModule = modernMatch[2]; // e.g. "b96.default"
    const originalBoxCompVar = modernMatch[3]; // e.g. "u" (local alias)
    const originalBoxAttrs = modernMatch[4]; // {flexDirection:"column",...}
    const innerReactModule = modernMatch[5]; // usually same as reactModule
    const messageVar = modernMatch[7]; // the text prop var ($)

    // Mutate the Box attrs dict. Peel the surrounding braces so we can
    // slice/splice the CSV attr list, then re-wrap at the end.
    let mutableBoxAttrs = originalBoxAttrs.slice(1, -1); // strip `{` and `}`

    // `backgroundColor:` in CC's native attrs is a nested ternary:
    //   j?"messageActionsBackground":w?void 0:"userMessageBackground"
    // The value ends at the next top-level comma or the closing brace — no
    // commas appear _inside_ the ternary (identifiers, quoted strings, and
    // `void 0` only), so a non-greedy `[^,]+` run walks the whole value.
    const bgAttrRegex = /backgroundColor:[^,}]+(?:\?[^,}:]+:[^,}:]+)*/;

    if (config.backgroundColor !== 'default') {
      // null ("none") or custom rgb: strip CC's Box backgroundColor attr
      // entirely. Ink paints Box `backgroundColor` across the full Box width
      // (which, on this Box, is the full parent width inherited from the
      // row-flex message-list parent via the preserved flexDirection:"column"
      // + paddingRight attrs). Leaving a custom rgb on the Box would fill the
      // ENTIRE user-message rectangle with the user's color — the symptom
      // users report as "the bg fills the whole message display instead of
      // just the text." The inner Text's backgroundColor prop (set below)
      // handles per-character bg, and Ink's layout pass re-applies the bg
      // ANSI on every wrapped line, so we don't need Box bg to cover line 2+
      // after word-wrap. (That per-wrapped-line Text bg was the whole reason
      // 9ef9328 switched this path from chalk-ANSI-in-string to Ink Text
      // props in the first place.)
      mutableBoxAttrs = mutableBoxAttrs
        .replace(new RegExp(`,?${bgAttrRegex.source}`), '')
        .replace(/^,|,$/g, '');
    }
    // 'default' case: leave CC's backgroundColor attr untouched so the
    // theme's userMessageBackground + messageActionsBackground ternary keeps
    // working in all contexts — this matches CC's native full-Box-fill look.

    // Append tweakcc's extras (border, extra padding, fit-to-content). Any
    // pre-existing paddingRight stays as-is unless the user explicitly sets
    // paddingX, in which case the user's paddingX takes precedence via
    // React's right-wins-duplicate-keys semantics.
    const extraBoxAttrs: string[] = [];

    if (config.borderStyle !== 'none') {
      const isCustomBorder = config.borderStyle.startsWith('topBottom');
      if (isCustomBorder) {
        let customBorder = '';
        if (config.borderStyle === 'topBottomSingle') {
          customBorder =
            '{top:"─",bottom:"─",left:" ",right:" ",topLeft:" ",topRight:" ",bottomLeft:" ",bottomRight:" "}';
        } else if (config.borderStyle === 'topBottomDouble') {
          customBorder =
            '{top:"═",bottom:"═",left:" ",right:" ",topLeft:" ",topRight:" ",bottomLeft:" ",bottomRight:" "}';
        } else if (config.borderStyle === 'topBottomBold') {
          customBorder =
            '{top:"━",bottom:"━",left:" ",right:" ",topLeft:" ",topRight:" ",bottomLeft:" ",bottomRight:" "}';
        }
        extraBoxAttrs.push(`borderStyle:${customBorder}`);
      } else {
        extraBoxAttrs.push(`borderStyle:"${config.borderStyle}"`);
      }
      const borderDigits = config.borderColor.match(/\d+/g);
      if (borderDigits) {
        extraBoxAttrs.push(`borderColor:"rgb(${borderDigits.join(',')})"`);
      }
    }

    if (config.paddingX !== 'default' && config.paddingX > 0) {
      extraBoxAttrs.push(`paddingX:${config.paddingX}`);
    }
    if (config.paddingY !== 'default' && config.paddingY > 0) {
      extraBoxAttrs.push(`paddingY:${config.paddingY}`);
    }
    if (config.fitBoxToContent) {
      extraBoxAttrs.push(`alignSelf:"flex-start"`);
    }

    if (extraBoxAttrs.length > 0) {
      mutableBoxAttrs = mutableBoxAttrs
        ? `${mutableBoxAttrs},${extraBoxAttrs.join(',')}`
        : extraBoxAttrs.join(',');
    }

    const newBoxAttrs = `{${mutableBoxAttrs}}`;

    // Build the inner Text attrs. Unlike the legacy path, we prefer Ink's
    // native props (color/backgroundColor/bold/italic/underline/strikethrough/
    // inverse) over chalk ANSI for the message body: Ink's layout pass
    // paints bg/color on every wrapped line, whereas chalk's ANSI-in-string
    // bg codes don't reliably re-open on line 2 after Ink word-wraps.
    const textAttrs: string[] = [];

    if (config.foregroundColor === 'default') {
      textAttrs.push('color:"text"');
    } else {
      const fgDigits = config.foregroundColor.match(/\d+/g);
      if (fgDigits) {
        textAttrs.push(`color:"rgb(${fgDigits.join(',')})"`);
      }
    }

    if (
      config.backgroundColor !== 'default' &&
      config.backgroundColor !== null
    ) {
      const bgDigits = config.backgroundColor.match(/\d+/g);
      if (bgDigits) {
        textAttrs.push(`backgroundColor:"rgb(${bgDigits.join(',')})"`);
      }
    } else if (config.backgroundColor === 'default') {
      textAttrs.push('backgroundColor:"userMessageBackground"');
    }

    // Ink Text styling flags — minified `!0` == `true` matches the shape
    // CC's own minified code uses, though any truthy value would work.
    if (config.styling.includes('bold')) textAttrs.push('bold:!0');
    if (config.styling.includes('italic')) textAttrs.push('italic:!0');
    if (config.styling.includes('underline')) textAttrs.push('underline:!0');
    if (config.styling.includes('strikethrough'))
      textAttrs.push('strikethrough:!0');
    if (config.styling.includes('inverse')) textAttrs.push('inverse:!0');

    const textAttrsObjStr =
      textAttrs.length > 0 ? `{${textAttrs.join(',')}}` : 'null';

    // Children: the format string (e.g. ` > {} `) with `{}` replaced by the
    // unwrapped-object ternary. Emitted as a plain template literal — no
    // chalk wrapping, so Ink's props are the sole carrier of color/style.
    const unwrappedMessageExpr = buildUnwrappedMessageExpr(messageVar);
    const formattedMessage =
      '`' +
      config.format.replace(/\{\}/g, () => '${' + unwrappedMessageExpr + '}') +
      '`';

    const replacement =
      prefix +
      `${reactModule}.createElement(${originalBoxCompVar},${newBoxAttrs},` +
      `${innerReactModule}.createElement(${textComponent},${textAttrsObjStr},${formattedMessage}))`;

    const startIndex = modernMatch.index!;
    const endIndex = startIndex + modernMatch[0].length;
    const newFile =
      oldFile.slice(0, startIndex) + replacement + oldFile.slice(endIndex);
    showDiff(oldFile, newFile, replacement, startIndex, endIndex);
    return newFile;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Legacy path (CC ≤2.1.21): preserve the prior behavior — replace the
  // whole matched tree with our own Box+Text+chalk. These CC versions
  // pass the raw text directly to an inner Text whose parent flex context
  // already works correctly, so the wrap-line bg bug that motivated the
  // modern-path rewrite doesn't apply here.
  // ────────────────────────────────────────────────────────────────────────
  const match = legacyMatch!;
  const createElementFn = match[4];
  const messageVar = match[6] ?? match[7];

  const boxAttrs: string[] = [];
  const isCustomBorder = config.borderStyle.startsWith('topBottom');

  if (config.borderStyle !== 'none') {
    if (isCustomBorder) {
      let customBorder = '';
      if (config.borderStyle === 'topBottomSingle') {
        customBorder =
          '{top:"─",bottom:"─",left:" ",right:" ",topLeft:" ",topRight:" ",bottomLeft:" ",bottomRight:" "}';
      } else if (config.borderStyle === 'topBottomDouble') {
        customBorder =
          '{top:"═",bottom:"═",left:" ",right:" ",topLeft:" ",topRight:" ",bottomLeft:" ",bottomRight:" "}';
      } else if (config.borderStyle === 'topBottomBold') {
        customBorder =
          '{top:"━",bottom:"━",left:" ",right:" ",topLeft:" ",topRight:" ",bottomLeft:" ",bottomRight:" "}';
      }
      boxAttrs.push(`borderStyle:${customBorder}`);
    } else {
      boxAttrs.push(`borderStyle:"${config.borderStyle}"`);
    }
    const borderMatch = config.borderColor.match(/\d+/g);
    if (borderMatch) {
      boxAttrs.push(`borderColor:"rgb(${borderMatch.join(',')})"`);
    }
  }

  if (config.paddingX === 'default') {
    boxAttrs.push('paddingRight:1');
  } else if (config.paddingX > 0) {
    boxAttrs.push(`paddingX:${config.paddingX}`);
  }
  if (config.paddingY !== 'default' && config.paddingY > 0) {
    boxAttrs.push(`paddingY:${config.paddingY}`);
  }
  if (config.fitBoxToContent) {
    boxAttrs.push(`alignSelf:"flex-start"`);
  }

  let chalkChain = chalkVar;
  const textAttrs: string[] = [];

  if (config.foregroundColor !== 'default') {
    const fgMatch = config.foregroundColor.match(/\d+/g);
    if (fgMatch) {
      chalkChain += `.rgb(${fgMatch.join(',')})`;
    }
  } else {
    textAttrs.push('color:"text"');
  }

  if (config.backgroundColor !== 'default' && config.backgroundColor !== null) {
    const bgMatch = config.backgroundColor.match(/\d+/g);
    if (bgMatch) {
      chalkChain += `.bgRgb(${bgMatch.join(',')})`;
      const inkBg = `"rgb(${bgMatch.join(',')})"`;
      boxAttrs.push(`backgroundColor:${inkBg}`);
      textAttrs.push(`backgroundColor:${inkBg}`);
    }
  } else if (config.backgroundColor === 'default') {
    boxAttrs.push('backgroundColor:"userMessageBackground"');
    textAttrs.push('backgroundColor:"userMessageBackground"');
  }

  if (config.styling.includes('bold')) chalkChain += '.bold';
  if (config.styling.includes('italic')) chalkChain += '.italic';
  if (config.styling.includes('underline')) chalkChain += '.underline';
  if (config.styling.includes('strikethrough')) chalkChain += '.strikethrough';
  if (config.styling.includes('inverse')) chalkChain += '.inverse';

  const unwrappedMessageExpr = buildUnwrappedMessageExpr(messageVar);
  const formattedMessage =
    '`' +
    config.format.replace(/\{\}/g, () => '${' + unwrappedMessageExpr + '}') +
    '`';
  const chalkFormattedString = `${chalkChain}(${formattedMessage})`;

  const boxAttrsObjStr =
    boxAttrs.length > 0 ? `{${boxAttrs.join(',')}}` : 'null';
  const textAttrsObjStr =
    textAttrs.length > 0 ? `{${textAttrs.join(',')}}` : 'null';

  const replacement =
    match[1] +
    `${createElementFn}(${boxComponent},${boxAttrsObjStr},${createElementFn}(${textComponent},${textAttrsObjStr},${chalkFormattedString}))`;

  const startIndex = match.index!;
  const endIndex = startIndex + match[0].length;
  const newFile =
    oldFile.slice(0, startIndex) + replacement + oldFile.slice(endIndex);
  showDiff(oldFile, newFile, replacement, startIndex, endIndex);
  return newFile;
};
