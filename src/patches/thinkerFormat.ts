// Please see the note about writing patches in ./index

import { LocationResult, showDiff } from './index';
import { escapeNonAscii } from '../utils';

const getThinkerFormatLocation = (oldFile: string): LocationResult | null => {
  // Older CC shape: spinnerTip + overrideMessage adjacent in one destructure.
  const approxAreaPatternOld =
    /spinnerTip:[$\w]+,(?:[$\w]+:[$\w]+,)*overrideMessage:[$\w]+,.{300}/;
  // CC >= 2.1.113: spinnerTip moved out; anchor on the spinner's destructured
  // signature containing overrideMessage, spinnerSuffix, and verbose.
  const approxAreaPatternNew =
    /overrideMessage:[$\w]+,spinnerSuffix:[$\w]+,verbose:[$\w]+,.{300}/;
  // CC >= 2.1.126: overrideMessage moved out of the destructure entirely.
  // Anchor on the still-unique pauseStartTimeRef -> spinnerSuffix -> verbose run.
  const approxAreaPatternLatest =
    /pauseStartTimeRef:[$\w]+,spinnerSuffix:[$\w]+,verbose:[$\w]+,.{300}/;
  // CC >= 2.1.144: a sibling spinner function (no format decl) now shares the
  // pauseStartTimeRef/spinnerSuffix/verbose triple, so the Latest anchor lands
  // on the wrong scope. Anchor on the format-bearing function's wider
  // destructure: overrideMessage … isCompacting … compactingHintText …
  // compactingStartTime … spinnerSuffix … verbose.
  const approxAreaPattern2144 =
    /overrideMessage:[$\w]+,isCompacting:[$\w]+,compactingHintText:[$\w]+,compactingStartTime:[$\w]+,spinnerSuffix:[$\w]+,verbose:[$\w]+,.{300}/;
  // CC >= 2.1.326: isResponseHeld sits inside that run, and the sibling
  // spinner moved ~170KB away, so the Latest fallback no longer lands near the
  // format. Tolerate extra props between isCompacting and compactingHintText.
  const approxAreaPattern2326 =
    /overrideMessage:[$\w]+,isCompacting:[$\w]+,(?:[$\w]+:[$\w]+(?:=[^,]{1,10})?,)*?compactingHintText:[$\w]+,compactingStartTime:[$\w]+,spinnerSuffix:[$\w]+,verbose:[$\w]+,/;
  const approxAreaMatch =
    oldFile.match(approxAreaPattern2326) ||
    oldFile.match(approxAreaPattern2144) ||
    oldFile.match(approxAreaPatternOld) ||
    oldFile.match(approxAreaPatternNew) ||
    oldFile.match(approxAreaPatternLatest);

  const searchStart = approxAreaMatch?.index;

  // Search forward from the anchor far enough to reach the format declaration
  // (~14KB after the destructure on CC 2.1.126). Guard against a missing anchor
  // so a no-match returns null cleanly instead of dereferencing undefined.
  const searchSection =
    searchStart === undefined
      ? ''
      : oldFile.slice(searchStart, searchStart + 20000);

  // CC >= 2.1.277: the ellipsis became a `suffix` prop (defaulting to "…"),
  // and the skip-if-already-ends-in-one test applies only when the suffix is
  // that default: `,Kt=O===we&&_n.test(Vt)?Vt:Vt+O`. The configured format
  // replaces the whole declaration, suffix included, as in every earlier shape.
  const formatPatternSuffix =
    /,([$\w]+)(=[$\w]+===[$\w]+&&[$\w]+\.test\(([$\w]+)\)\?\3:\3\+[$\w]+)(?=[,;])/;
  const formatMatchSuffix = searchSection.match(formatPatternSuffix);

  if (formatMatchSuffix && formatMatchSuffix.index != undefined) {
    return {
      startIndex:
        searchStart! +
        formatMatchSuffix.index +
        formatMatchSuffix[1].length +
        1,
      endIndex:
        searchStart! +
        formatMatchSuffix.index +
        formatMatchSuffix[1].length +
        formatMatchSuffix[2].length +
        1,
      identifiers: [formatMatchSuffix[3]],
    };
  }

  // CC >= 2.1.273: the ellipsis became conditional so a label that already ends
  // in one isn't given a second: `,ue=Mn.test(vt)?vt:vt+"…"`, where `vt`
  // holds the resolved label and `Mn` is a module-level regex. The label is no
  // longer built inside the declaration, so every earlier pattern (which
  // expects the expression and the `+"…"` in one place) misses and the patch
  // returned null against the real bundle while `--apply` stayed silent about
  // it — the toggle is off by default, so only `pnpm test:pristine` saw it.
  const formatPatternCond =
    /,([$\w]+)(=[$\w]+\.test\(([$\w]+)\)\?\3:\3\+"(?:…|\\u2026)")/;
  const formatMatchCond = searchSection.match(formatPatternCond);

  if (formatMatchCond && formatMatchCond.index != undefined) {
    return {
      startIndex:
        searchStart! + formatMatchCond.index + formatMatchCond[1].length + 1, // + 1 for the comma
      endIndex:
        searchStart! +
        formatMatchCond.index +
        formatMatchCond[1].length +
        formatMatchCond[2].length +
        1, // + 1 for the comma
      identifiers: [formatMatchCond[3]],
    };
  }

  // New nullish format: N=(Y??C?.activeForm??L)+"…"
  const formatPatternOld = /,([$\w]+)(=\(([^;]{1,200}?)\)\+"(?:…|\\u2026)")/;
  const formatMatchOld = searchSection.match(formatPatternOld);

  if (formatMatchOld && formatMatchOld.index != undefined) {
    return {
      startIndex:
        searchStart! + formatMatchOld.index + formatMatchOld[1].length + 1, // + 1 for the comma
      endIndex:
        searchStart! +
        formatMatchOld.index +
        formatMatchOld[1].length +
        formatMatchOld[2].length +
        1, // + 1 for the comma
      identifiers: [formatMatchOld[3]],
    };
  }

  // Fallback pattern: =($a&&!$b.isIdle?$c.spinnerVerb??$d:$e)+"…"
  const formatPatternNew =
    /,([$\w]+)(=(\([$\w]+&&![$\w]+\.isIdle\?[$\w]+\.spinnerVerb\?\?[$\w]+:[$\w]+\))\+"(?:…|\\u2026)")/;
  const formatMatchNew = searchSection.match(formatPatternNew);

  if (formatMatchNew && formatMatchNew.index != undefined) {
    return {
      startIndex:
        searchStart! + formatMatchNew.index + formatMatchNew[1].length + 1, // + 1 for the comma
      endIndex:
        searchStart! +
        formatMatchNew.index +
        formatMatchNew[1].length +
        formatMatchNew[2].length +
        1, // + 1 for the comma
      identifiers: [formatMatchNew[3]],
    };
  }

  // CC ≥ 2.1.87 template-literal pattern: =`${expr}… `
  const formatPatternTpl =
    /,([$\w]+)(=`\$\{([$\w]+&&![$\w]+\.isIdle\?[$\w]+\.spinnerVerb\?\?[$\w]+:[$\w]+)\}(?:…|\\u2026) ?`)/;
  const formatMatchTpl = searchSection.match(formatPatternTpl);

  if (formatMatchTpl && formatMatchTpl.index != undefined) {
    return {
      startIndex:
        searchStart! + formatMatchTpl.index + formatMatchTpl[1].length + 1,
      endIndex:
        searchStart! +
        formatMatchTpl.index +
        formatMatchTpl[1].length +
        formatMatchTpl[2].length +
        1,
      identifiers: [formatMatchTpl[3]],
    };
  }

  // Whole-file fallback (CC 2.1.146+): when the anchored search misses, scan for
  // the nullish spinner-verb format anywhere, keeping only a match whose
  // surrounding context proves it's the spinner format (not a lookalike).
  const formatPatternNewGlobal = new RegExp(formatPatternNew.source, 'g');
  const formatMatches = [...oldFile.matchAll(formatPatternNewGlobal)].filter(
    match => {
      if (match.index == undefined) {
        return false;
      }
      const context = oldFile.slice(
        Math.max(0, match.index - 2500),
        match.index + 1000
      );
      return (
        context.includes('overrideMessage:') &&
        context.includes('.activeForm') &&
        context.includes('.isIdle') &&
        context.includes('.spinnerVerb') &&
        context.includes('spinnerTip')
      );
    }
  );

  if (formatMatches.length === 1) {
    const formatMatch = formatMatches[0];
    return {
      startIndex: formatMatch.index! + formatMatch[1].length + 1, // + 1 for the comma
      endIndex:
        formatMatch.index! + formatMatch[1].length + formatMatch[2].length + 1, // + 1 for the comma
      identifiers: [formatMatch[3]],
    };
  }

  console.error('patch: thinker format: failed to find formatMatch');
  return null;
};

