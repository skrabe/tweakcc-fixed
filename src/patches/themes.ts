// Please see the note about writing patches in ./index

import { Theme } from '../types';
import { debug } from '../utils';
import { LocationResult, showDiff } from './index';
import { literalAnchored } from '../literalAnchoredSearch';

/**
 * CC's theme-ID whitelist: `Kls=["dark","light",...]`, immediately followed by
 * `Rin=["auto",...Kls]`.
 *
 * This is a SEPARATE registry from the three surfaces below (name map, option
 * array, color switch). The colour switch answers "what does this id look
 * like"; this array answers "is this a real theme id at all", via a type guard
 * `x1o(e){return typeof e==="string"&&Kls.includes(e)}`. Patching the first
 * three and not this one leaves a custom theme rendering through the switch
 * while every caller that validates the id first rejects it — a split palette
 * rather than a clean failure.
 *
 * The `,IDENT2=["auto",...IDENT]` tail is the confirmer: it is what makes this
 * array the theme registry rather than any other list of colour-ish words.
 */
const THEME_ID_REGISTRY =
  /([$\w]+)=(\["dark","light"(?:,"[\w-]+")*\]),([$\w]+)=\["auto",\.\.\.\1\]/;

// Find each `var={label:"Theme Name",value:"theme-id"}` assignment.
export const THEME_VAR_ASSIGN_PATTERN =
  /([$\w]+)=\{label:"(?:Auto|Dark|Light|Monochrome)[^"]*",value:"[^"]+"\}/g;

// The prefix group MUST be capturing: the writer reads objMatch[1] as the
// assignment prefix (`hM3=` on var-collected builds, `return` on the old
// switch form) and reuses it. If it were non-capturing, objMatch[1] is
// undefined, objPrefix defaults to `return`, and `hM3={...}` gets rewritten to
// `return{...}` — destroying the binding and crashing /config with
// "undefined is not an object (evaluating 'hM3[...]')".
export const THEME_NAME_MAP_PATTERN =
  /(return|[$\w]+=)\{(?:"?(?:[$\w-]+)"?:"(?:Auto |Dark|Light|Monochrome)[^"]*",?)+\}/;

// The switch CC ships returns module-scope theme objects by reference
// (`case"light":return v;…default:return B`). Each patched case spreads the
// matching one under the user's colours, so a colour key a newer CC adds (CC
// 2.1.285's `effortUltra`) falls back to Anthropic's value instead of reading
// `undefined` — which crashed the startup logo on the first frame.
interface PristineThemeVars {
  byId: Record<string, string>;
  defaultVar: string;
}

function parsePristineThemeVars(switchSrc: string): PristineThemeVars | null {
  const defaultMatch = switchSrc.match(/default:return ([$\w]+)\}$/);
  if (!defaultMatch) return null;
  const byId: Record<string, string> = {};
  for (const m of switchSrc.matchAll(/((?:case"[\w-]+":)+)return ([$\w]+);/g)) {
    for (const id of m[1].matchAll(/case"([\w-]+)":/g)) byId[id[1]] = m[2];
  }
  return { byId, defaultVar: defaultMatch[1] };
}

function pristineBaseFor(id: string, vars: PristineThemeVars): string {
  if (vars.byId[id]) return vars.byId[id];
  if (/light/.test(id) && vars.byId.light) return vars.byId.light;
  return vars.defaultVar;
}

