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
// -- Classifier: Haiku-only, with rolling-summary context --
// Routing is done by a one-shot Haiku side-call (gB) on every prompt-mode submit.
// The call is fed a compact running SUMMARY of the session, the most recent
// exchange (previous user message + previous assistant reply), and the new user
// message, and returns BOTH an integer complexity level AND an updated summary in
// one round-trip. The summary is a terse rolling TL;DR (no char cap; its growth
// is bounded by the compaction cycle - see below - not truncation), so the Haiku
// input stays small no matter how long the session runs - it never sees the full
// transcript - which keeps routing context-aware on terse follow-ups
// ("now do the same", "fix it") that continue hard work.
//
// -- Mechanism (illustrated with CC 2.1.186 darwin names; minified names churn
// per version/platform, so every anchor CAPTURES them from the binary at apply
// time - never hardcode a name.) --
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
// Four splices:
//   1. wrap XQ (effort resolver) + prepend the runtime.
//   2. call the classify entry from the submit handler (anchor: the stable
//      "requires a string input." throw), where the finalized user text `E` and
//      the submit mode are in scope.
//   3. (optional) capture the previous assistant reply text for the next turn's
//      summary, at CC's tool-use-summary site where the last assistant text is
//      already extracted. This site is gated on emitToolUseSummaries && toolUses
//      > 0, so it fires on tool-using turns (the majority) - a pure-text turn just
//      leaves the prior captured text in place. If the anchor is absent the
//      router still works, only without prior-assistant context.
//   4. (optional) capture CC's conversation-compaction summary (the summaryText
//      in the compaction result) so the next routed turn resets + reseeds its
//      TL;DR from it. Absent anchor only costs the reseed.
//
// -- Persistence (survives session leave/resume) --
// The rolling summary + last level are cached on globalThis and mirrored to a
// per-session sidecar file ~/.tweakcc/router-state/<sessionId>.json, keyed by
// CC's session id (discovered via the getSessionId(){return X()} accessor). On
// the first routed turn of a (resumed) session we reload it; we never touch CC's
// own transcript jsonl. Best-effort: any fs error degrades to in-memory only, and
// if the session-id accessor is not found persistence is simply disabled.
//
// -- Scope note --
// XQ is CC's single effort resolver, used for the main loop AND for subagents /
// side-calls that resolve effort the same way. The wrap applies the routed effort
// wherever effort resolves with no explicit user pin, so a task's subagents (on
// an effort-capable model) inherit the task's effort. Side-calls on Haiku-class
// models are unaffected (Haiku does not take effort, so XQ returns at its
// `!FR(e)` guard, before the wrap).
//
// -- Interaction: ultracode --
// CC's "ultracode" mode is gated on the RESOLVED effort being exactly "xhigh".
// The default tiers map to low/medium/high/max (never xhigh), so while the router
// drives, ultracode-gated behavior goes inactive for an xhigh-baseline user. To
// keep ultracode reachable, map a tier's effort to "xhigh" (a valid RouterEffort).
//
// -- Behavior --
// pinPerTask (default true): a monotonic floor - the routed level never drops
// below the highest seen this session (a session that revealed hard work keeps
// thinking hard). Turn it off to let effort track each message up AND down (now
// safe, because the summary gives the down-routing real context). Reset on /clear.
// Over-cap message/assistant context is middle-truncated (head + an omitted-size
// marker + tail) so the actual ask/result survives; a large prior turn is judged
// from that + the marker per the prompt, not a mechanical floor. On a Haiku
// error/timeout we keep the last level if we have one, else default HIGH
// (asymmetric cost: never silently low). TWEAKCC_ROUTER_DEBUG=1 logs each decision.
//
// -- Observability (automatic, no extra patch) --
// Because the wrap rides on the effort resolver eZ, CC surfaces the routed effort
// for free: its working indicator renders ` with ${fet(e,t)} effort` (fet -> eZ),
// so the spinner reads e.g. "thinking with max effort" for EVERY user, no setup.

import { debug, escapeNonAscii } from '../utils';
import { showDiff, getRequireFuncName } from './index';
import { ComplexityRouterConfig } from '../types';

const ROUTER_MARKER = '__tweakccRouterClassify';

