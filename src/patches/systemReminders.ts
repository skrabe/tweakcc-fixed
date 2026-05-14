import { showDiff } from './index';

export const writeClaudemdContextOncePerConversation = (
  oldFile: string
): string | null => {
  const pattern =
    /function ([$\w]+)\(([$\w]+),([$\w]+)\)\{if\(Object\.entries\(\3\)\.length===0\)return \2;return\[/;
  const match = oldFile.match(pattern);
  if (!match || match.index === undefined) {
    if (
      /function [$\w]+\(([$\w]+),[$\w]+\)\{if\(Object\.entries\([$\w]+\)\.length===0\)return \1;if\(\1\.length>1\)return \1;return\[/.test(
        oldFile
      )
    ) {
      return oldFile;
    }
    console.error(
      'patch: claudemd-context-once-per-conversation: failed to find kY6 wrapper'
    );
    return null;
  }
  const [fullMatch, fnName, msgsParam, ctxParam] = match;
  const replacement =
    `function ${fnName}(${msgsParam},${ctxParam}){` +
    `if(Object.entries(${ctxParam}).length===0)return ${msgsParam};` +
    `if(${msgsParam}.length>1)return ${msgsParam};` +
    `return[`;
  const startIndex = match.index;
  const endIndex = startIndex + fullMatch.length;
  const newFile =
    oldFile.slice(0, startIndex) + replacement + oldFile.slice(endIndex);
  showDiff(oldFile, newFile, replacement, startIndex, endIndex);
  return newFile;
};

export const writeStripEmptySystemReminders = (
  oldFile: string
): string | null => {
  const pattern =
    /function ([$\w]+)\(([$\w]+)\)\{return`<system-reminder>\n\$\{\2\}\n<\/system-reminder>`\}/;
  const match = oldFile.match(pattern);

  if (!match || match.index === undefined) {
    if (
      /function [$\w]+\(([$\w]+)\)\{if\(!\1\|\|!\1\.trim\(\)\|\|\1==="\(no content\)"\)return"\(no content\)";return`<system-reminder>/.test(
        oldFile
      )
    ) {
      return oldFile;
    }
    console.error(
      'patch: strip-empty-system-reminders: failed to find LW(H) wrapper'
    );
    return null;
  }

  const [fullMatch, fnName, argName] = match;
  // Return the unwrapped "(no content)" placeholder for empty/placeholder input.
  // Returning "" would make text blocks empty, which Anthropic's API rejects when
  // cache_control is attached: `cache_control cannot be set for empty text blocks`.
  const replacement =
    `function ${fnName}(${argName}){` +
    `if(!${argName}||!${argName}.trim()||${argName}==="(no content)")return"(no content)";` +
    `return\`<system-reminder>\n\${${argName}}\n</system-reminder>\`}`;

  const startIndex = match.index;
  const endIndex = startIndex + fullMatch.length;
  const newFile =
    oldFile.slice(0, startIndex) + replacement + oldFile.slice(endIndex);
  showDiff(oldFile, newFile, replacement, startIndex, endIndex);
  return newFile;
};

const DEFERRED_TOOLS_ANCHOR =
  'The following deferred tools are now available via';

export const writeSuppressDeferredTools = (oldFile: string): string | null => {
  if (!oldFile.includes(DEFERRED_TOOLS_ANCHOR)) {
    console.log(
      'patch: suppress-deferred-tools: anchor not present in this CC build — no-op'
    );
    return oldFile;
  }

  const caseHeader = `case"deferred_tools_delta":{`;
  const earlyReturn = `case"deferred_tools_delta":{return [];`;

  if (oldFile.includes(earlyReturn)) {
    return oldFile;
  }

  const headerIdx = oldFile.indexOf(caseHeader);
  if (headerIdx < 0) {
    console.error('patch: suppress-deferred-tools: failed to find case header');
    return null;
  }

  const lookahead = oldFile.slice(headerIdx, headerIdx + 2048);
  if (!lookahead.includes(DEFERRED_TOOLS_ANCHOR)) {
    console.error(
      'patch: suppress-deferred-tools: case header found but anchor text not nearby'
    );
    return null;
  }

  const insertAt = headerIdx + caseHeader.length;
  const insertion = 'return [];';
  const newFile =
    oldFile.slice(0, insertAt) + insertion + oldFile.slice(insertAt);
  showDiff(oldFile, newFile, insertion, insertAt, insertAt);
  return newFile;
};
