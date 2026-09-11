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
//
// Effort is Claude Code's own: each model keeps its level in
// `settings.modelSettings.<model>.effortLevel` (what `/model` writes when you
// adjust effort on a model), falling back to that model's built-in default. CC
// looks that table up by the SESSION model, and a fableplan session resolves to
// the exec model, so without help a Fable plan turn would run at Opus's level.
// `uM` knows which model answers this request, records it in a global, and the
// table lookup reads it — so each side of the pairing gets the level you set
// for that model. An explicit `/effort` for the session still applies to both.
//
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
import { showDiff } from './index';

const ALIAS = 'fableplan';

// Written by the model resolver, read by the per-model effort lookup. `__tweakcc`
// is the repo's patched-binary marker prefix, so a binary carrying it is
// correctly detected as patched. A global rather than a call because the two
// sites live in different bundle modules.
const MODEL_GLOBAL = 'globalThis.__tweakccFablePlanModel';

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
 * Inserted immediately after the destructuring so it answers before the
 * opusplan and haiku branches, and falls through to Claude Code's own
 * resolution for every other alias. `as(alias)` is CC's alias -> concrete model
 * function, so org model restrictions and `[1m]` handling apply unchanged.
 */
const patchPlanResolver = (
  file: string,
  config: FablePlanConfig,
  aliasToModel: string
): string | null => {
  // Method -1 — CC >= 2.1.268: the resolver returns `{model,clampWarning}` and
  // a thin wrapper logs the warning, so every early return is an object.
  const patternObj =
    /(function ([$\w]+)\(([$\w]+)\)\{let\{permissionMode:([$\w]+),mainLoopModel:([$\w]+),exceeds200kTokens:([$\w]+)=!1\}=\3;)(if\(\4!=="plan"\)return\{model:\5,clampWarning:null\};let [$\w]+=([$\w]+)\(\),)/;
  const matchObj = file.match(patternObj);

  // Method 0 — CC >= 2.1.251: the inlined opusplan/haiku branches became a
  // pairing table, and the selected-alias getter moved past an early
  // `if(mode!=="plan")return main`. Call the getter ourselves so we still
  // intercept before that return (exec-side resolution + effort).
  const pattern0 =
    /(function ([$\w]+)\(([$\w]+)\)\{let\{permissionMode:([$\w]+),mainLoopModel:([$\w]+),exceeds200kTokens:([$\w]+)=!1\}=\3;)(if\(\4!=="plan"\)return \5;let [$\w]+=([$\w]+)\(\),)/;
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
  const prefix = match[1];
  const mode = match[4];
  const tableShape = matchObj ?? match0;
  const selected = tableShape ? `${match[8]}()` : match[7];
  const tail = tableShape ? match[7] : '';
  const resolvedModel = `${aliasToModel}(${mode}==="plan"?"${config.planModel}":"${config.execModel}")`;
  // The model and the effort lookup key come out of ONE branch. The global is
  // cleared on the way past for every other alias, so switching away from
  // fableplan cannot leave a stale model steering the effort table.
  const injection =
    `if(${selected}==="${ALIAS}"){${MODEL_GLOBAL}=${resolvedModel};` +
    `${matchObj ? `return{model:${MODEL_GLOBAL},clampWarning:null}` : `return ${MODEL_GLOBAL}`}}` +
    `${MODEL_GLOBAL}=void 0;`;
  const replacement = prefix + injection + tail;
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
 * `n` is the session model, which for fableplan resolves to the exec model.
 * Prefer the model `uM` recorded for this request, so a plan turn reads the
 * planning model's own entry. Nothing else in the resolver changes: env
 * overrides, an explicit session `/effort`, per-turn effort and the per-model
 * caps and defaults all still apply, and every other alias passes through
 * because the global is only set while fableplan is selected.
 */
const patchEffortLookup = (file: string): string | null => {
  if (file.includes(`settingsEffortTable,${MODEL_GLOBAL}??`)) {
    debug('patch: fablePlan: effort lookup already keyed — skipping');
    return file;
  }
  const pattern =
    /(case"inherit":if\(([$\w]+)\.settingsEffortTable===void 0\)return;if\(![$\w]+\(\2\.settingsEffortTable\)\)return \2\.settingsEffortTable\.default;return [$\w]+\(\2\.settingsEffortTable,)/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    if (!file.includes('settingsEffortTable')) {
      debug(
        'patch: fablePlan: no per-model effort table in this build — effort follows the session'
      );
      return file;
    }
    console.error(
      'patch: fablePlan: failed to find the per-model effort lookup'
    );
    return null;
  }
  const replacement = `${match[1]}${MODEL_GLOBAL}??`;
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
  const commit =
    /(function ([$\w]+)\(([$\w]+)\)\{)(let ([$\w]+)=[$\w]+\(\3\),[$\w]+=\5&&[$\w]+!==void 0&&[$\w]+!=="ultracode"\?[$\w]+\([$\w]+,\5\):[$\w]+;if\([$\w]+\("tengu_model_command_menu_effort")/;

  const a = file.match(adjust);
  const d = file.match(display);
  const u = file.match(unsupported);
  const c = file.match(commit);
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
  file = efforted;

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