// Fallback caps when a config field is absent (all are UI-editable and
// range-normalized in config.ts). The classifier input is a small fraction of
// the model's context window. The rolling summary has NO char cap - it is a
// terse TL;DR whose growth is bounded by the compaction cycle (on a real
// conversation compaction the router resets and reseeds it from CC's own
// compaction summary), not by truncation.
const DEFAULT_MESSAGE_CAP = 100000;
const DEFAULT_ASSISTANT_CAP = 100000;
const DEFAULT_TIMEOUT_MS = 15000;

// CC helpers captured from the binary: gB (Haiku-pinned json-schema side-call) +
// km (agent-context builder). Both are required - gB throws without agentContext.
interface ClassifierHelpers {
  gB: string;
  km: string;
}

// ---------------------------------------------------------------------------
// Injected runtime (lives inside cli.js). All ASCII - no escaping needed.
// ---------------------------------------------------------------------------

/**
 * Build the router runtime: per-session state + sidecar persistence, the Haiku
 * classifier (route + rolling-summary in one call), and the classify entry
 * point. Config is baked in as literals (JSON.stringify for the array - a value
 * can never break out of its literal). `helpers` is the captured gB/km pair
 * (required). `sidFn` is the discovered session-id accessor name, or null
 * (persistence disabled).
 */
