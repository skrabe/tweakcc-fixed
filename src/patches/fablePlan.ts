// Please see the note about writing patches in ./index
//
// Adds a "fableplan" model alias: Fable while planning, Opus while executing.
//
// It is a SELECTABLE MODEL ALIAS, deliberately, and that is the whole design.
// The obvious alternative — hooking the plan/execute transition and swapping the
// model — is wrong: `Net({from,to,trigger})` is the mode-change telemetry call,
// so wrapping it mutates state on EVERY plan<->execute transition for EVERY
// user, whether or not they chose this pairing, and it fights `/model`.
//
// Claude Code already ships exactly the right mechanism for two aliases of its
// own, and this rides it:
//
//   function uM(e){ let{permissionMode:t,mainLoopModel:r,...}=e, o=tW();
//     if((o==="opusplan"||o==="opusplan[1m]")&&t==="plan"&&!n){ …Opus… }
//     if(tW()==="haiku"&&t==="plan"){ …Sonnet… }
//     return r }
//
// `uM` answers "which model does THIS request use", gated on the selected alias
// `tW()`. So nothing happens unless the user picks fableplan, the selection
// stays `fableplan` in `/model` throughout, and nothing is ever switched
// underneath them.
//
// Six splices, all anchored on shapes verified against CC 2.1.228:
//   1. the alias whitelist  (`sM()` rejects anything not in it)
//   2. the plan resolver `uM`
//   3. the builtin-default switch
//   4. the alias -> concrete model switch
//   5. the `/model` picker options
//   6. the per-model effort lookup
// and, on later builds, the picker's effort row (8), the clear-context option
// (7) and the per-request effort callers (9).
//
// Effort is Claude Code's own: each model keeps its level in
// `settings.modelSettings.<model>.effortLevel` (what `/model` writes when you
// adjust effort on a model), falling back to that model's built-in default. CC
// looks that table up by the SESSION model, and a fableplan session resolves to
// the exec model, so without help a Fable plan turn would run at Opus's level.
// The table lookup therefore asks the same question `uM` asks — is fableplan
// selected, and is THIS request in plan mode — from the permission mode it is
// handed, so each side of the pairing gets the level you set for that model.
// An explicit `/effort` for the session still applies to both.
//
// No state passes between the two sites. An earlier version had `uM` record
// the model it chose in a global for the lookup to read, but CC also calls
// `uM` as a probe (`uM({permissionMode:"plan",…})` to ask "what would plan mode
// use"), and every probe repointed the next real request's effort at Fable.
// The answer is now a pure function of the selection and the request's mode.
// Earlier versions pinned their own plan/exec levels from tweakcc's config and
// answered before Claude Code's resolver; that shadowed `/effort` and the
// per-model table entirely, and was retired once CC grew per-model levels.

// Scope note, because it nearly went the other way. The splices call helpers
// declared far from where they are injected — the effort resolver reaches for
// the selected-alias getter half a megabyte away, and the plan resolver calls
// the alias-to-model function. Bun's bundle wraps each module as
// `var NAME=v(()=>{…})`, which LOOKS like it would trap those declarations in a
// closure, and a cross-closure call would be a ReferenceError at runtime that
// every parse gate passes. It does not: the `v(()=>{})` body carries only the
// assignments, and the `function` declarations sit at module-outer scope.
// Verified against 2.1.228 by brace balance and by the vanilla bundle's own
// call sites — the alias getter is called from 20.7 MB away, the alias-to-model
// function from 22 MB. Re-check this before moving a splice to a new site.

import { FablePlanConfig } from '../types';
import { debug } from '../utils';
import { escapeIdent, showDiff } from './index';

const ALIAS = 'fableplan';

// Fableplan's answer for a permission mode: the planning model in plan mode
// while fableplan is selected, otherwise undefined. Defined beside `uM`, where
// the selected-alias getter and the alias-to-model function are in scope, and
// read by the per-model effort lookup, which lives in another bundle module and
// can reach neither. Stateless: every call recomputes from its own argument.
// `__tweakcc` is the repo's patched-binary marker prefix.
const MODEL_FOR = 'globalThis.__tweakccFablePlanModelFor';

// Set on the app state handed to the effort lookup by the per-request effort
// resolver, carrying that request's effective permission mode (session mode
// with the context's permission layers applied, the same value `uM` is given).
const MODE_KEY = '__tweakccPermissionMode';

const MODULE_MARK = '/*@@TWEAKCC_MODULE:';

