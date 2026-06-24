// Please see the note about writing patches in ./index
//
// [EXPERIMENTAL] Complexity effort router.
//
// Classifies how hard each task is into an ordinal level and sets the session's
// reasoning-effort (thinking) level accordingly - routine work runs at low
// effort (fast, cheap), the hardest work at max. It rides on whatever model the
// user is already on (Opus 4.8 by default): a pure thinking-depth dial, no model
// switch. Changing the effort level is NOT a prompt-cache invalidator - per the
// Anthropic caching hierarchy only model and tool-definition changes rebuild the
// cache, and effort-level changes are not listed - so routing the effort never
// churns the prompt cache or adds cost. Off by default.
//
// -- Mechanism (illustrated with CC 2.1.186 darwin names; verified on 2.1.186
// and 2.1.187). Minified names churn per version/platform, so every anchor
// CAPTURES them from the binary at apply time - never hardcode a name. --
//
// CC resolves a turn's effort through a single resolver:
//
//   function XQ(e,t){if(!FR(e))return;let n=fUe(e),r=Tbn(e),o=mUe();
//     if(o===null)return n?r:void 0;let s=o??(n?r:void 0)??t??r;
//     if(s==="max"&&!dUe(e))return"high";if(s==="xhigh"&&!GRe(e))return"high";return s}
//
// where e=model, FR=supports-effort, mUe=CLAUDE_CODE_EFFORT_LEVEL env (env-only:
// it reads process.env, NOT settings), dUe=supports-max, GRe=supports-xhigh, and
// t=the app-state effort FALLBACK - which carries BOTH the persisted
// settings.effortLevel baseline (loaded at launch) AND an in-session /effort
// (they share one app-state slot). The outgoing request's effort lands in
// output_config.effort as nO(model,effortValue) -> XQ, so XQ is the wire
// chokepoint.
//
// We wrap XQ to return the router's effort, OVERRIDING the persisted baseline (so
// the router actually routes for the common case of a user who set a global
// effortLevel - deferring to it would make the router silently inert) while still
// yielding to a deliberate pin:
//   - the CLAUDE_CODE_EFFORT_LEVEL env var (`o` != null), and
//   - an in-session /effort, detected as the fallback `t` diverging from the
//     launch baseline we capture on first resolve. Equal-to-baseline (or unset)
//     means the user has not touched effort this session, so the router drives;
//     once they /effort to a different value the router yields for the rest of
//     the session (until set back, or /clear).
// The support guards (dUe/GRe) are re-applied so an unsupported level still
// downgrades to "high".
//
// The classify hook splices into CC's submit handler (anchor: the stable
// "requires a string input." throw), where the finalized user text `E` and the
// submit mode `t` are in scope. On a plain prompt it runs the synchronous
// heuristic scorer (or, in `llm` mode, an awaited Haiku side-call via gB that
// fails OPEN to the heuristic) and writes the level's effort onto a global the
// wrapped XQ reads.
//
// -- Scope note --
// XQ is CC's single effort resolver, used for the main loop AND for subagents /
// side-calls that resolve effort the same way. The wrap applies the routed
// effort wherever effort resolves with no explicit user pin, so a task's
// subagents (on an effort-capable model) inherit the task's effort. Side-calls
// on Haiku-class models are unaffected (Haiku does not take effort, so XQ
// returns at its `!FR(e)` guard, before the wrap).
// CC's picker-internal comparators also resolve through the wrapped eZ: the
// /effort and /model pickers call it to decide "did effort change?" (gDt) and to
// pre-select the ultracode row (tZ). After >=1 completed turn these reflect the
// ROUTED value rather than the raw effortValue - cosmetic only (the picker change
// still applies and the /effort yield still works).
//
// -- Interaction: ultracode --
// CC's "ultracode" mode is gated on the RESOLVED effort being exactly "xhigh"
// (tZ: `...&&eZ(e,t)==="xhigh"`). The default tiers map to low/medium/high/max
// (never xhigh), so while the router drives, ultracode-gated behavior (the
// workflow usage-consent prompt, the /fast hint, the ultracode status flag) goes
// inactive for a user whose effort baseline was xhigh. To keep ultracode
// reachable, map a tier's effort to "xhigh" (a valid RouterEffort).
//
// -- Behavior --
// pinPerTask (default true): keep the effort stable across a session. Heuristic
// mode re-scores every prompt but only ESCALATES (never auto-downgrades), so a
// session that revealed hard work keeps thinking hard; llm mode classifies once
// and FREEZES that level until /clear (avoiding a classifier call per turn).
// Set it false to re-rate every prompt - effort tracks each message up AND down
// (and llm mode then fires the side-call every turn). `llm` mode awaits a
// one-shot Haiku side-call at the task boundary and fails OPEN to the heuristic
// on any error/timeout.
//
// -- Known limits (the /effort signal is value-based) --
// CC keeps the persisted baseline and an in-session /effort in ONE app-state
// slot, so we infer "user took manual control" by the fallback diverging from
// the launch baseline. Consequences: (1) if the user /effort's to a value EQUAL
// to their launch baseline, we can't distinguish it and keep driving (narrow:
// re-pinning to your existing default). (2) The baseline is captured on the first
// effort resolve - in practice a boot side-call, before any picker interaction;
// only if the very first resolve were a /effort or /model picker preview (a path
// reachable solely when the model's launch-pin gate is open) could it capture a
// picker candidate. /clear re-captures a fresh baseline, recovering from both.
//
// -- Observability (automatic, no extra patch) --
// Because the wrap rides on the effort resolver eZ, CC surfaces the routed effort
// for free. Its working indicator renders ` with ${fet(e,t)} effort` where
// `fet -> eZ`, so the spinner reads e.g. "thinking with max effort" for EVERY
// user, no setup. (The statusline-command input JSON also carries it as
// effort.level via `sO -> eZ`, for a custom always-on badge.) And
// TWEAKCC_ROUTER_DEBUG=1 logs each decision to stderr.