const buildRuntime = (
  config: ComplexityRouterConfig,
  helpers: ClassifierHelpers,
  sidFn: string | null,
  requireFunc: string
): string => {
  const efforts = config.levels.map(l => l.effort);
  const efJson = JSON.stringify(efforts);
  const pin = config.pinPerTask ? 'true' : 'false';
  const messageCap = config.messageCap || DEFAULT_MESSAGE_CAP;
  const assistantCap = config.assistantCap || DEFAULT_ASSISTANT_CAP;
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  // Session-id accessor: call the discovered fn, else return null (no persist).
  const sidExpr = sidFn ? `${sidFn}()` : 'null';

  // The classifier system prompt, built from the CONFIGURED tiers so the rubric
  // always matches the user's levels. Emitted ASCII-safe via JSON.stringify so
  // tier help text can never break the JS string literal or introduce mojibake
  // (cli.js is stored Latin-1).
  const maxIdx = efforts.length - 1;
  const rubric = config.levels
    .map((l, i) => `Level ${i} (${l.label}): ${l.help}`)
    .join('\n');
  const sysPrompt = [
    'You are a difficulty router for an AI coding agent. Each turn you get a compact running SUMMARY of the session, the most recent exchange (the previous user message and the assistant reply), and the user NEW message. Do two things and output ONLY a JSON object with the keys level and summary - no prose, no code fence.',
    '',
    '# level',
    `Pick the integer effort level (0 = least effort, ${maxIdx} = most) for the NEW message, judged IN CONTEXT of the summary and the recent exchange:`,
    rubric,
    '',
    'How to judge:',
    '- A short or vague prompt does NOT mean an easy task. A terse follow-up (now do the same, fix it, continue, keep going, ok next) inherits the difficulty of the work it continues - score it like that ongoing work, reading the summary and recent exchange to see what is actually being built, not like a fresh trivial request.',
    '- Conversely, a genuinely new, self-contained simple request (rename a variable, fix a typo, bump a version, answer a quick question) is low even in the middle of a hard session.',
    '- Watch for hidden complexity behind simple wording: concurrency, security, distributed state, performance or correctness constraints, cross-file or multi-module impact, niche toolchains, specialized domains.',
    '- Errors, failed attempts, active debugging, or a very large prior assistant turn (shown by an omitted-from-the-middle marker) in the recent exchange or the summary are strong evidence the work needs careful reasoning - lean higher.',
    `- When unsure, do NOT default to the top. Default to the standard middle level and let clear signals push it up or down. The top level (${maxIdx}) is rare - reserve it for exactly what its description says, not for ordinary hard work.`,
    '',
    '# summary',
    'Output an updated running summary - a terse TL;DR of the session in the fewest words that still capture what was done and how hard it has been. Fold the most recent exchange into the prior summary as one short line (what this turn did and its complexity), then compress: keep the task or goal, key decisions, files or systems touched, unresolved threads, and difficulty signals (errors, retries, large changes); mark resolved items resolved and drop anything that will not affect future routing. It is a routing aid, not documentation - favor brevity.',
  ].join('\n');
  // JSON.stringify gives a valid JS string literal; escapeNonAscii forces any
  // non-ASCII in user-edited tier help to \uXXXX (mojibake-safe injection).
  const sysLit = escapeNonAscii(JSON.stringify(sysPrompt));

  return (
    // ----- per-session state -----
    `function __tweakccRouterState(){return globalThis.__tweakccRouter||(globalThis.__tweakccRouter={level:void 0,effort:void 0,baseline:void 0,summary:void 0,prevUser:void 0,prevAssistant:void 0,pendingCompaction:void 0,loaded:!1})}` +
    // Middle-truncate: keep head + tail, drop the middle (where the bulk paste /
    // logs live), with a size marker. The intent/framing (head) and the actual
    // ask or result (tail) survive, and the omitted-size marker is itself a
    // complexity signal - both better for routing than head-only truncation.
    `function __tweakccRouterTrunc(__s,__cap){if(typeof __s!=="string")return"";if(__s.length<=__cap)return __s;var __h=Math.floor(__cap/2);return __s.slice(0,__h)+"\\n...["+(__s.length-__cap)+" chars omitted from the middle]...\\n"+__s.slice(__s.length-(__cap-__h))}` +
    // ----- sidecar persistence (best-effort; any error -> in-memory only) -----
    `function __tweakccRouterSid(){try{var __s=${sidExpr};return typeof __s==="string"&&__s?__s:null}catch(__e){return null}}` +
    `function __tweakccRouterDir(){var __p=${requireFunc}("path"),__o=${requireFunc}("os");return __p.join(__o.homedir(),".tweakcc","router-state")}` +
    `function __tweakccRouterFile(__sid){return ${requireFunc}("path").join(__tweakccRouterDir(),__sid+".json")}` +
    `function __tweakccRouterLoad(__st){if(__st.loaded)return;__st.loaded=!0;try{var __sid=__tweakccRouterSid();if(!__sid)return;var __fs=${requireFunc}("fs"),__f=__tweakccRouterFile(__sid);if(__fs.existsSync(__f)){var __d=JSON.parse(__fs.readFileSync(__f,"utf8"));if(__d){if(typeof __d.summary==="string")__st.summary=__d.summary;if(Number.isInteger(__d.level))__st.level=__d.level}}__tweakccRouterPrune(__fs)}catch(__e){}}` +
    `function __tweakccRouterSave(__st){try{var __sid=__tweakccRouterSid();if(!__sid)return;var __fs=${requireFunc}("fs"),__dir=__tweakccRouterDir();__fs.mkdirSync(__dir,{recursive:!0});__fs.writeFileSync(__tweakccRouterFile(__sid),JSON.stringify({summary:__st.summary,level:__st.level,updatedAt:Date.now()}))}catch(__e){}}` +
    `function __tweakccRouterDrop(__st){try{var __sid=__tweakccRouterSid();if(!__sid)return;var __fs=${requireFunc}("fs"),__f=__tweakccRouterFile(__sid);if(__fs.existsSync(__f))__fs.unlinkSync(__f)}catch(__e){}}` +
    // Prune sidecars older than 14 days so the dir can't grow unbounded.
    `function __tweakccRouterPrune(__fs){try{var __dir=__tweakccRouterDir(),__ns=__fs.readdirSync(__dir),__now=Date.now(),__ttl=12096e5;for(var __i=0;__i<__ns.length;__i++){try{var __ff=${requireFunc}("path").join(__dir,__ns[__i]);if(__now-__fs.statSync(__ff).mtimeMs>__ttl)__fs.unlinkSync(__ff)}catch(__e){}}}catch(__e){}}` +
    // ----- defensive parse of gB's result into {level, summary} -----
    // gB returns an assistant message {message:{content:[{type:"text",text}]}}.
    `function __tweakccRouterReadResult(__r){try{` +
    `if(__r==null)return null;` +
    `if(typeof __r==="object"&&typeof __r.level==="number")return{level:__r.level,summary:typeof __r.summary==="string"?__r.summary:void 0};` +
    `var __x;if(typeof __r==="string")__x=__r;else{var __c=(__r.message&&__r.message.content)||__r.content;__x=(Array.isArray(__c)&&__c[0]&&typeof __c[0].text==="string")?__c[0].text:(typeof __r.text==="string"?__r.text:"")}` +
    `if(!__x)return null;` +
    `try{var __o=JSON.parse(__x);if(__o&&typeof __o.level==="number")return{level:__o.level,summary:typeof __o.summary==="string"?__o.summary:void 0}}catch(__e){}` +
    `var __m=__x.match(/-?\\d+/);if(__m)return{level:parseInt(__m[0],10),summary:void 0};` +
    `return null}catch(__e){return null}}` +
    // ----- the Haiku classifier: route + rolling-summary in one call -----
    // gB pins model:HR() (small-fast Haiku) itself; the full options shape
    // (esp. agentContext:km()) is required or gB -> DWe -> Sql throws.
    `async function __tweakccRouterClassifyLlm(__input,__max){` +
    `var __schema={type:"object",properties:{level:{type:"integer",description:"effort level, 0 (least) to "+__max+" (most)"},summary:{type:"string",description:"the updated running TL;DR summary"}},required:["level","summary"],additionalProperties:false};` +
    `var __sys=${sysLit};` +
    `var __ac=new AbortController(),__to=setTimeout(function(){try{__ac.abort()}catch(__e){}},${timeoutMs});` +
    `try{var __res=await ${helpers.gB}({systemPrompt:[__sys],userPrompt:__input,outputFormat:{type:"json_schema",schema:__schema},signal:__ac.signal,options:{querySource:"route_complexity",agents:[],isNonInteractiveSession:!1,hasAppendSystemPrompt:!1,mcpTools:[],agentContext:${helpers.km}()}});` +
    `return __tweakccRouterReadResult(__res)}finally{clearTimeout(__to)}}` +
    // ----- classify entry: called from the submit handler -----
    `async function ${ROUTER_MARKER}(__text,__mode){try{` +
    `var __ef=${efJson},__pin=${pin},__max=__ef.length-1;` +
    `if(!__ef||!__ef.length)return;` +
    `var __st=__tweakccRouterState();` +
    `if(typeof __text!=="string")return;` +
    `var __tr=__text.replace(/^\\s+/,"");` +
    // /clear (NOT /clear-screen) is a clean slate: reset state + baseline + sidecar.
    `if(/^\\/clear(\\s|$)/.test(__tr)){__st.level=void 0;__st.effort=void 0;__st.baseline=void 0;__st.summary=void 0;__st.prevUser=void 0;__st.prevAssistant=void 0;__st.pendingCompaction=void 0;__tweakccRouterDrop(__st);return}` +
    `if(__tr.charAt(0)==="/")return;` +
    `if(__mode!==void 0&&__mode!=="prompt")return;` +
    `__tweakccRouterLoad(__st);` +
    // On a real conversation compaction (captured by splice 4) the history was
    // replaced by CC's compaction summary - reset and reseed the TL;DR from it,
    // dropping the now-stale exchange + pin floor (same session, fresh context).
    `if(typeof __st.pendingCompaction==="string"){__st.summary=__st.pendingCompaction;__st.prevUser=void 0;__st.prevAssistant=void 0;__st.level=void 0;__st.pendingCompaction=void 0}` +
    // assemble the (bounded) router input - middle-truncated at the caps
    `var __nm=__tweakccRouterTrunc(__text,${messageCap});` +
    `var __pu=__tweakccRouterTrunc(__st.prevUser,${messageCap});` +
    `var __pa=__tweakccRouterTrunc(typeof __st.prevAssistant==="string"?__st.prevAssistant:"",${assistantCap});` +
    `var __input="<summary>\\n"+(__st.summary||"(none - first turn of the session)")+"\\n</summary>\\n<recent_exchange>\\nuser: "+(__pu||"(none)")+"\\nassistant: "+(__pa||"(none)")+"\\n</recent_exchange>\\n<new_message>\\n"+__nm+"\\n</new_message>";` +
    // classify (fail OPEN)
    `var __res=null;try{__res=await __tweakccRouterClassifyLlm(__input,__max)}catch(__e){__res=null}` +
    `var __hi=__ef.indexOf("high");if(__hi<0)__hi=Math.min(2,__max);` +
    `var __lv,__sm=__st.summary;` +
    // Take the summary whenever present, independent of the level field, so the
    // rolling memory survives even a malformed level.
    `if(__res&&typeof __res.summary==="string"&&__res.summary)__sm=__res.summary;` +
    // Any integer level is used (clamped below - an out-of-range "very hard" maps
    // to the top tier rather than falling back). Only a failed call / non-integer
    // falls open: sticky last level, else HIGH (never silently low).
    `if(__res&&Number.isInteger(__res.level))__lv=__res.level;else __lv=(__st.level!==void 0?__st.level:__hi);` +
    // pin keeps a session monotonic (a large prior turn is judged from its
    // head+tail + the omitted-size marker per the prompt, not a mechanical floor)
    `if(__pin&&__st.level!==void 0&&__lv<__st.level)__lv=__st.level;` +
    `if(__lv<0)__lv=0;if(__lv>__max)__lv=__max;` +
    `__st.level=__lv;__st.effort=__ef[__lv];__st.summary=__sm;__st.prevUser=__text;` +
    `__tweakccRouterSave(__st);` +
    `if(process.env.TWEAKCC_ROUTER_DEBUG)try{process.stderr.write("[tweakcc-router] level="+__lv+" effort="+__st.effort+" chars="+__text.length+"\\n")}catch(__e){}` +
    `}catch(__e){}}`
  );
};

