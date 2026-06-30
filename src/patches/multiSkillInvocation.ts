// Please see the note about writing patches in ./index
//
// Multi-skill invocation: when you type several `/skill` commands in one
// message, invoke ALL of them directly — as user invocations, not via the model.
//
// CC's input parser only ever dispatches ONE command — the leading token. In
// `/skill-1 /skill-2 do X`, only `/skill-1` is run; `/skill-2 do X` becomes
// skill-1's argument string. The extra `/skill-2` is never invoked as a command.
// (The model could invoke it via the Skill tool, but for a
// `disable-model-invocation` skill that path is gated — and routing through the
// model isn't a user invocation anyway.)
//
// This patch makes every typed `/skill` a real user invocation. The command
// executor's `case"prompt"` runs the leading skill via `bcl(cmd, args, ctx, …)`,
// which returns that skill's full message set (its `<command-message>` user
// line, the injected skill body, and its tool-permissions). We hook the point
// right after that call: parse the leading skill's argument string for further
// `/name` tokens, resolve each against the command registry, run it through the
// same `bcl`, and concatenate its messages onto the result. Each skill's body is
// injected directly into the one turn — no Skill-tool call, no
// disable-model-invocation gate, deterministic.
//
// Scope + safety:
// - Only user-invocable, enabled, prompt-type commands are dispatched (skills and
//   bundled prompt-commands) — `userInvocable:false` and non-prompt (local/jsx)
//   commands are skipped, exactly as direct typing would behave.
// - `disable-model-invocation` is irrelevant here: these are USER invocations,
//   which that flag never restricted. A skill the user did not type is never
//   dispatched.
// - The whole sibling pass is wrapped in try/catch: if anything fails (registry
//   shape drift, a throwing skill loader, …) it degrades to the current
//   leading-command-only behavior. It can never break the main input path.
//
// Stock seam, inside the executor's `case"prompt":`:
//     let p=await EXEC(c,t,r,o,s,l,d.hookMessages);return CLEANUP(u),p
// EXEC is the prompt/skill executor (bcl@2.1.195, Nml@2.1.196). The executor
// and cleanup names are CAPTURED from the seam; the command resolver
// (mE@2.1.195, OT@2.1.196 — `find(c=>matcher(c,name))`) and the is-enabled
// check (HH@2.1.195, rk@2.1.196 — `c.isEnabled?.()??!0`) are DISCOVERED by
// shape so the patch survives per-version minifier renames; UUIDs come from
// globalThis.crypto so there's no crypto-module-name dependency.

import { showDiff } from './index';

export const writeMultiSkillInvocation = (oldFile: string): string | null => {
  // Idempotency: our injected token-list local is uniquely named.
  if (oldFile.includes('__tcMsiTok')) {
    return oldFile;
  }

  // Match the leading-skill dispatch in the executor's prompt case. Captures the
  // result var (1), executor (2), command (3), args (4), ctx (5), remaining
  // executor args (6-9), cleanup call (10-11) — all re-emitted verbatim so only
  // the splice is new. The 6th arg being a bare ident (not `a??VD`) excludes the
  // sibling fork-context branch.
  const pattern =
    /let ([$\w]+)=await ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+)\.hookMessages\);return ([$\w]+)\(([$\w]+)\),\1/;
  const match = oldFile.match(pattern);

  if (!match || match.index === undefined) {
    console.error(
      'patch: multiSkillInvocation: failed to find the leading-skill dispatch (executor call site)'
    );
    return null;
  }

  const [full, p, exec, c, t, r, o, s, l, d, cleanup, u] = match;

  // Discover the command resolver: `function NAME(name,arr){return arr.find(x=>matcher(x,name))}`
  const resolverMatch = oldFile.match(
    /function ([$\w]+)\(([$\w]+),([$\w]+)\)\{return \3\.find\(\(([$\w]+)\)=>[$\w]+\(\4,\2\)\)\}/
  );
  // Discover the is-enabled check: `function NAME(c){return c.isEnabled?.()??!0}`
  const enabledMatch = oldFile.match(
    /function ([$\w]+)\(([$\w]+)\)\{return \2\.isEnabled\?\.\(\)\?\?!0\}/
  );
  if (!resolverMatch || !enabledMatch) {
    console.error(
      'patch: multiSkillInvocation: failed to discover the command resolver / is-enabled helper'
    );
    return null;
  }
  const resolver = resolverMatch[1];
  const isEnabled = enabledMatch[1];

  const siblingPass =
    `try{` +
    `let __tcMsiTok=[],__tcMsiRe=/(?:^|\\s)\\/([a-zA-Z0-9:_-]+)(?=\\s|$)/g,__tcMsiM;` +
    `while((__tcMsiM=__tcMsiRe.exec(${t}))!==null)__tcMsiTok.push([__tcMsiM[1],__tcMsiRe.lastIndex,__tcMsiM.index]);` +
    `let __tcMsiSeen=new Set([${c}.name]);` +
    `for(let __tcMsiK=0;__tcMsiK<__tcMsiTok.length&&__tcMsiK<16;__tcMsiK++){` +
    `let __tcMsiN=__tcMsiTok[__tcMsiK][0];` +
    `if(__tcMsiSeen.has(__tcMsiN))continue;__tcMsiSeen.add(__tcMsiN);` +
    `let __tcMsiC=${resolver}(__tcMsiN,${r}.options.commands);` +
    `if(!__tcMsiC||__tcMsiC.type!=="prompt"||__tcMsiC.userInvocable===!1||!${isEnabled}(__tcMsiC))continue;` +
    `let __tcMsiA=${t}.slice(__tcMsiTok[__tcMsiK][1],__tcMsiK+1<__tcMsiTok.length?__tcMsiTok[__tcMsiK+1][2]:${t}.length).trim(),` +
    `__tcMsiR=await ${exec}(__tcMsiC,__tcMsiA,${r},[],[],globalThis.crypto.randomUUID(),[]);` +
    // Drop the sibling's leading <command-message> entry (the executor emits it
    // first) so it doesn't render a duplicate command box in the TUI — keep only
    // its injected body + tool-permissions. The user sees one box (what they typed).
    `if(__tcMsiR&&Array.isArray(__tcMsiR.messages))${p}={...${p},messages:[...${p}.messages,...__tcMsiR.messages.slice(1)]}` +
    `}` +
    `}catch(__tcMsiE){}`;

  const replacement =
    `let ${p}=await ${exec}(${c},${t},${r},${o},${s},${l},${d}.hookMessages);` +
    siblingPass +
    `return ${cleanup}(${u}),${p}`;

  const newFile =
    oldFile.slice(0, match.index) +
    replacement +
    oldFile.slice(match.index + full.length);

  showDiff(
    oldFile,
    newFile,
    replacement,
    match.index,
    match.index + full.length
  );

  return newFile;
};