import { debug } from '../utils';
import { showDiff } from './index';
import { ComplexityRouterConfig } from '../types';

const ROUTER_MARKER = '__tweakccRouterClassify';

// CC's gB structured side-call helper + km agent-context builder, captured from
// the binary (both needed to fire the llm classifier correctly).
interface ClassifierHelpers {
  gB: string;
  km: string;
}

// ---------------------------------------------------------------------------
// Injected runtime (lives inside cli.js). All ASCII - no escaping needed.
// ---------------------------------------------------------------------------

/**
 * Build the router runtime: per-session state, the synchronous heuristic
 * scorer, the optional llm classifier, and the classify entry point. Config is
 * baked in as literals (JSON.stringify for the array - F-84/F-88 class: a value
 * can never break out of its literal).
 *
 * `helpers` is the captured gB/km pair for `llm` mode (or null, in which case
 * the llm path degrades to the heuristic).
 */
const buildRuntime = (
  config: ComplexityRouterConfig,
  helpers: ClassifierHelpers | null
): string => {
  const efforts = config.levels.map(l => l.effort);
  const mode = config.mode === 'llm' && helpers ? 'llm' : 'heuristic';
  const efJson = JSON.stringify(efforts);
  const pin = config.pinPerTask ? 'true' : 'false';

  // The llm classifier is only emitted in llm mode with resolved gB/km. It
  // mirrors CC's own structured gB callers exactly: the full options shape
  // (agents/isNonInteractiveSession/hasAppendSystemPrompt/mcpTools/agentContext)
  // is required - gB -> DWe -> Sql reads agentContext.agentType unconditionally,
  // so omitting it throws on every call. gB pins model:HR() (the small-fast
  // Haiku resolver) itself, so no model override is needed here.
  const llmFn =
    mode === 'llm' && helpers
      ? `async function __tweakccRouterClassifyLlm(__t,__max){` +
        // No minimum/maximum in the schema: structured outputs reject numeric
        // constraints; the range is stated in the prompt and we clamp on read.
        `var __schema={type:"object",properties:{level:{type:"integer",description:"task complexity, 0 (trivial) to "+__max+" (hardest)"}},required:["level"],additionalProperties:false};` +
        `var __sys="You are a difficulty classifier for a coding agent. Read the user request and output an integer complexity level from 0 (trivial: a mechanical edit, rename, or search) to "+__max+" (the hardest: deep architecture, subtle concurrency/security, or large multi-file work). Output only the level. When uncertain, pick the higher level.";` +
        `var __in=__t.length>4000?__t.slice(0,4000):__t;` +
        `var __ac=new AbortController(),__to=setTimeout(function(){try{__ac.abort()}catch(__e){}},8000);` +
        `try{var __res=await ${helpers.gB}({systemPrompt:[__sys],userPrompt:__in,outputFormat:{type:"json_schema",schema:__schema},signal:__ac.signal,options:{querySource:"route_complexity",agents:[],isNonInteractiveSession:!1,hasAppendSystemPrompt:!1,mcpTools:[],agentContext:${helpers.km}()}});` +
        `return __tweakccRouterReadLevel(__res)}finally{clearTimeout(__to)}}` +
        // Defensively pull an integer `level` out of gB's result, which is an
        // assistant message: {message:{content:[{type:"text",text:"<json>"}]}}.
        `function __tweakccRouterReadLevel(__r){try{` +
        `if(__r==null)return null;` +
        `if(typeof __r==="number")return __r;` +
        `if(typeof __r.level==="number")return __r.level;` +
        `var __c=(__r.message&&__r.message.content)||__r.content;` +
        `var __x=typeof __r==="string"?__r:(Array.isArray(__c)&&__c[0]&&typeof __c[0].text==="string"?__c[0].text:(typeof __r.text==="string"?__r.text:""));` +
        `if(__x){try{var __o=JSON.parse(__x);if(__o&&typeof __o.level==="number")return __o.level}catch(__e){}var __m=__x.match(/-?\\d+/);if(__m)return parseInt(__m[0],10)}` +
        `return null}catch(__e){return null}}`
      : '';

  // Level computation, baked per mode:
  //  - llm: classify once via gB (when pinned) and fail OPEN to the heuristic.
  //  - heuristic: synchronous scorer; when pinned, escalate up only (monotonic),
  //    never auto-downgrade (keeps a complex session thinking hard). With
  //    pinPerTask off, the scorer's level is used directly each prompt.
  const levelCompute =
    mode === 'llm' && helpers
      ? `var __max=__ef.length-1,__lv;` +
        `if(__pin&&__st.level!==void 0){__lv=__st.level}` +
        `else{try{__lv=await __tweakccRouterClassifyLlm(__text,__max)}catch(__e){__lv=null}` +
        // !Number.isInteger catches a non-conforming gB result (float/NaN): NaN
        // passes the </> comparisons, and __ef[float] is undefined -> the router
        // would silently yield (and pin the bad level). Fail OPEN to the heuristic.
        `if(__lv==null||!Number.isInteger(__lv)||__lv<0||__lv>__max)__lv=__tweakccRouterScore(__text,__max)}`
      : `var __max=__ef.length-1,__lv=__tweakccRouterScore(__text,__max);` +
        `if(__pin&&__st.level!==void 0&&__lv<__st.level)__lv=__st.level;`;

  return (
    `function __tweakccRouterState(){return globalThis.__tweakccRouter||(globalThis.__tweakccRouter={level:void 0,effort:void 0,baseline:void 0})}` +
    // Synchronous heuristic difficulty scorer. Default level 1 (Standard);
    // confident-trivial work routes DOWN to 0 (low) - the cost win - while
    // accumulated hard signals escalate UP. Bias-to-escalate the ambiguous middle:
    // the error cost is asymmetric (under-thinking a hard task is the dominant
    // failure), so only an explicit mechanical verb with ZERO hard signals earns
    // low; everything uncertain stays at medium. Input is capped and every keyword
    // regex uses bounded quantifiers, so it stays linear on adversarial pastes.
    `function __tweakccRouterScore(__t,__max){` +
    `if(typeof __t!=="string"||!__t)return 1;` +
    `if(__t.length>16000)__t=__t.slice(0,16000);` +
    `var __s=__t.toLowerCase(),__n=0;` +
    // strong signals (weight 2)
    `if(/\\b(race condition|data race|deadlock|concurren|mutex|thread[- ]?saf|atomic)/.test(__s))__n+=2;` +
    `if(/\\b(security|vulnerab|exploit|cve-|injection|xss|csrf|sandbox escape|priv(ilege)? escalat|auth\\w{0,40} bypass)/.test(__s))__n+=2;` +
    `if(/\\b(refactor|re-?architect|architecture|redesign|rewrite|migrat|cross[- ]file|across (the )?(codebase|files|modules|repo))/.test(__s))__n+=2;` +
    `if(/\\btraceback\\b|\\bexception\\b|\\bpanic:|\\bsegfault\\b|\\bcore dumped\\b|[\\w.$]{1,40}(error|exception):[^\\n]{0,120}\\d|\\bat [\\w$.]{1,80} ?\\([^\\n]{0,200}:\\d+:\\d+\\)/i.test(__t))__n+=2;` +
    // medium signals (weight 1)
    `if(/\\b(why (is|are|does|do|won'?t|doesn'?t|can'?t)|root cause|intermittent|flaky|heisenbug|hangs?|deadlocks?|leaks?)/.test(__s))__n+=1;` +
    `if(/\\b(optimi[sz]e|performance|throughput|latency|complexity|algorithm|big[- ]?o|o\\(n)/.test(__s))__n+=1;` +
    `if(/\\b(carefully|think (hard|deeply)|production|business[- ]critical|robust|edge cases?|correctness)/.test(__s))__n+=1;` +
    `if(__t.length>1800)__n+=1;` +
    `if((__t.match(/[\\w./-]{1,80}\\.[a-z]{1,5}\\b/gi)||[]).length>=3)__n+=1;` +
    `if((__t.match(/\`\`\`/g)||[]).length>=4)__n+=1;` +
    // Decide the level: confident-trivial work (an explicit mechanical verb with
    // ZERO hard signals) routes DOWN to low (0); ambiguous work stays at the
    // medium default (1); a hard signal escalates to the "hard" tier (index 2);
    // heavy accumulation OR an explicit max-effort phrase jumps to the TOP tier
    // (__max, so it tracks the configured level count). The trivial->0 and
    // hard->2 mappings target the default 4-tier layout (routine/standard/hard/
    // frontier); a custom level count clamps sensibly, and llm mode gives finer
    // per-tier control.
    `var __triv=__n===0&&/\\b(rename|fix (?:the |a )?typos?|typos?|reformat|run (?:the )?prettier|prettier|gofmt|sort (?:the )?imports|bump (?:the )?version|add (?:a )?(?:comment|docstring|jsdoc)|remove (?:the |a )?(?:comment|console\\.log|unused import|debug (?:log|statement)))\\b/.test(__s);` +
    `var __l;` +
    `if(/\\b(ultrathink|think as hard as|maximum effort|hardest possible|frontier model)/.test(__s))__l=__max;` +
    `else if(__n>=5)__l=__max;` +
    `else if(__n>=2)__l=2;` +
    `else if(__triv)__l=0;` +
    `else __l=1;` +
    `if(__l<0)__l=0;if(__l>__max)__l=__max;` +
    `if(process.env.TWEAKCC_ROUTER_DEBUG)try{process.stderr.write("[tweakcc-router] heuristic signals="+__n+" -> level="+__l+"\\n")}catch(__e){}` +
    `return __l}` +
    llmFn +
    // Classify the finalized user message and write the level's effort onto the
    // global the wrapped effort resolver reads. The level-computation branch is
    // baked per mode, so heuristic mode never references the llm helper.
    `async function ${ROUTER_MARKER}(__text,__mode){try{` +
    `var __ef=${efJson},__pin=${pin};` +
    `if(!__ef||!__ef.length)return;` +
    `var __st=__tweakccRouterState();` +
    `if(typeof __text!=="string")return;` +
    `var __tr=__text.replace(/^\\s+/,"");` +
    // /clear (NOT /clear-screen) is a material context shift -> re-classify next.
    // Also drop the captured effort baseline so the next resolve re-captures the
    // CURRENT app-state effort as the fresh baseline: /clear is a clean slate, so
    // the router resumes driving even if the user had /effort'd this session.
    `if(/^\\/clear(\\s|$)/.test(__tr)){__st.level=void 0;__st.effort=void 0;__st.baseline=void 0;return}` +
    `if(__tr.charAt(0)==="/")return;` + // other slash commands aren't tasks
    `if(__mode!==void 0&&__mode!=="prompt")return;` + // only route prompt-mode submits
    levelCompute +
    `if(__lv<0)__lv=0;if(__lv>__max)__lv=__max;` +
    `__st.level=__lv;__st.effort=__ef[__lv];` +
    `if(process.env.TWEAKCC_ROUTER_DEBUG)try{process.stderr.write("[tweakcc-router] decision mode=${mode} level="+__lv+" effort="+__st.effort+" chars="+__text.length+"\\n")}catch(__e){}` +
    `}catch(__e){}}`
  );
};