// ---------------------------------------------------------------------------
// Splice 1: wrap the effort resolver XQ + prepend the runtime helpers.
// ---------------------------------------------------------------------------
const wrapEffortResolver = (
  file: string,
  config: ComplexityRouterConfig,
  helpers: ClassifierHelpers,
  sidFn: string | null
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

  // Apply the router's effort, overriding the persisted baseline (settings.effortLevel
  // / per-model default arrive as the app-state FALLBACK) but yielding to a pin:
  //   - ENV (CLAUDE_CODE_EFFORT_LEVEL set) -> always defer.
  //   - in-session /effort: the FALLBACK diverging from the launch baseline we
  //     capture on first resolve. Equal-to-baseline (or unset) -> router drives.
  // Support guards re-applied so an unsupported level still downgrades to "high".
  const inject =
    `var __st=__tweakccRouterState();` +
    `if(__st.baseline===void 0)__st.baseline=(${fallback}==null?null:${fallback});` +
    `let __twkRE=__st.effort;` +
    `if(__twkRE&&${env}==null&&(${fallback}==null||${fallback}===__st.baseline)){` +
    `if(__twkRE==="max"&&!${maxGuard}(${model}))__twkRE="high";` +
    `if(__twkRE==="xhigh"&&!${xhighGuard}(${model}))__twkRE="high";` +
    `return __twkRE}`;

  // Resolve the require fn name for THIS build: Bun exposes `require` directly,
  // but esbuild (NPM installs) routes it through a createRequire-derived var, so
  // bare require() is undefined there - the sidecar fs/path/os calls would throw.
  const runtime = buildRuntime(
    config,
    helpers,
    sidFn,
    getRequireFuncName(file)
  );
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

// ---------------------------------------------------------------------------
// Splice 3 (optional): capture the previous assistant reply text for the next
// turn's summary, at CC's tool-use-summary site where the last assistant text is
// already extracted:
//   let Et=Te.at(-1),Ze;if(Et){let Un=Et.message.content.filter((Tt)=>Tt.type==="text");
//     if(Un.length>0){let Tt=Un.at(-1);if(Tt&&"text"in Tt)Ze=Tt.text}}
// We stash that text (group 3) onto the router global. Gated on
// emitToolUseSummaries && toolUses>0, so it fires on tool-using turns (the
// majority); a pure-text turn just leaves the prior captured text in place.
// ---------------------------------------------------------------------------
const injectPrevAssistantCapture = (file: string): string => {
  const pattern =
    /([$\w]+)=([$\w]+)\.at\(-1\),([$\w]+);if\(\1\)\{let ([$\w]+)=\1\.message\.content\.filter\(\(([$\w]+)\)=>\5\.type==="text"\);if\(\4\.length>0\)\{let ([$\w]+)=\4\.at\(-1\);if\(\6&&"text"in \6\)\3=\6\.text\}\}/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    debug(
      'patch: complexityRouter: prev-assistant capture site absent - router runs without prior-assistant context'
    );
    return file;
  }
  const textVar = match[3];
  const capture = `try{var __twr=globalThis.__tweakccRouter;if(__twr)__twr.prevAssistant=${textVar}}catch(__e){}`;
  const insertAt = match.index + match[0].length;
  const newFile = file.slice(0, insertAt) + capture + file.slice(insertAt);
  showDiff(file, newFile, capture, insertAt, insertAt);
  return newFile;
};

