// Please see the note about writing patches in ./index
//
// Custom output styles never get their per-turn reminder. Built-in ones do.
//
// CC emits one <system-reminder> per turn saying which output style is active.
// The renderer looks the style up in the built-in table and bails when it is
// missing:
//
//   output_style:(e)=>{let t=xve[e.style];if(!t)return[];
//     return vg([bn({content:`${t.name} output style is active. ${
//       e.turnReminder??"Remember to follow the specific guidelines for this style."
//     }`,isMeta:!0})])}
//
// `xve` holds only Proactive, Explanatory, Learning and the default. Custom
// styles are merged into a COPY of it (`let n={...xve}`) during style loading,
// so the original table never learns about them. CC's own telemetry knows the
// difference: `t in xve ? "…outputStyle:"+t : "…outputStyle:custom"`.
//
// Net effect: select a built-in style and the model is reminded of it every
// turn. Write your own and the style text is injected once into the system
// prompt and never restated. That is the weaker of the two positions, and the
// per-turn slot is the one Anthropic's own guidance points at for tone: a short
// reminder near the end of a long system prompt is their measured remedy for
// Opus 5's length, worth about a 20% reduction.
//
// So: fall back to the style's own name instead of bailing, and supply a
// default reminder for styles that do not carry a turnReminder of their own.
//
// The wording is a positive instruction with its purpose attached rather than a
// prohibition. The Opus 5 system card is specific about why: the model reads
// bare scoped prohibitions as conditional and reasons past them (pp.82-83,
// p.87), and "ignoring explicit constraints" is the second-highest behavioral
// negative in the audit, regressed against 4.8 (p.94). A rule that says what to
// do survives that; a rule that says what not to do invites the negotiation.

import { showDiff } from './index';

// The default only renders for a style that does not define its own
// turnReminder. Kept to one sentence: this text is paid for on every single
// turn, and the card's remedy is a short reminder, not another rulebook.
const FALLBACK =
  'Write this reply the way that style describes, including its rules on what to leave out.';