export const writeThinkerFormat = (
  oldFile: string,
  format: string
): string | null => {
  const location = getThinkerFormatLocation(oldFile);
  if (!location) {
    return null;
  }
  const fmtLocation = location;

  // See `getThinkerFormatLocation` for an explanation of this.
  // Escape for the backtick template literal below: `\` and backtick prevent
  // corruption, and `${` prevents a user/remote format from injecting an
  // executable expression (cf. F-84). The `{}`→`${expr}` splice is added after.
  // Run escapeNonAscii LAST: it only introduces `\uXXXX` (single-backslash)
  // sequences, which the backslash-doubling above must not touch. Without it a
  // raw "…" in the format mojibakes against CC's Latin-1 module storage.
  const serializedFormat = escapeNonAscii(
    format.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
  );
  const curExpr = fmtLocation.identifiers?.[0];
  const curFmt =
    '`' + serializedFormat.replace(/\{\}/g, '${' + curExpr + '}') + '`';
  const formatDecl = `=${curFmt}`;

  const newFile =
    oldFile.slice(0, fmtLocation.startIndex) +
    formatDecl +
    oldFile.slice(fmtLocation.endIndex);

  showDiff(
    oldFile,
    newFile,
    formatDecl,
    fmtLocation.startIndex,
    fmtLocation.endIndex
  );
  return newFile;
};