// ---------------------------------------------------------------------------
// Splice 4 (optional): capture CC's conversation-compaction summary. The
// compaction routine returns {ok:!0,summaryText:<text>,...,messages:[<one
// isCompactSummary message>]} - it replaces the history in the SAME session. We
// stash summaryText onto the router global (via the comma operator, so the
// returned object is untouched); the next routed turn resets the rolling summary
// and reseeds its TL;DR from it. Absent anchor only costs the reseed.
// ---------------------------------------------------------------------------
const injectCompactionCapture = (file: string): string => {
  const pattern = /return\{ok:!0,summaryText:([$\w]+),/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    debug(
      'patch: complexityRouter: compaction summary site absent - no compaction reseed'
    );
    return file;
  }
  const sumVar = match[1];
  const replacement = `return globalThis.__tweakccRouter&&(globalThis.__tweakccRouter.pendingCompaction=${sumVar}),{ok:!0,summaryText:${sumVar},`;
  const start = match.index;
  const end = start + match[0].length;
  const newFile = file.slice(0, start) + replacement + file.slice(end);
  showDiff(file, newFile, replacement, start, end);
  return newFile;
};

// Locate CC's gB structured side-call helper (a one-shot, Haiku-pinned,
// json-schema side-call) and the km agent-context builder. gB has a near-twin
// `Vpt` with an identical destructure signature, so we anchor on the segment
// unique to gB: it pins `model:<fn>(),enablePromptCaching:` (Vpt has no `model:`).
// km is `function NAME(){return{agentType:"main",agentId:<fn>()}}`.
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