function getThemesLocation(oldFile: string): {
  switchStatement: LocationResult;
  objArr: LocationResult;
  obj: LocationResult | null;
  idRegistry: LocationResult | null;
  pristineThemeVars: PristineThemeVars | null;
} | null {
  // === Switch Statement ===
  // CC >=2.1.83: switch(A){case"light":return LX9;...default:return CX9}
  // CC <2.1.83: switch(A){case"light":return{...};...}
  let switchStart = -1;
  let switchEnd = -1;
  let switchIdent = '';

  // Try new format first (variable references)
  const newSwitchPat =
    /switch\(([$\w]+)\)\{case"(?:light|dark)":[^}]*return [$\w]+;[^}]*default:return [$\w]+\}/;
  const newSwitchMatch = oldFile.match(newSwitchPat);

  let pristineThemeVars: PristineThemeVars | null = null;
  if (newSwitchMatch && newSwitchMatch.index != undefined) {
    switchStart = newSwitchMatch.index;
    switchEnd = switchStart + newSwitchMatch[0].length;
    switchIdent = newSwitchMatch[1];
    pristineThemeVars = parsePristineThemeVars(newSwitchMatch[0]);
  } else {
    // Try old format (inline objects) — use brace counting
    const oldAnchor = oldFile.indexOf('case"dark":return{"autoAccept"');
    if (oldAnchor === -1) {
      const oldAnchor2 = oldFile.indexOf('case"light":return{');
      if (oldAnchor2 === -1) {
        console.error('patch: themes: failed to find switchMatch');
        return null;
      }
    }
    const anchor =
      oldFile.indexOf('case"dark":return{') !== -1
        ? oldFile.indexOf('case"dark":return{')
        : oldFile.indexOf('case"light":return{');

    const before = oldFile.slice(Math.max(0, anchor - 200), anchor);
    const switchOpen = before.match(/switch\(([$\w]+)\)\{\s*$/);
    if (!switchOpen || switchOpen.index == undefined) {
      console.error('patch: themes: failed to find switchMatch (old format)');
      return null;
    }
    switchStart = Math.max(0, anchor - 200) + switchOpen.index;
    switchIdent = switchOpen[1];
    let depth = 0;
    for (
      let i = switchStart;
      i < oldFile.length && i < switchStart + 50000;
      i++
    ) {
      if (oldFile[i] === '{') depth++;
      if (oldFile[i] === '}') {
        depth--;
        if (depth === 0) {
          switchEnd = i + 1;
          break;
        }
      }
    }
  }

  if (switchStart === -1 || switchEnd === -1) {
    console.error('patch: themes: failed to find switchMatch');
    return null;
  }

  // === Theme Options Array ===
  // Old form (CC ≤2.1.138): inline array literal
  //   [{label:"Dark mode",value:"dark"},{label:"Light mode",value:"light"},...]
  // New form (CC ≥2.1.140): each option assigned to its own var (React-compiler
  // memoization), then collected via `[i,e,DH,YH,s,o,HH,...m.map(VA5),...mH]`.
  // We must preserve the trailing `,...spread` chunks (custom themes, "New custom
  // theme..." sentinel) so users can still add custom themes through CC's UI.
  let objArrStart = -1;
  let objArrEnd = -1;
  let objArrTrailingSpreads = '';

  const oldObjArrPat =
    /\[(?:\.\.\.\[\],)?(?:\{"?label"?:"(?:Dark|Light|Auto|Monochrome)[^"]*","?value"?:"[^"]+"\},?)+\]/;
  const oldObjArrMatch = oldFile.match(oldObjArrPat);

  // Old form (CC ≤2.1.138): one inline array literal.
  // New form (CC ≥2.1.140): each theme option assigned to its own React-memoized
  // var, then collected into an array with trailing `...spread` chunks (custom
  // themes). Capture those spreads so the writer can preserve user custom themes.
  if (oldObjArrMatch && oldObjArrMatch.index !== undefined) {
    objArrStart = oldObjArrMatch.index;
    objArrEnd = oldObjArrMatch.index + oldObjArrMatch[0].length;
  } else {
    const assigns = [
      ...literalAnchored.matchAll(oldFile, THEME_VAR_ASSIGN_PATTERN),
    ];
    if (assigns.length < 2) {
      console.error('patch: themes: failed to find objArrMatch');
      return null;
    }
    const themeVars = assigns.map(m => m[1]);

    // Find an array whose prefix is exactly these vars (in order), optionally
    // followed by `...spread` chunks. The vars must not be preceded by `,` so
    // we don't accidentally land in the middle of a longer array.
    const escVars = themeVars.map(v => v.replace(/\$/g, '\\$')).join(',');
    const arrayPat = new RegExp(`\\[${escVars}((?:,\\.\\.\\.[^\\]]+)*)\\]`);
    const arrayMatch = oldFile.match(arrayPat);
    if (!arrayMatch || arrayMatch.index === undefined) {
      console.error(
        'patch: themes: failed to find objArrMatch (new var-collected form)'
      );
      return null;
    }
    objArrStart = arrayMatch.index;
    objArrEnd = arrayMatch.index + arrayMatch[0].length;
    objArrTrailingSpreads = arrayMatch[1];
  }

  // === Theme Name Mapping Object ===
  // {dark:"Dark mode",...} or {"dark":"Dark mode",...}
  const objMatch = literalAnchored.match(oldFile, THEME_NAME_MAP_PATTERN);

  if (!objMatch || objMatch.index == undefined) {
    debug(
      'patch: themes: objMatch not found — colors will still apply, theme name map unchanged'
    );
  }

  // === Theme ID Registry ===
  const idRegistryMatch = oldFile.match(THEME_ID_REGISTRY);
  if (!idRegistryMatch) {
    debug(
      'patch: themes: theme-id registry not found — custom theme ids will not validate'
    );
  }

  return {
    switchStatement: {
      startIndex: switchStart,
      endIndex: switchEnd,
      identifiers: [switchIdent],
    },
    pristineThemeVars,
    objArr: {
      startIndex: objArrStart,
      endIndex: objArrEnd,
      // Stash the trailing `,...spread,...spread` so the writer can preserve it
      // (only present in the new var-collected form; empty string for old form).
      identifiers: [objArrTrailingSpreads],
    },
    obj:
      objMatch && objMatch.index !== undefined
        ? {
            startIndex: objMatch.index,
            endIndex: objMatch.index + objMatch[0].length,
            identifiers: [objMatch[1]],
          }
        : null,
    idRegistry:
      idRegistryMatch && idRegistryMatch.index !== undefined
        ? {
            // Span covers only the array literal, not the assignment or the
            // `,Rin=["auto",...Kls]` tail: those must survive verbatim.
            startIndex: idRegistryMatch.index + idRegistryMatch[1].length + 1,
            endIndex:
              idRegistryMatch.index +
              idRegistryMatch[1].length +
              1 +
              idRegistryMatch[2].length,
            identifiers: [idRegistryMatch[2]],
          }
        : null,
  };
}

