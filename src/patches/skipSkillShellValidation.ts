// Please see the note about writing patches in ./index
//
// Skip Skill Shell Validation Patch - Let your own skills/commands run any
// prompt-shell command (feature request #960)
//
// Skill and command markdown can embed shell commands as !`cmd`. Before the
// prompt is sent, Claude Code runs every embedded command through the Bash
// permission check. Anything that check would *ask* about (for example
// `$HOME` - "Contains simple_expansion") makes the whole skill fail with
// "Shell command permission check failed for pattern ...".
//
// This patch marks the expansion call made for skills and commands loaded
// from your skill/command directories (user, project, managed, --add-dir),
// and lets an "ask" result run the command instead of throwing. Explicit
// deny results still throw. Plugin commands/skills, built-in commands, and
// MCP skills are not marked, so they keep the stock check.
//
// SECURITY: with this on, any !`...` in a skill or command file you load runs
// with no permission prompt. That includes `.claude/commands` and
// `.claude/skills` of the project you open, so a cloned repository can run
// shell commands as soon as you (or Claude) invoke one of its skills.
//
// Patch 1 - mark own skills at the caller:
// ```diff
// -else if(dTr(Me))to=await whe(to,{...Mn,getAppState:DM(Mn,nn())},`/${e}`,ct);
// +else if(dTr(Me))to=await whe(to,{tweakccOwnSkill:!0,...Mn,getAppState:DM(Mn,nn())},`/${e}`,ct);
// ```
//
// Patch 2 - let "ask" through for marked calls in whe(). Since CC 2.1.325 the
// bare-git-repository throw comes first and stays live for own skills:
// ```diff
// -if(ot.behavior!=="allow"){t(`...`);let Nt=...;if(tt&&yt&&(...))throw new yx(`...`);if(jo(...
// +if(ot.behavior!=="allow")tweakccAsk:{t(`...`);let Nt=...;if(tt&&yt&&(...))throw new yx(`...`);if(n.tweakccOwnSkill&&ot.behavior==="ask")break tweakccAsk;if(jo(...
// ```
// Before 2.1.325:
// ```diff
// -if(Me.behavior!=="allow"){...Shell command permission check failed...
// +if(Me.behavior!=="allow"&&!(n.tweakccOwnSkill&&Me.behavior==="ask")){...
// ```

import { showDiff } from './index';

const FAILURE_MESSAGE = 'Shell command permission check failed for pattern';

type CheckEdit = { start: number; end: number; text: string };

const findBareRepoGuardedCheck = (
  body: string,
  ctxVar: string
): CheckEdit | null => {
  const match = new RegExp(
    String.raw`if\(([$\w]+)\.behavior!=="allow"\)\{([$\w]+\(\`Shell command permission check failed[\s\S]{0,600}?if\([$\w]+&&[$\w]+&&\(([$\w]+)\?\.type==="other"\|\|\3\?\.type==="subcommandResults"\)\)throw new [$\w]+\(\`(?:\\[\s\S]|[^\`\\])*\`\);)`
  ).exec(body);
  if (!match) return null;
  const resultVar = match[1];
  return {
    start: match.index,
    end: match.index + match[0].length,
    text: `if(${resultVar}.behavior!=="allow")tweakccAsk:{${match[2]}if(${ctxVar}.tweakccOwnSkill&&${resultVar}.behavior==="ask")break tweakccAsk;`,
  };
};

const findPlainCheck = (body: string, ctxVar: string): CheckEdit | null => {
  const match = new RegExp(
    String.raw`if\(([$\w]+)\.behavior!=="allow"\)(\{if\([$\w]+\(\`Shell command permission check failed)`
  ).exec(body);
  if (!match) return null;
  const resultVar = match[1];
  return {
    start: match.index,
    end: match.index + match[0].length,
    text: `if(${resultVar}.behavior!=="allow"&&!(${ctxVar}.tweakccOwnSkill&&${resultVar}.behavior==="ask"))${match[2]}`,
  };
};

export const writeSkipSkillShellValidation = (file: string): string | null => {
  if (!file.includes(FAILURE_MESSAGE)) return null;
  if (file.includes('tweakccOwnSkill')) return file;

  // async function whe(e,n,r,s[,h]){if(n.options.readOnlySkillLoad)...
  const header = file.match(
    /async function ([$\w]+)\([$\w]+,([$\w]+)(?:,[$\w]+)*\)\{if\(\2\.options\.readOnlySkillLoad\)/
  );
  if (!header || header.index === undefined) {
    console.error(
      'patch: skipSkillShellValidation: failed to find prompt-shell expansion function'
    );
    return null;
  }
  const [, expandFn, ctxVar] = header;

  const body = file.slice(header.index);
  const checkEdit =
    findBareRepoGuardedCheck(body, ctxVar) ?? findPlainCheck(body, ctxVar);
  if (!checkEdit) {
    console.error(
      'patch: skipSkillShellValidation: failed to find permission check in prompt-shell expansion'
    );
    return null;
  }

  // else if(dTr(Me))to=await whe(to,{...Mn,getAppState:
  const caller = new RegExp(
    String.raw`(else if\([$\w]+\([$\w]+\)\)([$\w]+)=await ${expandFn.replace(/\$/g, () => '\\$')}\(\2,\{)(\.\.\.[$\w]+,getAppState:)`
  );
  const callerMatch = caller.exec(file);
  if (!callerMatch || callerMatch.index === undefined) {
    console.error(
      'patch: skipSkillShellValidation: failed to find skill prompt-shell call'
    );
    return null;
  }

  const callerReplacement = `${callerMatch[1]}tweakccOwnSkill:!0,${callerMatch[3]}`;

  // Apply the later edit first so the earlier offset stays valid.
  const edits = [
    {
      start: header.index + checkEdit.start,
      end: header.index + checkEdit.end,
      text: checkEdit.text,
    },
    {
      start: callerMatch.index,
      end: callerMatch.index + callerMatch[0].length,
      text: callerReplacement,
    },
  ].sort((a, b) => b.start - a.start);

  let result = file;
  for (const { start, end, text } of edits) {
    const next = result.slice(0, start) + text + result.slice(end);
    showDiff(result, next, text, start, end);
    result = next;
  }
  return result;
};