// The bundle module enclosing `at`; the whole file on a single-module bundle.
const moduleBounds = (file: string, at: number): [number, number] => {
  const start = file.lastIndexOf(MODULE_MARK, at);
  if (start === -1) return [0, file.length];
  const next = file.indexOf(MODULE_MARK, start + 1);
  return [start, next === -1 ? file.length : next];
};

// Whether `name` is callable in the module enclosing `at`: declared there, or
// imported there under that same name. A code-split bundle keeps exported
// names unique across chunks, so an unaliased import is the same function.
const boundInModule = (file: string, at: number, name: string): boolean => {
  const [start, end] = moduleBounds(file, at);
  const mod = file.slice(start, end);
  const n = escapeIdent(name);
  if (new RegExp(`(?:^|[^$\\w.])function ${n}\\(`).test(mod)) return true;
  return new RegExp(`import\\{(?:[^}]*,)?${n}(?:,[^}]*)?\\}from"`).test(mod);
};

/**
 * Splice 1 — the alias whitelist.
 *
 * `h9e=["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]",
 *       "fable[1m]","opusplan"]`, read by `sM(e){return h9e.includes(e)}`.
 * Every other site defers to this, so an alias missing here is inert no matter
 * what the rest of the patch does.
 */
const patchAliasWhitelist = (file: string): string | null => {
  // Idempotency must be checked AT THIS SITE, not by asking whether the alias
  // appears anywhere in the bundle: the sibling splices put it in four other
  // places first, so a global check silently skipped the one splice that makes
  // the alias legal at all, and `sM()` then rejected it everywhere.
  // Trailing entries are allowed so the pattern still matches its OWN output;
  // an anchor that cannot see the patched shape reports "failed to find" on the
  // second run rather than "already applied".
  const pattern =
    /(\[(?:"[\w[\]]+",)*"opusplan"(?:,"[\w[\]]+")*\])(\s*,\s*[$\w]+\s*=\s*\["sonnet","opus","haiku")/;
  const match = file.match(pattern);
  if (match && match[1].includes(`"${ALIAS}"`)) {
    debug('patch: fablePlan: alias already in the whitelist — skipping');
    return file;
  }
  if (!match || match.index === undefined) {
    console.error('patch: fablePlan: failed to find the model alias whitelist');
    return null;
  }
  const replacement = match[1].slice(0, -1) + `,"${ALIAS}"]` + match[2];
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);
  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );
  return newFile;
};

/**
 * Splice 2 — the per-request model resolver.
 *
 * Plan mode only, mirroring how CC's own opusplan answers: while fableplan is
 * selected, a plan-mode request uses the planning model. Every other request
 * falls through to Claude Code's own resolution, which for fableplan's exec
 * side is already right: the session model IS the exec model, because the
 * alias resolves through the arm splice 4 cloned. `as(alias)` is CC's alias ->
 * concrete model function, so `[1m]` handling applies unchanged.
 *
 * Also defines `MODEL_FOR` beside the resolver, at module scope, so the effort
 * lookup can ask the same question without reaching names it cannot see.
 */