// ---------------------------------------------------------------------------
// Splice 1: wrap the effort resolver XQ + prepend the runtime helpers.
// ---------------------------------------------------------------------------
const wrapEffortResolver = (
  file: string,
  config: ComplexityRouterConfig,
  helpers: ClassifierHelpers | null
): string | null => {
  // function NAME(MODEL,FALLBACK){if(!FR(MODEL))return;let A=fUe(MODEL),B=Tbn(MODEL),ENV=mUe();
  //   if(ENV===null)return A?B:void 0;let S=ENV??(A?B:void 0)??FALLBACK??B;
  //   if(S==="max"&&!dUe(MODEL))return"high";if(S==="xhigh"&&!GRe(MODEL))return"high";return S}
  // Captures: 1=prefix (through `=mUe();`), 2=MODEL, 3=FALLBACK, 4=ENV, 5=maxGuard, 6=xhighGuard.
  const pattern =
    /(function [$\w]+\(([$\w]+),([$\w]+)\)\{if\(![$\w]+\(\2\)\)return;let [$\w]+=[$\w]+\(\2\),[$\w]+=[$\w]+\(\2\),([$\w]+)=[$\w]+\(\);)if\(\4===null\)return [$\w]+\?[$\w]+:void 0;let [$\w]+=\4\?\?\([$\w]+\?[$\w]+:void 0\)\?\?\3\?\?[$\w]+;if\([$\w]+==="max"&&!([$\w]+)\(\2\)\)return"high";if\([$\w]+==="xhigh"&&!([$\w]+)\(\2\)\)return"high";return [$\w]+\}/;

  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    if (!file.includes('CLAUDE_CODE_EFFORT_LEVEL')) {
      debug(
        'patch: complexityRouter: effort resolver absent in this CC build - no-op'
      );
      return file;
    }
    console.error(
      'patch: complexityRouter: failed to find effort resolver (XQ shape)'
    );
    return null;
  }

  const prefix = match[1];
  const model = match[2];
  const fallback = match[3];
  const env = match[4];
  const maxGuard = match[5];
  const xhighGuard = match[6];

  // Apply the router's effort, overriding the persisted effort baseline (CC's
  // settings.effortLevel / the per-model default, which arrive as the app-state
  // FALLBACK) but yielding to a deliberate user pin:
  //   - ENV: CLAUDE_CODE_EFFORT_LEVEL set (env != null) -> always defer.
  //   - in-session /effort: detected as the app-state FALLBACK diverging from the
  //     launch baseline we capture on the first resolve. While the fallback still
  //     equals the launch baseline (or is unset) the user has not touched effort
  //     this session, so the router drives; once they /effort to a different
  //     value the router yields for the rest of the session (until they set it
  //     back, or /clear).
  // This makes the router actually route for users who set a persistent
  // effortLevel, without trampling an explicit in-session choice. Support guards
  // (max/xhigh) are re-applied so an unsupported level still downgrades to "high".
  const inject =
    `var __st=__tweakccRouterState();` +
    `if(__st.baseline===void 0)__st.baseline=(${fallback}==null?null:${fallback});` +
    `let __twkRE=__st.effort;` +
    `if(__twkRE&&${env}==null&&(${fallback}==null||${fallback}===__st.baseline)){` +
    `if(__twkRE==="max"&&!${maxGuard}(${model}))__twkRE="high";` +
    `if(__twkRE==="xhigh"&&!${xhighGuard}(${model}))__twkRE="high";` +
    `return __twkRE}`;

  const runtime = buildRuntime(config, helpers);
  const replacement = runtime + prefix + inject + match[0].slice(prefix.length);

  const start = match.index;
  const end = start + match[0].length;
  const newFile = file.slice(0, start) + replacement + file.slice(end);
  showDiff(file, newFile, replacement, start, end);
  return newFile;
};