// A custom style can now carry its own reminder in frontmatter
// (`turn-reminder:`), the same way built-ins carry `turnReminder` in their
// table entry. Stock CC drops the key twice on the way to the renderer: the
// custom-style loader rebuilds each entry as {name, description, prompt,
// source, baseDir, keepCodingInstructions}, and the merge into the style table
// rebuilds it again with the same fields plus forceForPlugin. Both rebuilds are
// threaded here. The frontmatter validator only telemetry-logs unknown keys
// (safeParse, never a throw), so the extra key is safe, and the markdown
// parser's normalizeKeys means the key may arrive kebab-case, camelCase or
// lowercased — all three spellings are read.
const threadCustomStyleTurnReminder = (file: string): string => {
  let out = file;

  const loaderReturn =
    /\(\{filePath:([$\w]+),frontmatter:([$\w]+),content:([$\w]+),source:([$\w]+),baseDir:([$\w]+)\}\)=>\{([\s\S]{0,800}?)return\{name:([$\w]+),description:([$\w]+),prompt:\3\.trim\(\),source:\4,baseDir:\5,keepCodingInstructions:([$\w]+)\}/;
  const loader = out.match(loaderReturn);
  if (loader && loader.index !== undefined) {
    const fm = loader[2];
    const insert =
      `,turnReminder:typeof ${fm}["turn-reminder"]==="string"?${fm}["turn-reminder"]` +
      `:typeof ${fm}.turnReminder==="string"?${fm}.turnReminder` +
      `:typeof ${fm}.turnreminder==="string"?${fm}.turnreminder:void 0`;
    const end = loader.index + loader[0].length;
    out = out.slice(0, end - 1) + insert + out.slice(end - 1);
  } else if (!out.includes('turnReminder:typeof')) {
    console.error(
      'patch: outputStyleTurnReminder: custom-style loader shape not found; frontmatter turn-reminder will not thread (fallback reminder still applies)'
    );
  }

  const mergeEntry =
    /([$\w]+)\[([$\w]+)\.name\]=\{name:\2\.name,description:\2\.description,prompt:\2\.prompt,source:\2\.source,keepCodingInstructions:\2\.keepCodingInstructions,forceForPlugin:\2\.forceForPlugin\}/;
  const merge = out.match(mergeEntry);
  if (merge && merge.index !== undefined) {
    const u = merge[2];
    const end = merge.index + merge[0].length;
    out =
      out.slice(0, end - 1) +
      `,turnReminder:${u}.turnReminder` +
      out.slice(end - 1);
  } else if (!/forceForPlugin:[$\w]+\.forceForPlugin,turnReminder:/.test(out)) {
    console.error(
      'patch: outputStyleTurnReminder: style-table merge shape not found; frontmatter turn-reminder will not thread (fallback reminder still applies)'
    );
  }

  return out;
};

export const writeOutputStyleTurnReminder = (
  oldFile: string
): string | null => {
  // Anchor on the renderer's shape rather than on any minified name: the table,
  // the wrapper and the message builder all get renamed between CC builds.
  const pattern =
    /output_style:\(([$\w]+)\)=>\{let ([$\w]+)=([$\w]+)\[\1\.style\];if\(!\2\)return\[\];return ([$\w]+)\(\[([$\w]+)\(\{content:`\$\{\2\.name\} output style is active\. \$\{\1\.turnReminder\?\?"([^"]*)"\}`,isMeta:!0\}\)\]\)\}/;

  const match = oldFile.match(pattern);
  if (!match || match.index === undefined) {
    if (/\.style\}\.name\?\?|outputStyleName_tweakcc/.test(oldFile)) {
      console.log(
        'patch: outputStyleTurnReminder: renderer already patched — threading only'
      );
      return threadCustomStyleTurnReminder(oldFile);
    }
    // Verified on CC 2.1.238: Anthropic promoted the renderer half of this
    // patch. The table lookup and its `if(!t)return[]` bail are gone, replaced
    // by a type/emptiness guard, a 256-char cap and a control-char sanitizer:
    //
    //   output_style:(e)=>{if(typeof e.style!=="string"||e.style==="")return[];
    //     if(e.style.length>gFn)return T(`Output style name exceeds …`),[];
    //     return Zy([kn({content:`${pze(e.style)} output style is active. …
    //
    // It is a true superset of what we spliced, not a coincidence of wording.
    // The event is built as `{type:"output_style",style:r.name,
    // turnReminder:r.turnReminder}` from `ggi()`, which resolves against the
    // MERGED style table — so `e.style` is already the custom style's own name
    // and the reminder now renders for it. Our fallback-text substitution is
    // separately owned by the `system-reminder-output-style-active` override,
    // so no delta is lost by standing down here.
    //
    // The threading half is NOT promoted: the custom-style loader return and
    // the style-table merge entry are byte-identical to 2.1.237 and still drop
    // `turnReminder`, so `e.turnReminder` stays undefined for a custom style
    // without us. Thread it and no-op the renderer.
    if (
      /output_style:\(([$\w]+)\)=>\{if\(typeof \1\.style!=="string"/.test(
        oldFile
      )
    ) {
      console.log(
        'patch: outputStyleTurnReminder: renderer promoted in this CC build — threading only'
      );
      return threadCustomStyleTurnReminder(oldFile);
    }
    console.error(
      'patch: outputStyleTurnReminder: failed to find the output-style reminder renderer'
    );
    return null;
  }

  const [, ev, styleVar, table, wrap, build] = match;

  // `${styleVar}?.name ?? ev.style` keeps the built-in display name where there
  // is one and uses the configured name for a custom style. The guard is gone,
  // so the reminder now renders for both.
  const replacement =
    `output_style:(${ev})=>{let ${styleVar}=${table}[${ev}.style];` +
    `let outputStyleName_tweakcc=${styleVar}?.name??${ev}.style;` +
    `if(!outputStyleName_tweakcc)return[];` +
    `return ${wrap}([${build}({content:\`\${outputStyleName_tweakcc} output style is active. ` +
    `\${${ev}.turnReminder??"${FALLBACK}"}\`,isMeta:!0})])}`;

  const newFile =
    oldFile.slice(0, match.index) +
    replacement +
    oldFile.slice(match.index + match[0].length);

  showDiff(
    oldFile,
    newFile,
    replacement,
    match.index,
    match.index + replacement.length
  );
  return threadCustomStyleTurnReminder(newFile);
};