const patchPlanResolver = (
  file: string,
  config: FablePlanConfig,
  aliasToModel: string
): string | null => {
  // Method -1 — CC >= 2.1.268: the resolver returns `{model,clampWarning}` and
  // a thin wrapper logs the warning, so every early return is an object.
  const patternObj =
    /(function ([$\w]+)\(([$\w]+)\)\{let\{permissionMode:([$\w]+),mainLoopModel:([$\w]+),exceeds200kTokens:([$\w]+)=!1\}=\3;)(if\(\4!=="plan"\)return\{model:\5,clampWarning:null\};)(let [$\w]+=([$\w]+)\(\),)/;
  const matchObj = file.match(patternObj);

  // Method 0 — CC >= 2.1.251: the inlined opusplan/haiku branches became a
  // pairing table, and the selected-alias getter moved past an early
  // `if(mode!=="plan")return main`.
  const pattern0 =
    /(function ([$\w]+)\(([$\w]+)\)\{let\{permissionMode:([$\w]+),mainLoopModel:([$\w]+),exceeds200kTokens:([$\w]+)=!1\}=\3;)(if\(\4!=="plan"\)return \5;)(let [$\w]+=([$\w]+)\(\),)/;
  const match0 = matchObj ? null : file.match(pattern0);

  const pattern1 =
    /(function ([$\w]+)\(([$\w]+)\)\{let\{permissionMode:([$\w]+),mainLoopModel:([$\w]+),exceeds200kTokens:([$\w]+)=!1\}=\3,([$\w]+)=([$\w]+)\(\);)/;
  const match1 = matchObj || match0 ? null : file.match(pattern1);

  const match = matchObj ?? match0 ?? match1;
  if (!match || match.index === undefined) {
    console.error(
      'patch: fablePlan: failed to find the plan-mode model resolver (uM shape)'
    );
    return null;
  }
  const mode = match[4];
  const tableShape = matchObj ?? match0;
  const getter = tableShape ? match[9] : match[8];
  // The getter is called by this very function, so it is in scope here. The
  // alias-to-model function was found by shape anywhere in the bundle, so on a
  // code-split bundle it must be confirmed callable in THIS module.
  if (!boundInModule(file, match.index, aliasToModel)) {
    console.error(
      `patch: fablePlan: ${aliasToModel} is not in scope at the plan-mode model resolver`
    );
    return null;
  }
  const planModel = `${aliasToModel}("${config.planModel}")`;
  // Like opusplan, every plan-mode request goes to the planning model while
  // the alias is selected, whatever model it was handed. The effort lookup
  // asks the same question through MODEL_FOR, so the two always agree.
  const modelFor =
    `${MODEL_FOR}=(m)=>m==="plan"&&${getter}()==="${ALIAS}"?` +
    `${planModel}:void 0;`;
  const replacement = tableShape
    ? `${modelFor}${match[1]}${match[7]}` +
      `if(${getter}()==="${ALIAS}")return${
        matchObj ? `{model:${planModel},clampWarning:null}` : ` ${planModel}`
      };${match[8]}`
    : `${modelFor}${match[1]}` +
      `if(${mode}==="plan"&&${match[7]}==="${ALIAS}")return ${planModel};`;
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);
  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );
  return newFile;
};

/**
 * Splice 3 — the builtin-default switch.
 *
 * `function Gvo(e){let t=T9e();switch(e){case"opus":return zZe(t);…
 *   case"opusplan":return Kvo(t);…}}`
 * Answers "what does this alias default to", used outside plan mode. fableplan
 * mirrors whatever its EXEC model resolves to, since that is its resting state.
 */
const patchBuiltinDefault = (
  file: string,
  config: FablePlanConfig
): string | null => {
  const pattern = new RegExp(
    `(switch\\(([$\\w]+)\\)\\{(?:case"[\\w]+":return [$\\w]+\\([$\\w]+\\);)*?case"${config.execModel}":return ([$\\w]+)\\(([$\\w]+)\\);)`
  );
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    console.error(
      'patch: fablePlan: failed to find the builtin-default alias switch'
    );
    return null;
  }
  const replacement = `${match[1]}case"${ALIAS}":return ${match[3]}(${match[4]});`;
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);
  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );
  return newFile;
};

/**
 * Splice 4 — alias to concrete model.
 *
 * `function as(e){…if(sM(o))switch(o){case"fable":{…}case"opusplan":return
 *   n?aM(vJ(yk())):yk();…case"opus":return n?aM(vJ(ww())):ww();…}}`
 * The exec model's arm is cloned verbatim under the new alias, so fableplan
 * rests on exactly what that alias rests on. Returns the resolver's own name so
 * splice 2 can call it.
 */
const patchAliasToModel = (
  file: string,
  config: FablePlanConfig
): { file: string; resolver: string } | null => {
  const pattern = new RegExp(
    `function ([$\\w]+)\\(([$\\w]+)\\)\\{let [$\\w]+=\\2\\.trim\\(\\)[\\s\\S]{0,120}?if\\([$\\w]+\\(([$\\w]+)\\)\\)switch\\(\\3\\)\\{` +
      `([\\s\\S]{0,600}?case"${config.execModel}":(return [^;]+;))`
  );
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    console.error(
      'patch: fablePlan: failed to find the alias-to-model resolver (as shape)'
    );
    return null;
  }
  const resolver = match[1];
  const upTo = match[0];
  const replacement = `${upTo}case"${ALIAS}":${match[5]}`;
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + upTo.length);
  showDiff(file, newFile, replacement, match.index, match.index + upTo.length);
  return { file: newFile, resolver };
};

/**
 * Splice 5 — the `/model` picker.
 *
 * `function qB_(e,t){let r=BB_(e),n=X.ANTHROPIC_CUSTOM_MODEL_OPTION;…}` builds
 * the option list. Claude Code has a sibling for opusplan
 * (`{value:"opusplan",label:"Opus Plan Mode",description:"Use Opus in plan
 * mode, Sonnet otherwise"}`) but only splices it in when opusplan is ALREADY
 * selected, so the option has to be pushed onto the base list to be pickable.
 */
