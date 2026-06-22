// Please see the note about writing patches in ./index
import {
  findBoxComponent,
  findChalkVar,
  findTextComponent,
  showDiff,
} from './index';
import { UserMessageDisplayConfig } from '../types';
import { escapeNonAscii } from '../utils';

/**
 * Escape a user-supplied string before splicing it into a backtick template
 * literal in cli.js. A stray backtick would terminate the literal (corrupting
 * the binary — the "function wrapper" error class), and a `${…}` would inject an
 * executable expression into Claude Code's runtime. `config.format` can arrive
 * from an untrusted `--config-url`, so this MUST run before the `{}`→`${msg}`
 * splice (which adds the one intended interpolation).
 *
 * Exported for testing.
 */
export const escapeForTemplateLiteral = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

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
 * call and only MUTATE the attrs we need. Specifically, for `backgroundColor`
 * we do the MINIMAL swap that matches what users want:
 *   - `'default'`: leave CC's ternary untouched — native behavior in every
 *     mode (normal / message-actions / brief-layout).
 *   - custom rgb: inside the ternary, swap ONLY the `"userMessageBackground"`
 *     string literal for the user's `"rgb(r,g,b)"`. `"messageActionsBackground"`
 *     and `void 0` stay intact, so the user's color only tints the normal
 *     user-message case (matching CC native's extent — a full-row rectangle
 *     — just re-tinted).
 *   - `null` ("none"): strip the whole backgroundColor attr so no rectangle
 *     paints.
 *
 * Why not "just put bg on the inner Text and strip the Box bg"? Ink has two
 * bg mechanisms with very different semantics:
 *   - Box bg is painted by renderBackground.js as bg-colored spaces across
 *     the FULL Box rectangle (contentWidth × contentHeight). This is the
 *     "highlight rectangle" users see on CC native.
 *   - Text bg rides on the chalk-wrapped content and ends up as styles on
 *     the individual char cells via output.js's styled-char grid.
 * If Box bg is set and Text bg is NOT, Ink's renderBackground paints the
 * row first and then the child text-write OVERWRITES those cells with
 * bg-less chars (see output.js cell-overwrite semantics) — you get a row
 * rectangle with "holes" where the text is. And if only Text bg is set, you
 * get ANSI bg only behind rendered glyphs — no full-row highlight at all.
 * So for a continuous highlight matching CC's native extent, BOTH Box bg
 * AND Text bg must carry the same color. That's what this patch does.
 *
 * The inner EjK call is replaced with our own Text element so we can apply
 * the format string and per-text styling using Ink props.
 *
 * Border, padding, and alignSelf overrides append to the Box attrs CSV.
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

  // ────────────────────────────────────────────────────────────────────────
  // JSX-runtime pattern (CC ≥2.1.186): CC's UI bundle switched from
  // `React.createElement(...)` to the automatic JSX runtime (`MOD.jsx(comp,
  // {…,children:…})` / `.jsxs`). `MOD` here is `react/jsx-runtime`'s interop
  // object, which exposes `.jsx`/`.jsxs` but NOT `.createElement` — so the
  // rewrite below MUST emit `.jsx(...)` (an emitted `.createElement` would be
  // `undefined` at runtime and crash the user-message render).
  //
  // The render is split across two React-compiler memo blocks: the child
  //   `T=MOD.jsx(child,{text:MSG,useBriefLayout:…,timestamp:…})`
  // and the parent Box
  //   `…;return …)y=MOD.jsx(BOX,{flexDirection:"column",marginTop:…,
  //                             backgroundColor:BGVAR,paddingRight:…,children:T})`
  // where the bg ternary is now hoisted into a local var (`BGVAR`, e.g.
  // `d?void 0:"userMessageBackground"`) instead of being inline in the attrs.
  //
  // We take the documented attribute-preserving approach on the PARENT Box —
  // capture its attrs CSV (keeping flexDirection/marginTop so wrap-width and
  // layout are preserved), surgically mutate only the bg attr, append our
  // extras, and swap `children:T` for our own styled Text element. The leftover
  // `T=` child memo assignment becomes an unused (but harmless) computation.
  //
  // Captures: 1=prefix through `…MOD.jsx(BOX,`, 2=message var (from the child's
  // `text:MSG`), 3=Box attrs (leading `{`, no trailing `}`), 4=`,children:`,
  // 5=child var (discarded), 6=`})`.
  // ────────────────────────────────────────────────────────────────────────
  const jsxRuntimePattern =
    /(No content found in user prompt message[\s\S]{0,400}?\.jsx\([$\w]+,\{text:([$\w]+),useBriefLayout:[$\w]+,timestamp:[$\w]+\}\)[\s\S]{0,200}?([$\w]+)\.jsx\([$\w]+,)(\{flexDirection:"column"[^{}]*?)(,children:)([$\w]+)(\}\))/;

  // The JSX-runtime shape wins when present; it never matches createElement-era
  // binaries (it requires `.jsx(…)` and a `children:` prop), so older versions
  // fall through to the patterns below at zero cost.
  const jsxRuntimeMatch = oldFile.match(jsxRuntimePattern);

  // Try the modern (attribute-preserving) pattern next — the legacy
  // pattern's `{text:VAR}` alternative ALSO matches CC 2.1.79+ shapes, so if
  // we checked legacy first the modern path would never run.
  const modernMatch = jsxRuntimeMatch ? null : oldFile.match(modernPattern);

  // CC ≥2.1.138: the child display is memoized (`VAR=createElement(child,{text,
  // useBriefLayout,timestamp})`) before the parent Box call. Rewrite only that
  // child assignment so React-compiler cache bookkeeping stays intact. Preferred
  // over the broad legacy tree-replacement (whose `{text:VAR}` alternative also
  // matches this shape) when present.
  const memoizedChildPattern =
    /(No content found in user prompt message.{0,1200}?)([$\w]+)=([$\w]+(?:\.default)?\.createElement)\([$\w]+,\{text:([$\w]+),useBriefLayout:[$\w]+,timestamp:[$\w]+\}\)/;
  const memoizedChildMatch =
    jsxRuntimeMatch || modernMatch ? null : oldFile.match(memoizedChildPattern);

  // Fall back to legacy only when no newer shape applies.
  const legacyMatch =
    jsxRuntimeMatch || modernMatch || memoizedChildMatch
      ? null
      : oldFile.match(legacyPattern);

  if (
    !jsxRuntimeMatch &&
    !modernMatch &&
    (!memoizedChildMatch || memoizedChildMatch.index === undefined) &&
    (!legacyMatch || legacyMatch.index === undefined)
  ) {
    console.error(
      'patch: userMessageDisplay: failed to find user message display pattern'
    );
    return oldFile;
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

  if (jsxRuntimeMatch) {
    // ──────────────────────────────────────────────────────────────────────
    // JSX-runtime path (CC ≥2.1.186): attribute-preserving rewrite of the
    // PARENT Box's `MOD.jsx(BOX,{…,children:CHILD})` call, mirroring the
    // modern path's semantics but emitting `.jsx(...)` (the runtime module
    // has no `.createElement`) and passing children as a `children:` prop.
    // ──────────────────────────────────────────────────────────────────────
    const prefix = jsxRuntimeMatch[1]; // …;return …)y=MOD.jsx(BOX,
    const messageVar = jsxRuntimeMatch[2]; // the child's text prop var (m)
    const jsxModule = jsxRuntimeMatch[3]; // react/jsx-runtime interop (Jpo)
    const originalBoxAttrs = jsxRuntimeMatch[4]; // {flexDirection:"column",…
    const childrenKeyword = jsxRuntimeMatch[5]; // ,children:
    // jsxRuntimeMatch[6] is the original child var (e.g. T) — discarded; we
    // splice our own Text element in its place.

    // The captured Box attrs have a leading `{` but NO trailing `}` (the
    // closing brace lives in capture group 6, `})`, which we re-emit at the
    // end after appending `children:`). Peel the leading `{` to edit the CSV.
    let mutableBoxAttrs = originalBoxAttrs.slice(1);

    // Unlike the 2.1.79 modern shape, the bg ternary is hoisted into a local
    // var, so the native attr is `backgroundColor:IDENT` (a bare identifier
    // value) rather than an inline `j?…:…` ternary.
    const bgAttrRegex = /backgroundColor:[$\w]+/;

    if (config.backgroundColor === null) {
      // "none": drop the whole backgroundColor attr (and its leading comma)
      // so no rectangle paints; the Text bg is also omitted below.
      mutableBoxAttrs = mutableBoxAttrs
        .replace(new RegExp(`,?${bgAttrRegex.source}`), '')
        .replace(/^,|,$/g, '');
    } else if (config.backgroundColor !== 'default') {
      // Custom rgb: replace `backgroundColor:IDENT` with the user's rgb
      // literal. (The hoisted var folded CC's mode ternary, so this tints
      // every mode — matching the legacy path's flat-bg behavior.)
      const bgDigits = config.backgroundColor.match(/\d+/g);
      if (bgDigits) {
        const bgLiteral = `backgroundColor:"rgb(${bgDigits.join(',')})"`;
        mutableBoxAttrs = bgAttrRegex.test(mutableBoxAttrs)
          ? mutableBoxAttrs.replace(bgAttrRegex, bgLiteral)
          : mutableBoxAttrs
            ? `${mutableBoxAttrs},${bgLiteral}`
            : bgLiteral;
      }
    }
    // 'default': leave `backgroundColor:IDENT` untouched (native theme).

    // Append tweakcc's extras (border, extra padding, fit-to-content) — same
    // logic and ordering as the modern path.
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
        extraBoxAttrs.push(`borderStyle:${escapeNonAscii(customBorder)}`);
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

    // Build the inner Text attrs (Ink native props — same as the modern path).
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

    if (config.styling.includes('bold')) textAttrs.push('bold:!0');
    if (config.styling.includes('italic')) textAttrs.push('italic:!0');
    if (config.styling.includes('underline')) textAttrs.push('underline:!0');
    if (config.styling.includes('strikethrough'))
      textAttrs.push('strikethrough:!0');
    if (config.styling.includes('inverse')) textAttrs.push('inverse:!0');

    // JSX runtime passes children as a prop, so the Text element is one object
    // literal: `{<textAttrs>,children:<formatted>}` (or just `{children:…}`).
    const textAttrsPrefix =
      textAttrs.length > 0 ? `${textAttrs.join(',')},` : '';

    const unwrappedMessageExpr = buildUnwrappedMessageExpr(messageVar);
    const formattedMessage =
      '`' +
      escapeForTemplateLiteral(config.format).replace(
        /\{\}/g,
        () => '${' + unwrappedMessageExpr + '}'
      ) +
      '`';

    const innerText =
      `${jsxModule}.jsx(${textComponent},` +
      `{${textAttrsPrefix}children:${formattedMessage}})`;

    // prefix already ends at `…MOD.jsx(BOX,`; mutableBoxAttrs still carries the
    // leading `{` and no closing brace, so we re-emit `children:` then the
    // child, then the captured `})` that closes the props object + jsx call.
    const replacement =
      prefix + `{${mutableBoxAttrs}` + childrenKeyword + innerText + '})';

    const startIndex = jsxRuntimeMatch.index!;
    const endIndex = startIndex + jsxRuntimeMatch[0].length;
    const newFile =
      oldFile.slice(0, startIndex) + replacement + oldFile.slice(endIndex);
    showDiff(oldFile, newFile, replacement, startIndex, endIndex);
    return newFile;
  }

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

    if (config.backgroundColor === null) {
      // "none": fully strip the Box backgroundColor attr so no rectangle
      // paints behind the message at all. Text bg is also omitted below, so
      // the row just renders against the terminal default bg.
      mutableBoxAttrs = mutableBoxAttrs
        .replace(new RegExp(`,?${bgAttrRegex.source}`), '')
        .replace(/^,|,$/g, '');
    } else if (config.backgroundColor !== 'default') {
      // Custom rgb: MINIMAL swap — replace only the "userMessageBackground"
      // string literal inside CC's native ternary with the user's rgb
      // literal. The `j` (message-actions mode) and `w` (brief-layout)
      // branches stay untouched, so CC's native behavior is preserved
      // byte-for-byte in those modes. In the normal user-message case the
      // Box paints a full-row rectangle with the user's color (same extent
      // as native), and the Text bg below carries the same rgb so glyph
      // cells don't punch holes in the rectangle (Ink's render pipeline
      // writes Box bg first then overwrites text cells — if Text has no bg,
      // text cells appear bg-less against an otherwise-filled row).
      //
      // This approach was chosen over "strip Box bg, Text-bg only" because
      // Text bg alone only paints behind rendered glyphs (Ink's Text bg
      // lives in chalk-wrapped content, not in renderBackground's
      // full-rectangle paint). That produced "no visible highlight" for
      // users who expected CC's native extent — which is a full row.
      const bgDigits = config.backgroundColor.match(/\d+/g);
      if (bgDigits) {
        const rgbLiteral = `"rgb(${bgDigits.join(',')})"`;
        mutableBoxAttrs = mutableBoxAttrs.replace(
          /"userMessageBackground"/g,
          rgbLiteral
        );
      }
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
        // \uXXXX-escape the box-drawing glyphs (─ ═ ━) so they survive CC's
        // Latin-1 module storage instead of mojibaking the border on Bun CC.
        extraBoxAttrs.push(`borderStyle:${escapeNonAscii(customBorder)}`);
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
      escapeForTemplateLiteral(config.format).replace(
        /\{\}/g,
        () => '${' + unwrappedMessageExpr + '}'
      ) +
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
  // Non-modern path: handles the memoized-child shape (CC ≥2.1.138, where the
  // display is `VAR=createElement(child,{text,…})`) and the legacy tree
  // (CC ≤2.1.21). Both replace the matched display with our own Box+Text+chalk.
  // The memoized branch re-emits the `VAR=` assignment (see replacementPrefix
  // below) so React-compiler cache bookkeeping stays intact.
  // ────────────────────────────────────────────────────────────────────────
  if (!boxComponent) {
    console.error('patch: userMessageDisplay: failed to find Box component');
    return null;
  }
  const match = (memoizedChildMatch ?? legacyMatch)!;
  const createElementFn = memoizedChildMatch
    ? memoizedChildMatch[3]
    : legacyMatch![4];
  const messageVar = memoizedChildMatch
    ? memoizedChildMatch[4]
    : (legacyMatch![6] ?? legacyMatch![7]);

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
      boxAttrs.push(`borderStyle:${escapeNonAscii(customBorder)}`);
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
    escapeForTemplateLiteral(config.format).replace(
      /\{\}/g,
      () => '${' + unwrappedMessageExpr + '}'
    ) +
    '`';
  const chalkFormattedString = `${chalkChain}(${formattedMessage})`;

  const boxAttrsObjStr =
    boxAttrs.length > 0 ? `{${boxAttrs.join(',')}}` : 'null';
  const textAttrsObjStr =
    textAttrs.length > 0 ? `{${textAttrs.join(',')}}` : 'null';

  // For the memoized-child shape, re-emit the `VAR=` assignment so the React-
  // compiler cache slot still receives our replacement tree; empty otherwise.
  const replacementPrefix = memoizedChildMatch
    ? `${memoizedChildMatch[2]}=`
    : '';

  const replacement =
    match[1] +
    `${replacementPrefix}${createElementFn}(${boxComponent},${boxAttrsObjStr},${createElementFn}(${textComponent},${textAttrsObjStr},${chalkFormattedString}))`;

  const startIndex = match.index!;
  const endIndex = startIndex + match[0].length;
  const newFile =
    oldFile.slice(0, startIndex) + replacement + oldFile.slice(endIndex);
  showDiff(oldFile, newFile, replacement, startIndex, endIndex);
  return newFile;
};