// Locate CC's global session-id accessor for the sidecar key:
// `getSessionId(){return X()}` -> X is a module-scope fn returning the id.
// Optional - if absent, persistence is disabled (router stays in-memory).
const findSessionIdFn = (file: string): string | null => {
  const m = file.match(/getSessionId\(\)\{return ([$\w]+)\(\)\}/);
  return m ? m[1] : null;
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

  // Haiku routing is the only mode now, so gB/km are required. If they can't be
  // found in this build, the router can't classify - no-op gracefully.
  const helpers = findClassifierHelpers(oldFile);
  if (!helpers) {
    console.warn(
      'patch: complexityRouter: gB/km side-call helpers not found in this CC ' +
        'build - cannot route without the Haiku classifier; skipping the router'
    );
    return oldFile;
  }

  const sidFn = findSessionIdFn(oldFile);
  if (!sidFn) {
    debug(
      'patch: complexityRouter: session-id accessor not found - cross-session ' +
        'summary persistence disabled (in-memory only)'
    );
  }

  const afterResolver = wrapEffortResolver(oldFile, config, helpers, sidFn);
  if (afterResolver === null) return null;
  // Graceful no-op (resolver absent) returns the file unchanged: nothing to hook.
  if (afterResolver === oldFile) return oldFile;

  const afterHook = injectSubmitHook(afterResolver);
  if (afterHook === null) return null;
  // All-or-nothing: if the submit handler is absent, don't ship the resolver wrap
  // + runtime with nothing to populate the global (a permanently inert wrap plus
  // dead code). Revert the whole patch instead.
  if (afterHook === afterResolver) {
    debug(
      'patch: complexityRouter: submit handler absent - reverting the resolver ' +
        'wrap too (all-or-nothing no-op)'
    );
    return oldFile;
  }

  // Splices 3 and 4 are optional: a missing capture site only costs
  // prior-assistant context / compaction reseed, so never fail the patch on them.
  return injectCompactionCapture(injectPrevAssistantCapture(afterHook));
};