export const writeThemes = (
  oldFile: string,
  themes: Theme[]
): string | null => {
  const locations = getThemesLocation(oldFile);
  if (!locations) {
    return null;
  }

  if (themes.length === 0) {
    return oldFile;
  }

  let newFile = oldFile;

  // Process in reverse order to avoid index shifting

  // Update theme mapping object (obj) — skip if not present (newer CC builds)
  if (locations.obj) {
    const objPrefix = locations.obj.identifiers?.[0] ?? 'return';
    const obj =
      objPrefix +
      JSON.stringify(
        Object.fromEntries(themes.map(theme => [theme.id, theme.name]))
      );
    newFile =
      newFile.slice(0, locations.obj.startIndex) +
      obj +
      newFile.slice(locations.obj.endIndex);
    showDiff(
      oldFile,
      newFile,
      obj,
      locations.obj.startIndex,
      locations.obj.endIndex
    );
    oldFile = newFile;
  }

  // Update theme options array (objArr).
  // For 2.1.140+ var-collected form, preserve trailing `,...m.map(...),...mH`
  // spreads so users can still add custom themes through CC's UI.
  const trailingSpreads = locations.objArr.identifiers?.[0] ?? '';
  const objArrInner = themes
    .map(theme => JSON.stringify({ label: theme.name, value: theme.id }))
    .join(',');
  const objArr = `[${objArrInner}${trailingSpreads}]`;
  newFile =
    newFile.slice(0, locations.objArr.startIndex) +
    objArr +
    newFile.slice(locations.objArr.endIndex);
  showDiff(
    oldFile,
    newFile,
    objArr,
    locations.objArr.startIndex,
    locations.objArr.endIndex
  );
  oldFile = newFile;

  const vars = locations.pristineThemeVars;
  const themeObject = (id: string, colors: Theme['colors']): string =>
    vars
      ? `{...${pristineBaseFor(id, vars)},...${JSON.stringify(colors)}}`
      : JSON.stringify(colors);

  // Update switch statement
  let switchStatement = `switch(${locations.switchStatement.identifiers?.[0]}){\n`;
  themes.forEach(theme => {
    // JSON.stringify the id (not raw `"${theme.id}"`): a `"` in a user/remote
    // theme id would otherwise break out of the case-label string and inject
    // into cli.js. Identical output for normal slug ids.
    switchStatement += `case${JSON.stringify(theme.id)}:return${themeObject(
      theme.id,
      theme.colors
    )};\n`;
  });
  switchStatement += `default:return${themeObject(themes[0].id, themes[0].colors)};\n}`;

  newFile =
    newFile.slice(0, locations.switchStatement.startIndex) +
    switchStatement +
    newFile.slice(locations.switchStatement.endIndex);
  showDiff(
    oldFile,
    newFile,
    switchStatement,
    locations.switchStatement.startIndex,
    locations.switchStatement.endIndex
  );
  oldFile = newFile;

  // Register custom theme ids in CC's id whitelist, so the type guard
  // `x1o(e){return typeof e==="string"&&IDS.includes(e)}` accepts them. Last,
  // because this array sits at a LOWER offset than the three surfaces above and
  // the writer splices in descending order.
  //
  // APPENDED, never replaced: CC's own paths (auto/daltonized/ansi resolution,
  // the `["auto",...IDS]` superset built from this very array) reference the
  // built-in ids, so dropping them would break vanilla themes to fix custom
  // ones.
  if (locations.idRegistry) {
    const pristineIds: string[] = JSON.parse(
      locations.idRegistry.identifiers?.[0] ?? '[]'
    );
    const extraIds = themes
      .map(theme => theme.id)
      .filter(id => !pristineIds.includes(id));
    if (extraIds.length > 0) {
      const registry = JSON.stringify([...pristineIds, ...extraIds]);
      newFile =
        newFile.slice(0, locations.idRegistry.startIndex) +
        registry +
        newFile.slice(locations.idRegistry.endIndex);
      showDiff(
        oldFile,
        newFile,
        registry,
        locations.idRegistry.startIndex,
        locations.idRegistry.endIndex
      );
      debug(
        `patch: themes: registered custom theme id(s) ${extraIds.join(', ')}`
      );
    }
  }

  return newFile;
};
