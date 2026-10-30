// Please see the note about writing patches in ./index

import { debug, escapeNonAscii } from '../utils';
import { showDiff } from './index';
import { observeFffFileUsage, useFffAutocomplete } from './fffRuntime';
import { bindFffSession } from './fffContext';
import { writeFffInstructions } from './fffInstructions';

const fffShellSetup = (wrapperPath: string): string => {
  const quoted = "'" + wrapperPath.replaceAll("'", "'\\''") + "'";
  return (
    escapeNonAscii(
      JSON.stringify(`if [ -x ${quoted} ]; then export RG_FFF_SESSION=`)
    ) +
    '+process.pid+' +
    escapeNonAscii(
      JSON.stringify(
        '; unalias fff 2>/dev/null || true; ' +
          `function fff { ${quoted} "$@"; }; ` +
          `${quoted} --warmup "$PWD" >/dev/null 2>&1 || true; fi`
      )
    )
  );
};

export const hasFffShellIntegration = (
  file: string,
  wrapperPath: string
): boolean => file.includes('=[' + fffShellSetup(wrapperPath) + ',');

interface ShellSetupConsumer {
  start: number;
  end: number;
  variable: string;
  tail: string;
}

const findShellSetupConsumer = (
  file: string,
  producer: string
): ShellSetupConsumer | null => {
  // CC 2.1.314+: `let L=P(),G=\`CLAUDE_CODE_END_...\`,Y=[...,...L!==null?[...]:[]]`
  const snapshotLines = [
    ...file.matchAll(/let ([$\w]+)=([$\w]+)\(\),(?=[$\w]+=`CLAUDE_CODE_END_)/g),
  ].filter(
    match =>
      match[2] === producer &&
      file
        .slice(match.index, match.index! + 1000)
        .includes(`...${match[1]}!==null?[`)
  );
  if (snapshotLines.length === 1 && snapshotLines[0].index !== undefined) {
    const match = snapshotLines[0];
    return {
      start: match.index,
      end: match.index + match[0].length,
      variable: match[1],
      tail: ',',
    };
  }
  const markers = [
    ...file.matchAll(/let ([$\w]+)=([$\w]+)\(\);if\(\1!==null\)/g),
  ].filter(
    match =>
      match[2] === producer &&
      file
        .slice(match.index, match.index! + 1000)
        .includes('FIND_GREP_FUNC_END')
  );
  if (markers.length === 1 && markers[0].index !== undefined) {
    const match = markers[0];
    return {
      start: match.index,
      end: match.index + match[0].length,
      variable: match[1],
      tail: `;if(${match[1]}!==null)`,
    };
  }
  return null;
};

const installFffShell = (file: string, wrapperPath: string): string | null => {
  if (hasFffShellIntegration(file, wrapperPath)) return file;
  const pattern =
    /function ([$\w]+)\(\)\{if\(![$\w]+\(\)\)return null;return\["unalias find 2>\/dev\/null \|\| true","unalias grep 2>\/dev\/null \|\| true",/g;
  const matches = [...file.matchAll(pattern)];
  if (matches.length !== 1 || matches[0].index === undefined) {
    console.error(
      'patch: swapRipgrepForFff: failed to find unique native shell setup'
    );
    return null;
  }
  const producer = matches[0][1];
  const consumer = findShellSetupConsumer(file, producer);
  if (consumer === null) {
    console.error(
      'patch: swapRipgrepForFff: failed to find unique native shell setup consumer'
    );
    return null;
  }
  const { start, end, variable, tail } = consumer;
  const insertion =
    `let ${variable}=[${fffShellSetup(wrapperPath)},${producer}()].filter(Boolean).join("\\n")` +
    tail;
  const updated = file.slice(0, start) + insertion + file.slice(end);
  showDiff(file, updated, insertion, start, end);
  return updated;
};

export const restoreNativeSearchTools = (file: string): string | null => {
  const pattern =
    /(?:^|[;}])var ([$\w]+)=new Set;var ([$\w]+)=new Set\(\[([$\w]+),([$\w]+)\]\);function ([$\w]+)\(\)\{if\(![$\w]+\(\)\|\|![$\w]+\(\)\)return \1;let ([$\w]+)=([$\w]+),/g;
  const matches = [...file.matchAll(pattern)].filter(
    match =>
      file.includes(`var ${match[3]}="Glob";`) &&
      file.includes(`var ${match[4]}="Grep";`) &&
      [match[1], match[2]].includes(match[7])
  );
  if (matches.length !== 1 || matches[0].index === undefined) {
    console.error(
      'patch: swapRipgrepForFff: failed to find unique native search omission gate'
    );
    return null;
  }
  const match = matches[0];
  if (match[7] === match[1]) return file;
  const suffix = `let ${match[6]}=${match[7]},`;
  const start = match.index! + match[0].length - suffix.length;
  const replacement = `let ${match[6]}=${match[1]},`;
  const updated =
    file.slice(0, start) + replacement + file.slice(start + suffix.length);
  showDiff(file, updated, replacement, start, start + suffix.length);
  return updated;
};

export const writeSwapRipgrepForFff = (
  oldFile: string,
  wrapperPath: string
): string | null => {
  if (
    oldFile.includes(
      'export RG_FFF_SESSION="${process.pid}"; local _cc_bin='
    ) ||
    oldFile.includes('args:["--fff-claude-bin="+process.execPath]')
  ) {
    console.error(
      'patch: swapRipgrepForFff: legacy search interception requires applying from pristine Claude Code'
    );
    return null;
  }
  const restored = restoreNativeSearchTools(oldFile);
  if (restored === null) return null;
  const installed = installFffShell(restored, wrapperPath);
  if (installed === null) return null;
  const instructed = writeFffInstructions(installed);
  if (instructed === null) return null;
  let file = instructed;

  const observed = observeFffFileUsage(file, wrapperPath);
  if (observed === null) {
    debug(
      'patch: swapRipgrepForFff: successful file-operation observer absent'
    );
  } else {
    file = observed;
  }

  const autocomplete = useFffAutocomplete(file, wrapperPath);
  if (autocomplete !== null) file = autocomplete;

  const bound = bindFffSession(file);
  if (bound !== null) file = bound;

  return file;
};
