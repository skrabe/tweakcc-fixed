// Please see the note about writing patches in ./index

import { LocationResult, showDiff } from './index';

const getStartupBannerLocation = (oldFile: string): LocationResult | null => {
  // CC <2.1.83: Find the createElement with isBeforeFirstMessage:!1
  const pattern =
    /,[$\w]+\.createElement\([$\w]+,\{isBeforeFirstMessage:!1\}\),/;
  const match = oldFile.match(pattern);

  if (match && match.index !== undefined) {
    return {
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    };
  }

  return null;
};

const insertReturnNullAt = (oldFile: string, insertIndex: number): string => {
  const insertion = 'return null;';
  const newFile =
    oldFile.slice(0, insertIndex) + insertion + oldFile.slice(insertIndex);
  showDiff(oldFile, newFile, insertion, insertIndex, insertIndex);
  return newFile;
};

const WELCOME = '"Welcome to Claude Code"';

const findWelcomeCardBodyStart = (
  oldFile: string,
  marker: string
): number | null => {
  const welcome = WELCOME;
  let welcomeAt = oldFile.indexOf(welcome);
  while (welcomeAt !== -1) {
    const searchStart = Math.max(0, welcomeAt - 12000);
    const region = oldFile.slice(searchStart, welcomeAt);
    const zeroArgFn = /function ([$\w]+)\(\)\{/g;
    let last: RegExpExecArray | null = null;
    let fnMatch: RegExpExecArray | null;
    while ((fnMatch = zeroArgFn.exec(region)) !== null) {
      last = fnMatch;
    }
    if (last && last.index !== undefined) {
      const bodyStart = searchStart + last.index + last[0].length;
      const bodyPreview = oldFile.slice(bodyStart, bodyStart + 12000);
      const nextFn = bodyPreview.search(/function [$\w]+\(/);
      const body = nextFn === -1 ? bodyPreview : bodyPreview.slice(0, nextFn);
      if (body.includes(welcome) && body.includes(marker)) {
        return bodyStart;
      }
    }
    welcomeAt = oldFile.indexOf(welcome, welcomeAt + welcome.length);
  }
  return null;
};

export const writeHideStartupBanner = (oldFile: string): string | null => {
  const location = getStartupBannerLocation(oldFile);
  if (location) {
    const newFile =
      oldFile.slice(0, location.startIndex) +
      ',' +
      oldFile.slice(location.endIndex);
    showDiff(oldFile, newFile, ',', location.startIndex, location.endIndex);
    return newFile;
  }

  // Method 1 (CC >= 2.1.328): the full-logo component was inlined, so the
  // welcomeMessage prop is gone; key on the light-theme branch instead.
  // Method 2 (CC >= 2.1.326): the Apple_Terminal check moved into a helper
  // call, so key on the full-logo branch's welcomeMessage prop instead.
  // Method 0 (CC >= 2.1.246): the startup card is still a zero-arg component
  // that owns both "Welcome to Claude Code" and the Apple_Terminal theme
  // branch, but React-compiler cache allocation is an imported `cache(N)`
  // call (`let e=lo(39)`) rather than `obj.c(N)`, and Apple_Terminal now sits
  // AFTER the compact-welcome `return` — so the older `[^}]{0,500}` lookahead
  // never sees it. Find the zero-arg function whose body contains both
  // literals and early-return null.
  for (const marker of [
    '["light","light-daltonized","light-ansi"].includes(',
    `welcomeMessage:${WELCOME}`,
    'Apple_Terminal',
  ]) {
    const bodyStart = findWelcomeCardBodyStart(oldFile, marker);
    if (bodyStart !== null) {
      if (oldFile.startsWith('return null;', bodyStart)) {
        return oldFile;
      }
      return insertReturnNullAt(oldFile, bodyStart);
    }
  }

  // CC >=2.1.156: the startup card component contains both the full-logo
  // branch and the compact/horizontal card branch. Disable the whole component.
  const modernCardPatterns = [
    /(function [$\w]+\(\)\{)(?=let [$\w]+=[\w$]+\.c\(\d+\),[$\w]+=[\w$]+\(\)\.oauthAccount\?\.displayName\?\?""|let [$\w]+=[\w$]+\(\),[$\w]+=[\w$]+\?\.displayName\?\?"")/,
    /(function [$\w]+\(\)\{)(?=let [$\w]+=[\w$]+\.c\(\d+\),[$\w]+=[\w$]+\(\),[$\w]+=[\w$]+\?\.displayName\?\?"")/,
  ];

  for (const modernCardPattern of modernCardPatterns) {
    const modernCardMatch = oldFile.match(modernCardPattern);
    if (modernCardMatch && modernCardMatch.index !== undefined) {
      const insertIndex = modernCardMatch.index + modernCardMatch[1].length;
      const insertion = 'return null;';
      const newFile =
        oldFile.slice(0, insertIndex) + insertion + oldFile.slice(insertIndex);

      showDiff(oldFile, newFile, insertion, insertIndex, insertIndex);
      return newFile;
    }
  }

  // CC >=2.1.83: The startup banner is a standalone zero-arg component function.
  // It contains both "Apple_Terminal" (for theme branching) and "Welcome to Claude Code".
  // Insert `return null;` at the start of its body.
  const funcPattern = /(function ([$\w]+)\(\)\{)(?=[^}]{0,500}Apple_Terminal)/g;

  let funcMatch: RegExpExecArray | null;
  while ((funcMatch = funcPattern.exec(oldFile)) !== null) {
    const bodyStart = funcMatch.index + funcMatch[0].length;
    const bodyPreview = oldFile.slice(bodyStart, bodyStart + 5000);
    if (bodyPreview.includes('Welcome to Claude Code')) {
      const insertIndex = bodyStart;
      const insertion = 'return null;';

      const newFile =
        oldFile.slice(0, insertIndex) + insertion + oldFile.slice(insertIndex);

      showDiff(oldFile, newFile, insertion, insertIndex, insertIndex);
      return newFile;
    }
  }

  console.error(
    'patch: hideStartupBanner: failed to find startup banner component'
  );
  return null;
};