const patchModelPicker = (
  file: string,
  config: FablePlanConfig
): string | null => {
  const pattern =
    /(function [$\w]+\(([$\w]+),([$\w]+)\)\{let ([$\w]+)=[$\w]+\(\2\),([$\w]+)=[$\w]+\.ANTHROPIC_CUSTOM_MODEL_OPTION;)/;
  // CC 2.1.257 shape: the builder resolves a bootstrap list first and the
  // pickable array became the SECOND declarator, so the list to push onto is no
  // longer the first binding:
  //   function eXr(e,n){let r=X9r(e,n),o=r??V9r(e),d=a.ANTHROPIC_CUSTOM_MODEL_OPTION;
  const pattern257 =
    /(function [$\w]+\(([$\w]+),([$\w]+)\)\{let ([$\w]+)=[$\w]+\(\2,\3\),([$\w]+)=\4\?\?[$\w]+\(\2\),([$\w]+)=[$\w]+\.ANTHROPIC_CUSTOM_MODEL_OPTION;)/;
  // CC 2.1.268 shape: the custom-option read moved out of the first `let`, past
  // a flag-gated merge of the bootstrap list. Anchor on the first statement and
  // confirm the custom-option read follows before the next function — by scope,
  // not distance, because model-customizations and opusplan1m inject pushes here
  // first:
  //   function Vko(e,n){let r=Wko(e,n),o=r??Smn(e),d=r!==null&&Ple()==="flag";
  //     if(d){…}let p=r===null||d,_=a.ANTHROPIC_CUSTOM_MODEL_OPTION;
  const pattern268 =
    /(function [$\w]+\(([$\w]+),([$\w]+)\)\{let ([$\w]+)=[$\w]+\(\2,\3\),([$\w]+)=\4\?\?[$\w]+\(\2\),[^;]*;)(?=(?:(?!function )[^])*?[$\w]+\.ANTHROPIC_CUSTOM_MODEL_OPTION;)/;
  const match257 = file.match(pattern268) ?? file.match(pattern257);
  const match = match257 ?? file.match(pattern);
  if (!match || match.index === undefined) {
    console.error('patch: fablePlan: failed to find the model picker options');
    return null;
  }
  // The pickable array is capture 5 on the 2.1.257 shape and capture 4 on the
  // older one; reading the wrong group silently pushes onto the bootstrap list.
  const list = match257 ? match[5] : match[4];
  const label = `${title(config.planModel)} Plan Mode`;
  const description = `Use ${title(config.planModel)} in plan mode, ${title(config.execModel)} otherwise`;
  const option = JSON.stringify({ value: ALIAS, label, description });
  const injection = `if(!${list}.some((z)=>z.value==="${ALIAS}"))${list}.push(${option});`;
  const replacement = match[1] + injection;
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);
  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );
  return newFile;
};

/**
 * Splice 6 — per-model effort, keyed on the model that answers this request.
 *
 * `case"inherit":if(e.settingsEffortTable===void 0)return;
 *   if(!ee(e.settingsEffortTable))return e.settingsEffortTable.default;
 *   return Z(e.settingsEffortTable,n??e.mainLoopModelForSession??…)`
 *
 * `n` is the model the caller asks about; left unset, the session model, which
 * for fableplan resolves to the exec model. Ask `MODEL_FOR` with the request's
 * permission mode first: in plan mode, splice 2 routes the request to the
 * planning model whatever `n` is, so its effort is read there too; otherwise
 * `n` keys on itself. The mode is the one splice 9 attaches for a request,
 * else the session's own (`e.toolPermissionContext`). Nothing
 * else in the resolver changes: env overrides, an explicit session `/effort`,
 * per-turn effort and the per-model caps and defaults all still apply, and
 * every other alias passes through because `MODEL_FOR` answers only while
 * fableplan is selected and the mode is plan.
 *
 * Returns the lookup function's own name for splice 9.
 */
const patchEffortLookup = (
  file: string
): { file: string; resolver: string | undefined; block: boolean } | null => {
  const key = (state: string): string =>
    `${MODEL_FOR}?.(${state}.${MODE_KEY}??${state}.toolPermissionContext?.mode)??`;
  // The function whose `inherit` arm this is (for splice 9 to find its
  // callers) and its model parameter, which must lead the key expression.
  const resolverAt = (
    at: number,
    state: string
  ): { name: string; model: string } | undefined => {
    const fn = file
      .slice(file.lastIndexOf('function ', at), at)
      .match(/^function ([$\w]+)\(([$\w]+),([$\w]+)[,)]/);
    return fn && fn[2] === state ? { name: fn[1], model: fn[3] } : undefined;
  };
  const noModelArg = (): null => {
    console.error(
      "patch: fablePlan: failed to find the per-model effort lookup's model argument"
    );
    return null;
  };

  // CC >= 2.1.291: the arm became a block that names the model before looking
  // it up, so a carried fallback effort can hold it, and the default shortcut
  // also checks for that carry:
  //   case"inherit":{if(e.settingsEffortTable===void 0)return;
  //     if(xe(e.settingsEffortTable)&&!K())return e.settingsEffortTable.default;
  //     let d=n??e.mainLoopModelForSession??…;
  //     return r&&Jwt(d)!==void 0?void 0:re(e.settingsEffortTable,d)}
  // Keying `d` covers both the hold check and the lookup.
  const block =
    /(case"inherit":\{if\(([$\w]+)\.settingsEffortTable===void 0\)return;if\(!?[$\w]+\(\2\.settingsEffortTable\)(?:&&!?[$\w]+\(\))?\)return \2\.settingsEffortTable\.default;let ([$\w]+)=)([^;]*?\2\.mainLoopModelForSession[^;]*;return [^;]*?[$\w]+\(\2\.settingsEffortTable,\3\)\})/;
  const blockMatch = file.match(block);
  if (blockMatch && blockMatch.index !== undefined) {
    const fn = resolverAt(blockMatch.index, blockMatch[2]);
    if (!fn) return noModelArg();
    const resolver = fn.name;
    if (blockMatch[4].startsWith(`${MODEL_FOR}?.(`)) {
      debug('patch: fablePlan: effort lookup already keyed — skipping');
      return { file, resolver, block: true };
    }
    if (!blockMatch[4].startsWith(`${fn.model}??`)) return noModelArg();
    const replacement = `${blockMatch[1]}${key(blockMatch[2])}${blockMatch[4]}`;
    const newFile =
      file.slice(0, blockMatch.index) +
      replacement +
      file.slice(blockMatch.index + blockMatch[0].length);
    showDiff(
      file,
      newFile,
      replacement,
      blockMatch.index,
      blockMatch.index + blockMatch[0].length
    );
    return { file: newFile, resolver, block: true };
  }
  // The table guard flipped polarity in CC 2.1.280 — `if(!ee(TABLE))` became
  // `if(se(TABLE))`, the negation moving into the predicate — so match either.
  // The splice only needs the `return LOOKUP(TABLE,` site that follows; which
  // way the guard reads says nothing about where the model key goes.
  const pattern =
    /(case"inherit":if\(([$\w]+)\.settingsEffortTable===void 0\)return;if\(!?[$\w]+\(\2\.settingsEffortTable\)\)return \2\.settingsEffortTable\.default;return [$\w]+\(\2\.settingsEffortTable,)/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    if (!file.includes('settingsEffortTable')) {
      debug(
        'patch: fablePlan: no per-model effort table in this build — effort follows the session'
      );
      return { file, resolver: undefined, block: false };
    }
    console.error(
      'patch: fablePlan: failed to find the per-model effort lookup'
    );
    return null;
  }
  const fn = resolverAt(match.index, match[2]);
  if (!fn) return noModelArg();
  const resolver = fn.name;
  const after = match.index + match[0].length;
  if (file.startsWith(`${MODEL_FOR}?.(`, after)) {
    debug('patch: fablePlan: effort lookup already keyed — skipping');
    return { file, resolver, block: false };
  }
  if (!file.startsWith(`${fn.model}??`, after)) return noModelArg();
  const replacement = `${match[1]}${key(match[2])}`;
  const newFile = file.slice(0, match.index) + replacement + file.slice(after);
  showDiff(file, newFile, replacement, match.index, after);
  return { file: newFile, resolver, block: false };
};

/**
 * Splice 9 — hand the effort lookup each request's own permission mode.
 *
 * Every effort caller that has a request context passes only the app state,
 * whose mode is the session's. A request's effective mode can differ — a
 * subagent or SDK message carries a `permission_mode` layer — and that is the
 * mode `uM` routes the request on. Three caller shapes have a context:
 *
 *   A. the per-request resolvers (CC 2.1.291 module of `de`):
 *        `function bh(e){return Sh(e.permissionLayers)??Kl(e.getAppState(),p(e),…)}`
 *      handed `de(e).mode`, CC's effective-permission-context function;
 *   B. hook input, whose context is optional:
 *        `function yd(e,n,r,s){…b=Kl(s?.getAppState?.()??{},h,{withHold:…})`
 *      handed `de(s).mode` when there is a context;
 *   C. subagent spawn and resume:
 *        `function bln({…,model:r,effortState:n,…}){let l=Czn(n),i=Kl(n,r),…`
 *      where `r` is already what `uM` routed the subagent to at spawn, with the
 *      subagent's own mode (`LF(…,mode)`), so it keys on itself, unmapped.
 *
 * Callers with no request context (status, bridge, picker, prompt sections)
 * keep the session's mode.
 */
const ROUTED = 'routed';

const patchEffortContext = (
  file: string,
  resolver: string | undefined,
  required: boolean
): string | null => {
  const fail = (what: string): string | null => {
    if (!required) {
      debug(`patch: fablePlan: ${what} — effort follows the session's mode`);
      return file;
    }
    console.error(`patch: fablePlan: ${what}`);
    return null;
  };
  if (!resolver) return fail('failed to name the per-model effort lookup');
  const ctxFn =
    /function ([$\w]+)\(([$\w]+)\)\{let ([$\w]+)=\2\.getAppState\(\)\.toolPermissionContext[,;]/;
  const ctx = file.match(ctxFn);
  if (!ctx || ctx.index === undefined) {
    return fail('failed to find the effective permission context function');
  }
  const de = ctx[1];
  const r = escapeIdent(resolver);
  const edits: [number, number, string][] = [];

  // A — in any module with both the lookup and `de` in scope.
  const perRequest = new RegExp(
    `([^$\\w.]${r}\\()([$\\w]+)\\.getAppState\\(\\),([$\\w]+)\\(\\2\\)(?=[,)])`,
    'g'
  );
  // B — `Kl(ctx?.getAppState?.()??{},`
  const optional = new RegExp(
    `([^$\\w.]${r}\\()([$\\w]+)\\?\\.getAppState\\?\\.\\(\\)\\?\\?\\{\\},`,
    'g'
  );
  // C — the spawn helper's destructured `model` and `effortState`.
  const spawn = /model:([$\w]+),effortState:([$\w]+)[,}]/g;
  const inScope = (at: number, ...names: string[]): boolean =>
    names.every(n => boundInModule(file, at, n));

  const found = { a: 0, b: 0, c: 0 };
  for (const c of file.matchAll(perRequest)) {
    if (c.index === undefined || !inScope(c.index, resolver, de)) continue;
    found.a++;
    edits.push([
      c.index,
      c.index + c[0].length,
      `${c[1]}{...${c[2]}.getAppState(),${MODE_KEY}:${de}(${c[2]}).mode},${c[3]}(${c[2]})`,
    ]);
  }
  for (const c of file.matchAll(optional)) {
    if (c.index === undefined || !inScope(c.index, resolver, de)) continue;
    found.b++;
    edits.push([
      c.index,
      c.index + c[0].length,
      `${c[1]}{...${c[2]}?.getAppState?.()??{},${MODE_KEY}:${c[2]}?.getAppState?${de}(${c[2]}).mode:void 0},`,
    ]);
  }
  for (const c of file.matchAll(spawn)) {
    if (c.index === undefined || !inScope(c.index, resolver)) continue;
    // The call sits in the body of the function this destructuring opens.
    const body = c.index + c[0].length;
    const next = file.indexOf('function ', body);
    const call = new RegExp(
      `[^$\\w.]${r}\\(${escapeIdent(c[2])},${escapeIdent(c[1])}\\)`
    ).exec(file.slice(body, next === -1 ? undefined : next));
    if (!call) continue;
    found.c++;
    const at = body + call.index + 1;
    edits.push([
      at,
      at + call[0].length - 1,
      `${resolver}({...${c[2]},${MODE_KEY}:"${ROUTED}"},${c[1]})`,
    ]);
  }

  const already = {
    a: file.includes(`.getAppState(),${MODE_KEY}:${de}(`),
    b: file.includes(`??{},${MODE_KEY}:`),
    c: file.includes(`${MODE_KEY}:"${ROUTED}"`),
  };
  for (const [k, what] of [
    ['a', 'the per-request effort resolver'],
    ['b', 'the hook-input effort caller'],
    ['c', 'the subagent-spawn effort caller'],
  ] as const) {
    if (found[k] === 0 && !already[k]) {
      const out = fail(`failed to find ${what}`);
      if (out === null) return null;
    }
  }
  if (edits.length === 0) {
    debug('patch: fablePlan: effort callers already pass the mode — skipping');
    return file;
  }
  let newFile = file;
  for (const [start, end, text] of edits.sort((x, y) => y[0] - x[0])) {
    newFile = newFile.slice(0, start) + text + newFile.slice(end);
  }
  showDiff(
    file,
    newFile,
    edits.map(e => e[2]).join(' … '),
    edits[edits.length - 1][0],
    edits[edits.length - 1][0]
  );
  return newFile;
};

/**
 * Splice 8 — no single effort control on the fableplan row of `/model`.
 *
 * The picker resolves the highlighted alias to one concrete model, so ←/→ on
 * fableplan would pin ONE session-wide level for both sides and save it as the
 * exec model's default. Each side already follows its own model's setting
 * (splice 6), so on this row the arrows do nothing, the effort line says where
 * the levels come from, and confirming the row never writes an effort:
 *   - the adjust handler returns before `supportsEffort` for fableplan;
 *   - the effort line renders a note instead of the level + ←/→ hint;
 *   - the commit passes the alias through with no effort, even if the arrows
 *     were used on another row first.
 */
const patchPickerEffortRow = (
  file: string,
  config: FablePlanConfig
): string | null => {
  if (!file.includes('"modelPicker:decreaseEffort"')) {
    debug('patch: fablePlan: no model-picker effort control in this build');
    return file;
  }
  if (file.includes(`==="${ALIAS}")return;let `)) {
    debug('patch: fablePlan: picker effort row already handled — skipping');
    return file;
  }

  const adjust =
    /(=[$\w]+\(\(([$\w]+)\)=>\{let ([$\w]+)=[$\w]+\(\),([$\w]+)=[$\w]+\.find\(\(([$\w]+)\)=>\5\.value===\3\);if\(\4===void 0\|\|\4\.disabled===!0\)return;)(let ([$\w]+)=[$\w]+\(\3\);if\(!\7\.supportsEffort\)return;)/;
  const display =
    /(([$\w]+)!==void 0&&![$\w]+&&[$\w]+\([$\w]+,\{marginBottom:1,flexDirection:"column",children:)([$\w]+\?)/;
  const unsupported =
    /([$\w]+)\(([$\w]+),\{color:"subtle",children:\[[$\w]+\([$\w]+,\{effort:void 0\}\)," Effort not supported"/;
  const commits = [
    // CC >= 2.1.284: ultracode left the effort scale for its own session flag,
    // so the commit no longer guards the level against it.
    //   function ir(es){let ss=wy(es),Cs=nn(),ws=Yo(),Is=ss&&Cs!==void 0?
    //   zV(Cs,ss):Cs;i("tengu_model_command_menu_effort",…
    /(function ([$\w]+)\(([$\w]+)\)\{)(let ([$\w]+)=[$\w]+\(\3\),(?:[$\w]+=[$\w]+\(\),)*[$\w]+=\5&&([$\w]+)!==void 0\?[$\w]+\(\6,\5\):\6;[$\w]+\("tengu_model_command_menu_effort")/,
    // CC 2.1.281 - 2.1.283: effort state is read through getters inside the commit,
    // and the analytics call is a bare statement.
    //   function Dr(cs){let Ts=vy(cs),Hs=Pn(),_i=qo(),fi=Ts&&Hs!==void 0&&
    //   Hs!=="ultracode"?yG(Hs,Ts):Hs;i("tengu_model_command_menu_effort",…
    /(function ([$\w]+)\(([$\w]+)\)\{)(let ([$\w]+)=[$\w]+\(\3\),(?:[$\w]+=[$\w]+\(\),)*[$\w]+=\5&&([$\w]+)!==void 0&&\6!=="ultracode"\?[$\w]+\(\6,\5\):\6;[$\w]+\("tengu_model_command_menu_effort")/,
    // CC <= 2.1.280.
    /(function ([$\w]+)\(([$\w]+)\)\{)(let ([$\w]+)=[$\w]+\(\3\),[$\w]+=\5&&[$\w]+!==void 0&&[$\w]+!=="ultracode"\?[$\w]+\([$\w]+,\5\):[$\w]+;if\([$\w]+\("tengu_model_command_menu_effort")/,
  ];

  const a = file.match(adjust);
  const d = file.match(display);
  const u = file.match(unsupported);
  let c: RegExpMatchArray | null = null;
  for (const commit of commits) {
    c = file.match(commit);
    if (c) break;
  }
  if (
    !a ||
    a.index === undefined ||
    !d ||
    d.index === undefined ||
    !u ||
    !c ||
    c.index === undefined
  ) {
    console.error(
      'patch: fablePlan: failed to find the model picker effort control'
    );
    return null;
  }
  // The commit's own apply call, `if(sel===DEFAULT){apply(null,effort);return}`,
  // names the function that sets the model; find it inside the same function.
  const tail = file
    .slice(c.index + c[1].length)
    .match(
      new RegExp(
        `^(?:(?!function )[^])*?if\\(${c[3].replace(/\$/g, '\\$')}===[$\\w]+\\)\\{([$\\w]+)\\(null,[$\\w]+\\);return\\}`
      )
    );
  if (!tail) {
    console.error(
      'patch: fablePlan: failed to find the model picker apply call'
    );
    return null;
  }
  const note = JSON.stringify(
    `${title(config.planModel)} and ${title(config.execModel)} each use their own effort (set it on their rows)`
  );
  const edits: [number, number, string][] = [
    [
      a.index,
      a.index + a[0].length,
      `${a[1]}if(${a[3]}==="${ALIAS}")return;${a[6]}`,
    ],
    [
      d.index,
      d.index + d[0].length,
      `${d[1]}${d[2]}==="${ALIAS}"?${u[1]}(${u[2]},{color:"subtle",children:[${note}]}):${d[3]}`,
    ],
    [
      c.index,
      c.index + c[0].length,
      `${c[1]}if(${c[3]}==="${ALIAS}"){${tail[1]}(${c[3]},void 0);return}${c[4]}`,
    ],
  ];
  // Apply back to front so earlier offsets stay valid.
  let newFile = file;
  for (const [start, end, text] of edits.sort((x, y) => y[0] - x[0])) {
    newFile = newFile.slice(0, start) + text + newFile.slice(end);
  }
  showDiff(file, newFile, edits.map(e => e[2]).join(' … '), a.index, a.index);
  return newFile;
};

/**
 * Splice 7 — surface Claude Code's own clear-context option.
 *
 * `let p=it((yt)=>yt.settings.showClearContextOnPlanAccept)??!1` — Claude Code
 * builds the option and then defaults it OFF. Flipping the fallback to true
 * offers "Yes, clear context (N% used) and auto-accept edits", which hands only
 * the plan to the executing model instead of re-sending the whole planning
 * transcript to a different one. Independent of the pairing.
 */
const patchClearContextOption = (file: string): string | null => {
  const pattern =
    /(=[$\w]+\(\([$\w]+\)=>[$\w]+\.settings\.showClearContextOnPlanAccept\)\?\?)!1/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    debug(
      'patch: fablePlan: showClearContextOnPlanAccept gate not present — no-op'
    );
    return file;
  }
  const replacement = `${match[1]}!0`;
  const newFile =
    file.slice(0, match.index) +
    replacement +
    file.slice(match.index + match[0].length);
  showDiff(
    file,
    newFile,
    replacement,
    match.index,
    match.index + match[0].length
  );
  return newFile;
};

const title = (alias: string): string =>
  alias.charAt(0).toUpperCase() + alias.slice(1);

/**
 * The alias sitting in the whitelist is the definitive marker that this patch
 * has run: it is the one splice without which every other one is inert, and no
 * vanilla build ships it. Checked up front so a re-apply is a no-op rather than
 * a second set of splices — five of the six anchors still match their own
 * output and would happily inject twice.
 */
const ALREADY_APPLIED = new RegExp(
  `\\["sonnet",(?:"[\\w[\\]]+",)*"${ALIAS}"[,\\]]`
);

export const writeFablePlan = (
  oldFile: string,
  config: FablePlanConfig
): string | null => {
  if (ALREADY_APPLIED.test(oldFile)) {
    debug('patch: fablePlan: already applied — no-op');
    return oldFile;
  }
  if (config.planModel === config.execModel) {
    console.error(
      'patch: fablePlan: planModel and execModel are the same — nothing to pair'
    );
    return null;
  }

  // The alias-to-model resolver goes first: it hands back its own minified name,
  // which the plan resolver calls.
  const resolved = patchAliasToModel(oldFile, config);
  if (!resolved) return null;
  let file = resolved.file;

  const whitelisted = patchAliasWhitelist(file);
  if (!whitelisted) return null;
  file = whitelisted;

  const planned = patchPlanResolver(file, config, resolved.resolver);
  if (!planned) return null;
  file = planned;

  const defaulted = patchBuiltinDefault(file, config);
  if (!defaulted) return null;
  file = defaulted;

  const picked = patchModelPicker(file, config);
  if (!picked) return null;
  file = picked;

  const efforted = patchEffortLookup(file);
  if (!efforted) return null;
  file = efforted.file;

  // Required where the lookup has its 2.1.291 shape, which is where the
  // per-request caller is known; older shapes keep the session's mode.
  const contexted = patchEffortContext(file, efforted.resolver, efforted.block);
  if (!contexted) return null;
  file = contexted;

  const effortRow = patchPickerEffortRow(file, config);
  if (!effortRow) return null;
  file = effortRow;

  if (config.offerClearContextOnPlanAccept) {
    const cleared = patchClearContextOption(file);
    if (!cleared) return null;
    file = cleared;
  }

  return file;
};