// ---------------------------------------------------------------------------
// Splice 2: call the classify hook from the submit handler.
// ---------------------------------------------------------------------------
const injectSubmitHook = (file: string): string | null => {
  // if(E===null&&t!=="prompt")throw Error(`Mode: ${t} requires a string input.`);
  // Captures: 1=text var (E), 2=mode var (t).
  const pattern =
    /if\(([$\w]+)===null&&([$\w]+)!=="prompt"\)throw Error\(`Mode: \$\{\2\} requires a string input\.`\);/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    if (!file.includes('requires a string input.')) {
      debug(
        'patch: complexityRouter: submit handler absent in this CC build - no-op'
      );
      return file;
    }
    console.error(
      'patch: complexityRouter: failed to find submit handler throw-guard'
    );
    return null;
  }

  const textVar = match[1];
  const modeVar = match[2];
  const call = `await ${ROUTER_MARKER}(${textVar},${modeVar});`;

  const insertAt = match.index + match[0].length;
  const newFile = file.slice(0, insertAt) + call + file.slice(insertAt);
  showDiff(file, newFile, call, insertAt, insertAt);
  return newFile;
};

// Locate CC's gB structured side-call helper (a one-shot, Haiku-pinned,
// json-schema side-call) and the km agent-context builder for the llm
// classifier. gB has a near-twin `Vpt` with an identical destructure signature,
// so we anchor on the segment unique to gB: it pins `model:<fn>(),enablePromptCaching:`
// (Vpt has no `model:` field). km is `function NAME(){return{agentType:"main",agentId:<fn>()}}`.
const findClassifierHelpers = (file: string): ClassifierHelpers | null => {
  const gb = file.match(
    /async function ([$\w]+)\(\{systemPrompt:[$\w]+=[$\w]+\(\[\]\),userPrompt:[$\w]+,outputFormat:[$\w]+,signal:[$\w]+,options:[$\w]+\}\)\{return\(await [$\w]+\([\s\S]{0,500}?,model:[$\w]+\(\),enablePromptCaching:/
  );
  const km = file.match(
    /function ([$\w]+)\(\)\{return\{agentType:"main",agentId:[$\w]+\(\)\}\}/
  );
  if (gb && km) return { gB: gb[1], km: km[1] };
  return null;
};

export const writeComplexityRouter = (
  oldFile: string,
  config: ComplexityRouterConfig
): string | null => {
  // Idempotency: already patched.
  if (oldFile.includes(ROUTER_MARKER)) {
    debug('patch: complexityRouter: already patched - skipping');
    return oldFile;
  }

  let helpers: ClassifierHelpers | null = null;
  if (config.mode === 'llm') {
    helpers = findClassifierHelpers(oldFile);
    if (!helpers) {
      console.warn(
        'patch: complexityRouter: llm mode requested but the gB/km side-call ' +
          'helpers were not found - falling back to the heuristic classifier'
      );
    }
  }

  const afterResolver = wrapEffortResolver(oldFile, config, helpers);
  if (afterResolver === null) return null;
  // Graceful no-op (resolver absent) returns the file unchanged: nothing to hook.
  if (afterResolver === oldFile) return oldFile;

  const afterHook = injectSubmitHook(afterResolver);
  if (afterHook === null) return null;
  // All-or-nothing: if the submit handler is absent (injectSubmitHook returned
  // the file unchanged), don't ship the resolver wrap + runtime with nothing to
  // populate the global - that would leave the wrap permanently inert plus dead
  // injected code in cli.js. Revert the whole patch instead.
  if (afterHook === afterResolver) {
    debug(
      'patch: complexityRouter: submit handler absent - reverting the resolver ' +
        'wrap too (all-or-nothing no-op)'
    );
    return oldFile;
  }

  return afterHook;
};
