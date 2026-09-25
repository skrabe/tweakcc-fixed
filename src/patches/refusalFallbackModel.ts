// Please see the note about writing patches in ./index
//
// Give the refusal fallback a configured route table, and switch the session
// back to its own model once the flagged turn has been answered.
//
// When safeguards flag a message, the client retries it on another model and
// latches the session there. The retry's model comes from a table keyed by the
// flagged model and the refusal category, chosen per request by a walker that
// already accepts an override, and both main-loop call sites get that override
// from a supplier whose whole body is `{return}`. This patch answers the
// supplier with the configured routes and makes the walker merge them over the
// defaults, so a category the configuration omits keeps the route it shipped
// with.
//
// The return runs Claude Code's own restore, which unlatches and puts the
// previous model back, and then does what each surface does with a restore's
// result on `/clear`: the REPL and headless each write it into their own app
// state, and headless also drops the model it captured at startup. Both
// register those callbacks on the session's reset event. That event is the
// session-switch broadcast, and its other listeners clear per-session state (the
// prompt-cache ledger, the pid file's job marker, the stream warning latch) and
// report a latch reset, none of which a return may touch. So the same two
// registrations also subscribe their callbacks to a hub of this patch's own,
// built the way the reset event's hub is (one emitter per session root, each
// listener bound to the context it subscribed from), and a turn's end emits
// there alone. The session's other refusal state is left as `/model` leaves it.
//
// Riding Claude Code's own table, restore and app-state writer rather than
// encoding any of them here is the reasoning `fablePlan` records: the
// mechanisms already present respect entitlements, the env escapes and `/model`
// in ways a hardcoded preference would have to re-derive and would then drift
// from.

import { debug } from '../utils';
import { showDiff } from './index';

// Code spliced into one module of the bundle reaches code in another through
// globals. Minified names repeat from one module to the next, so a name written
// at one site binds to whatever that site's own module calls it. `__tweakcc` is
// the repo's patched-binary marker prefix, so a binary carrying one is still
// detected as patched.
const RETURN_GLOBAL = 'globalThis.__tweakccRefusalFallbackReturn';
const ON_RETURN_GLOBAL = 'globalThis.__tweakccRefusalFallbackOnReturn';
const HUB_GLOBAL = 'globalThis.__tweakccRefusalFallbackHub';
const RUNS_GLOBAL = 'globalThis.__tweakccRefusalFallbackRuns';
const LINE_GLOBAL = 'globalThis.__tweakccRefusalFallbackLine';
const MESSAGE_GLOBAL = 'globalThis.__tweakccRefusalFallbackMessage';
const EVENT_GLOBAL = 'globalThis.__tweakccRefusalFallbackEvent';

// The two registrations' stock bodies, kept whole under these names so each
// registration can subscribe to both hubs and still hand back one unsubscribe.
const APPLY_ON_RESET = '__tweakccRefusalFallbackApplyOnReset';
const DROP_ON_RESET = '__tweakccRefusalFallbackDropOnReset';

/** Consecutive returns before a fallback that keeps being flagged is kept. */
const DEFAULT_MAX_RETURNS = 1;

const MODULE_MARK = '/*@@TWEAKCC_MODULE:';

/** The virtual-bundle module holding `at`: [start, end) of its text. */
const moduleSpan = (file: string, at: number): [number, number] => {
  const start = file.lastIndexOf(MODULE_MARK, at);
  const next = file.indexOf(MODULE_MARK, start === -1 ? 0 : start + 1);
  return [start === -1 ? 0 : start, next === -1 ? file.length : next];
};

const escapeName = (name: string): string => name.replace(/\$/g, '\\$');

const splice = (
  file: string,
  at: number,
  length: number,
  replacement: string
): string => {
  const newFile = file.slice(0, at) + replacement + file.slice(at + length);
  showDiff(file, newFile, replacement, at, at + length);
  return newFile;
};

/**
 * What this build accepts in a route, read from the bundle: the refusal
 * categories it knows and how many models of a chain it tries. Either is left
 * out when its site is not found, and the check that needs it is skipped.
 */
interface RouteLimits {
  categories?: Set<string>;
  chainLength?: number;
}

const routeLimits = (file: string): RouteLimits => {
  const limits: RouteLimits = {};

  // A route is cut to its first N models before it is walked.
  const chain = file.match(
    /function [$\w]+\(([$\w]+)\)\{return\(typeof \1==="string"\?\[\1\]:\1\)\.slice\(0,([$\w]+)\)\}/
  );
  if (chain?.index !== undefined) {
    const [start, end] = moduleSpan(file, chain.index);
    const value = file
      .slice(start, end)
      .match(
        new RegExp(`(?<![$\\w.])${escapeName(chain[2])}=(\\d+)(?![\\d.])`)
      );
    if (value) limits.chainLength = Number(value[1]);
  }

  // The category normaliser keeps a category one of its two predicates accepts
  // and reports anything else as "other", so the predicates list every category
  // the build knows, including those no shipped table routes.
  const normalise = file.match(
    /function [$\w]+\(([$\w]+)\)\{return ([$\w]+)\(\1\)\|\|([$\w]+)\(\1\)\?\1:"other"\}/
  );
  if (normalise?.index !== undefined) {
    const [start, end] = moduleSpan(file, normalise.index);
    const text = file.slice(start, end);
    const categories = new Set<string>();
    for (const predicate of [normalise[2], normalise[3]]) {
      const body = text.match(
        new RegExp(
          `function ${escapeName(predicate)}\\(([$\\w]+)\\)\\{return ([^}]*)\\}`
        )
      );
      if (!body) return limits;
      for (const literal of body[2].matchAll(
        new RegExp(`${escapeName(body[1])}==="([^"]+)"`, 'g')
      )) {
        categories.add(literal[1]);
      }
    }
    if (categories.size > 0) limits.categories = categories;
  }
  return limits;
};

/**
 * The routes as a model id or a chain of them per category, keeping only the
 * entries the walker can use. Both settings come from a hand-edited config.json,
 * and a route that is neither throws in the walker at refusal time. A category
 * the build does not know, or a chain longer than it tries, is kept and named:
 * the first never matches and the second is cut short, and neither says so
 * when a message is flagged.
 */
const validRoutes = (
  routes: unknown,
  limits: RouteLimits
): Record<string, string | string[]> => {
  if (routes === undefined || routes === null) return {};
  if (typeof routes !== 'object' || Array.isArray(routes)) {
    console.warn(
      'patch: refusalFallbackModel: refusalFallbackRoutes should map a refusal category to a model id or a list of them; ignoring it'
    );
    return {};
  }
  const valid: Record<string, string | string[]> = {};
  for (const [category, route] of Object.entries(routes)) {
    const chain: unknown[] = Array.isArray(route) ? route : [route];
    if (
      chain.length === 0 ||
      !chain.every(model => typeof model === 'string' && model.trim() !== '')
    ) {
      console.warn(
        `patch: refusalFallbackModel: skipping refusalFallbackRoutes.${category}: a route is a model id or a non-empty list of model ids`
      );
      continue;
    }
    if (limits.categories && !limits.categories.has(category)) {
      console.warn(
        `patch: refusalFallbackModel: refusalFallbackRoutes.${category} is not a refusal category this Claude Code knows (${[...limits.categories].join(', ')}), so it never matches`
      );
    }
    if (limits.chainLength !== undefined && chain.length > limits.chainLength) {
      console.warn(
        `patch: refusalFallbackModel: refusalFallbackRoutes.${category} lists ${chain.length} models, and Claude Code tries only the first ${limits.chainLength}`
      );
    }
    valid[category] = route as string | string[];
  }
  return valid;
};

/**
 * The return budget as a whole number of returns, or `null` for no limit; an
 * absent setting takes the default. It is written into the turn-end code as a
 * literal, so anything else is replaced by the default rather than spliced.
 */
const validMaxReturns = (maxReturns: unknown): number | null => {
  if (maxReturns === undefined) return DEFAULT_MAX_RETURNS;
  if (maxReturns === null) return null;
  if (
    typeof maxReturns === 'number' &&
    Number.isInteger(maxReturns) &&
    maxReturns >= 0
  ) {
    return maxReturns;
  }
  console.warn(
    `patch: refusalFallbackModel: refusalFallbackMaxReturns should be a whole number of returns or null; using ${DEFAULT_MAX_RETURNS}`
  );
  return DEFAULT_MAX_RETURNS;
};

/**
 * Splice 1: merge the override over the defaults.
 *
 * Anchored on the destructure plus the `??`, which appears once. The default
 * table's name is captured from the same match rather than assumed, so it moves
 * with the release.
 */
const patchRouteMerge = (file: string): string | null => {
  const pattern =
    /(function [$\w]+\(([$\w]+)\)\{let\{originalModelCanonical:([$\w]+),apiRefusalCategory:[$\w]+\}=\2,[$\w]+=)\2\.routesOverride\?\?([$\w]+)\(\3\)/;
  const match = file.match(pattern);
  if (!match || match.index === undefined) {
    if (/routesOverride\?\?\{\}\)/.test(file)) {
      debug('patch: refusalFallbackModel: routes already merged, skipping');
      return file;
    }
    console.error(
      'patch: refusalFallbackModel: failed to find the refusal route walker'
    );
    return null;
  }
  const [, head, arg, model, table] = match;
  return splice(
    file,
    match.index,
    match[0].length,
    `${head}Object.assign({},${table}(${model}),${arg}.routesOverride??{})`
  );
};

/**
 * Splice 2: answer with the configured routes.
 *
 * The supplier is selected by two facts together: its body is `{return}`, and
 * its name is passed as `routesOverride`. The body alone is not a
 * discriminator, because many declarations in the bundle share it; only one of
 * those is ever handed to the walker.
 */
const patchRouteSupplier = (
  file: string,
  routes: Record<string, string | string[]>
): string | null => {
  const serialized = JSON.stringify(routes);
  if (file.includes(`{return ${serialized}}`)) {
    debug('patch: refusalFallbackModel: routes already supplied, skipping');
    return file;
  }
  const candidates = [...file.matchAll(/function ([$\w]+)\(\)\{return\}/g)];
  const match = candidates.find(
    c => c[1] !== undefined && file.includes(`routesOverride:${c[1]}()`)
  );
  if (!match || match.index === undefined) {
    console.error(
      'patch: refusalFallbackModel: failed to find the refusal routes supplier'
    );
    return null;
  }
  return splice(
    file,
    match.index,
    match[0].length,
    `function ${match[1]}(){return ${serialized}}`
  );
};

/**
 * The return hub, made on first use with the reset hub's own registry and
 * emitter factory: one emitter per session root, and a listener bound to the
 * context it subscribed from, so a callback runs where it would on `/clear`.
 */
const returnHub = (registry: string, emitter: string): string =>
  `(${HUB_GLOBAL}??=new ${registry}(()=>${emitter}()))`;

/**
 * What a turn's end runs: return the session if a latch is outstanding and the
 * budget allows, hand the restore's result to the callbacks subscribed for this
 * session, and say what happened so the surface can put it in the transcript.
 * Beside it, the subscription those callbacks use.
 *
 * The restore decides the rest for itself. It unlatches and returns nothing
 * when the override is no longer the model the latch installed, so a `/model`
 * chosen during the turn is left alone.
 *
 * Returning has a budget. A conversation whose subject keeps tripping a
 * safeguard is flagged again the moment it is handed back, and each attempt
 * spends the flagged model's rate limit and gives no answer. So the budget
 * counts CONSECUTIVE returns, and it is kept per session root, where the reset
 * hub keeps its emitters, so sessions ending turns in one process each have
 * their own. A turn that ends with no latch resets it, and so does a new session
 * id on the same root, since resuming another conversation re-latches through
 * the same writer. Once spent, the latch is left in place, which is what the
 * unpatched client does, and the surface is told once.
 *
 * https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
 */
const RETURN_FUNCTIONS = (
  state: string,
  restore: string,
  registry: string,
  emitter: string,
  maxReturns: number | null
): string => {
  const hold =
    maxReturns === null
      ? ''
      : `if(__tweakccR.returns>=${maxReturns}){if(__tweakccR.held)return;__tweakccR.held=!0;` +
        'return{held:!0,returns:__tweakccR.returns,model:__tweakccL.previousOverride??__tweakccL.previousModelForSession??__tweakccL.previousAppStateModel,fallback:__tweakccL.fallbackModel}}';
  return (
    `${ON_RETURN_GLOBAL}=(__tweakccF)=>${returnHub(registry, emitter)}.of(${state}()).subscribe(__tweakccF);` +
    `${RETURN_GLOBAL}=()=>{` +
    `let __tweakccS=${state}(),__tweakccL=__tweakccS.modelSelection.refusalFallbackModelLatch(),__tweakccR=(${RUNS_GLOBAL}??=new ${registry}(()=>({}))).of(__tweakccS);` +
    'if(__tweakccR.session!==__tweakccS.id){__tweakccR.session=__tweakccS.id;__tweakccR.returns=0;__tweakccR.held=!1}' +
    'if(!__tweakccL){__tweakccR.returns=0;__tweakccR.held=!1;return}' +
    hold +
    `let __tweakccT=${restore}();if(!__tweakccT)return;__tweakccR.returns++;` +
    `${returnHub(registry, emitter)}.of(__tweakccS).emit(__tweakccT);` +
    'return{held:!1,returns:__tweakccR.returns,model:__tweakccT.overrideValue??__tweakccT.forSessionValue??__tweakccT.appStateModel,fallback:__tweakccT.fallbackModel}};'
  );
};

/**
 * Splice 3: publish the turn-end return and its subscription beside Claude
 * Code's restore.
 *
 * Anchored on the restore's body rather than its name. The registry and emitter
 * factory come from the reset hub declared in the same module, the one whose
 * subscribe resolves the session through the same accessor the restore reads.
 * Function declarations hoist, so the assignments are written in front of the
 * restore and still see everything they name; the hub is made on first use,
 * after every module has loaded.
 */
const patchPublishReturn = (
  file: string,
  maxReturns: number | null
): string | null => {
  if (file.includes(`${RETURN_GLOBAL}=`)) {
    debug('patch: refusalFallbackModel: return already published, skipping');
    return file;
  }
  const restore = file.match(
    /function ([$\w]+)\(\)\{let ([$\w]+)=([$\w]+)\(\),([$\w]+)=\2\.modelSelection\.refusalFallbackModelLatch\(\);if\(\2\.modelSelection\.unlatchRefusalFallbackModel\(\),!\4\|\|\2\.modelSelection\.mainLoopModelOverride\(\)!==\4\.fallbackModel\)return;return \2\.modelSelection\.overrideMainLoopModel\(\4\.previousOverride\)/
  );
  if (!restore || restore.index === undefined) {
    console.error(
      'patch: refusalFallbackModel: failed to find the fallback-restore function'
    );
    return null;
  }
  const [start, end] = moduleSpan(file, restore.index);
  const hub = [
    ...file
      .slice(start, end)
      .matchAll(
        /var ([$\w]+)=new ([$\w]+)\(\(\)=>([$\w]+)\(\)\);function [$\w]+\(([$\w]+)\)\{return \1\.of\(([$\w]+)\(\)\)\.subscribe\(\4\)\}/g
      ),
  ].find(m => m[5] === restore[3]);
  if (!hub) {
    console.error(
      "patch: refusalFallbackModel: failed to find the reset event's hub in the restore's module"
    );
    return null;
  }
  return splice(
    file,
    restore.index,
    0,
    RETURN_FUNCTIONS(restore[3], restore[1], hub[2], hub[3], maxReturns)
  );
};

/**
 * Splice 4: subscribe the two restore callbacks to the return hub.
 *
 * The app-state registration is the one that reports the latch reset; the REPL
 * and headless each call it with their own setState, and its writer is what it
 * runs on a restore's result. Headless's model-drop registration subscribes
 * through the same function in the same module and calls its callback when a
 * restore has a result. Each keeps its stock body under a new name and
 * subscribes the same callback to the return hub, without the telemetry, which
 * belongs to the resets the event reports. The unsubscribe it hands back leaves
 * both hubs, since the REPL runs it when its store changes.
 */
const patchSubscribeCallbacks = (file: string): string | null => {
  if (file.includes(`function ${APPLY_ON_RESET}(`)) {
    debug(
      'patch: refusalFallbackModel: restore callbacks already subscribed, skipping'
    );
    return file;
  }
  const apply = file.match(
    /function ([$\w]+)\(([$\w]+)\)\{return ([$\w]+)\(\(([$\w]+),([$\w]+),([$\w]+)\)=>\{if\(!\6\)return;([$\w]+)\(\6,\2\),[$\w]+\("tengu_refusal_fallback_latch_reset",/
  );
  if (!apply || apply.index === undefined) {
    console.error(
      "patch: refusalFallbackModel: failed to find the restore's app-state registration"
    );
    return null;
  }
  const [, applyName, setState, subscribe, , , , writer] = apply;
  const [start, end] = moduleSpan(file, apply.index);
  const drops = [
    ...file
      .slice(start, end)
      .matchAll(
        new RegExp(
          `function ([$\\w]+)\\(([$\\w]+)\\)\\{return ${escapeName(subscribe)}\\(\\(([$\\w]+),([$\\w]+),([$\\w]+)\\)=>\\{if\\(\\5\\)\\2\\(\\)\\}\\)\\}`,
          'g'
        )
      ),
  ];
  if (drops.length !== 1 || drops[0].index === undefined) {
    console.error(
      "patch: refusalFallbackModel: failed to find headless's model-drop registration"
    );
    return null;
  }
  const [, dropName, callback] = drops[0];
  const dropAt = start + drops[0].index;

  // The later site first, so the earlier one's offset still holds.
  const [first, second] =
    dropAt > apply.index
      ? [
          { at: dropAt, name: dropName, param: callback, kind: 'drop' },
          { at: apply.index, name: applyName, param: setState, kind: 'apply' },
        ]
      : [
          { at: apply.index, name: applyName, param: setState, kind: 'apply' },
          { at: dropAt, name: dropName, param: callback, kind: 'drop' },
        ];
  let out = file;
  for (const site of [first, second]) {
    const stock = site.kind === 'apply' ? APPLY_ON_RESET : DROP_ON_RESET;
    const onReturn =
      site.kind === 'apply'
        ? `(__tweakccT)=>${writer}(__tweakccT,${site.param})`
        : `()=>${site.param}()`;
    const head = `function ${site.name}(${site.param}){`;
    out = splice(
      out,
      site.at,
      head.length,
      `${head}let __tweakccU=${stock}(${site.param}),__tweakccV=${ON_RETURN_GLOBAL}?.(${onReturn});` +
        `return()=>{__tweakccV?.(),__tweakccU()}}function ${stock}(${site.param}){`
    );
  }
  return out;
};

/**
 * Splice 5: publish the line a return puts in the transcript.
 *
 * Written beside the copy for the switch itself ("Switched to X."), whose model
 * names come from the display-name function captured here, so the line names
 * models the way the fallback's own message does. A spent budget says the
 * flagged model came back flagged only when a return had happened; with a
 * budget of 0 the session never left the fallback.
 */
const patchPublishLine = (file: string): string | null => {
  if (file.includes(`${LINE_GLOBAL}=`)) {
    debug('patch: refusalFallbackModel: line already published, skipping');
    return file;
  }
  const switched = file.match(
    /function [$\w]+\(([$\w]+),([$\w]+),([$\w]+)\)\{return [$\w]+\("switched",\{model:([$\w]+)\(\1\),fallback:\2\},\1,\3\)\?\?`Switched to \$\{\2\}\.`\}/
  );
  if (!switched || switched.index === undefined) {
    console.error(
      "patch: refusalFallbackModel: failed to find the fallback's switch message"
    );
    return null;
  }
  const name = switched[4];
  const line =
    `${LINE_GLOBAL}=(__tweakccN)=>{` +
    `let __tweakccM=__tweakccN.model==null?"the default model":${name}(__tweakccN.model),__tweakccF=${name}(__tweakccN.fallback);` +
    'return __tweakccN.held' +
    '?{content:"Staying on "+__tweakccF+" for this session \\xB7 "+(__tweakccN.returns?__tweakccM+" was flagged again after switching back \\xB7 ":"")+"/model to change",level:"warning"}' +
    ':{content:"Switched back to "+__tweakccM+".",level:"notice"}};';
  return splice(file, switched.index, 0, line);
};

/**
 * Splice 6: publish the REPL's system-message constructor, so the line is the
 * same kind of message as the fallback's own.
 */
const patchPublishMessage = (file: string): string | null => {
  if (file.includes(`${MESSAGE_GLOBAL}=`)) {
    debug(
      'patch: refusalFallbackModel: message constructor already published, skipping'
    );
    return file;
  }
  const message = file.match(
    /function ([$\w]+)\(([$\w]+),([$\w]+)\)\{return\{type:"system",subtype:"informational",content:\2,isMeta:!1,timestamp:new Date\(\)\.toISOString\(\),uuid:[$\w]+\(\),level:\3\}\}/
  );
  if (!message || message.index === undefined) {
    console.error(
      'patch: refusalFallbackModel: failed to find the system-message constructor'
    );
    return null;
  }
  return splice(file, message.index, 0, `${MESSAGE_GLOBAL}=${message[1]};`);
};

/**
 * Splice 7: publish headless's event queue. Headless drains it right after a
 * turn's end and ahead of the turn's result, so an event queued there lands in
 * the turn's own output.
 */
const patchPublishEvent = (file: string): string | null => {
  if (file.includes(`${EVENT_GLOBAL}=`)) {
    debug(
      'patch: refusalFallbackModel: event queue already published, skipping'
    );
    return file;
  }
  const queue = file.match(
    /function [$\w]+\([$\w]+\)\{([$\w]+)\(\)\.setEnqueueListener\([$\w]+\)\}function ([$\w]+)\(([$\w]+)\)\{\1\(\)\.enqueue\(\3\)\}/
  );
  if (!queue || queue.index === undefined) {
    console.error(
      'patch: refusalFallbackModel: failed to find the SDK event queue'
    );
    return null;
  }
  return splice(file, queue.index, 0, `${EVENT_GLOBAL}=${queue[2]};`);
};

/**
 * Splice 8: return at the end of an interactive turn.
 *
 * The `finally` after `await this._runImpl(...)` runs once per turn, after any
 * retry the turn made, so the flagged message has been answered on the fallback
 * by then. The line goes into the transcript through the same append that
 * `finally` uses for its own messages. The splice is guarded so nothing it does
 * can keep the rest of the `finally` from running.
 */
const patchReturnOnReplTurnEnd = (file: string): string | null => {
  // The splice goes after `finally{`, which leaves the anchor matching, so the
  // already-patched check comes first.
  const marker = `}finally{try{let __tweakccN=${RETURN_GLOBAL}`;
  if (file.includes(marker)) {
    debug(
      'patch: refusalFallbackModel: REPL turn end already spliced, skipping'
    );
    return file;
  }
  const turn = file.match(/=await this\._runImpl\([$\w]+,[^)]*\)\}finally\{/);
  if (!turn || turn.index === undefined) {
    console.error(
      "patch: refusalFallbackModel: failed to find the REPL's turn-end finally"
    );
    return null;
  }
  const at = turn.index + turn[0].length;
  const append = file
    .slice(at, at + 2000)
    .match(
      /([$\w]+)\(\{type:"append",messages:this\.stream\.pendingPreservedInsert\.preserved\}\)/
    );
  if (!append) {
    console.error(
      "patch: refusalFallbackModel: failed to find the REPL's transcript append"
    );
    return null;
  }
  const code =
    `try{let __tweakccN=${RETURN_GLOBAL}?.();if(__tweakccN){` +
    `let __tweakccL=${LINE_GLOBAL}?.(__tweakccN),__tweakccM=__tweakccL&&${MESSAGE_GLOBAL}?.(__tweakccL.content,__tweakccL.level);` +
    `if(__tweakccM)${append[1]}({type:"append",messages:[__tweakccM]})}}catch{}`;
  return splice(file, at, 0, code);
};

/**
 * Splice 9: return at the end of a headless turn.
 *
 * The dispatcher's three-parameter `noteTurnEnded`, reached once from the
 * result handler. Two sibling methods share the name: the selector's one-line
 * `noteTurnEnded(e){…}`, which this one delegates to, and an observer
 * broadcast. The three-parameter body discriminates.
 */
const patchReturnOnHeadlessTurnEnd = (file: string): string | null => {
  const turn = file.match(
    /noteTurnEnded\(([$\w]+),([$\w]+),([$\w]+)\)\{if\(this\.selector\.noteTurnEnded\(\1\),\1\|\|\3\.num_turns>0\)\{/
  );
  if (!turn || turn.index === undefined) {
    if (
      /noteTurnEnded\([$\w]+,[$\w]+,[$\w]+\)\{try\{let __tweakccN=/.test(file)
    ) {
      debug(
        'patch: refusalFallbackModel: headless turn end already spliced, skipping'
      );
      return file;
    }
    console.error(
      "patch: refusalFallbackModel: failed to find the dispatcher's noteTurnEnded"
    );
    return null;
  }
  const at =
    turn.index + `noteTurnEnded(${turn[1]},${turn[2]},${turn[3]}){`.length;
  const code =
    `try{let __tweakccN=${RETURN_GLOBAL}?.();if(__tweakccN){` +
    `let __tweakccL=${LINE_GLOBAL}?.(__tweakccN);` +
    `if(__tweakccL)${EVENT_GLOBAL}?.({type:"system",subtype:"informational",content:__tweakccL.content,level:__tweakccL.level})}}catch{}`;
  return splice(file, at, 0, code);
};

/**
 * Route a flagged message by the configured table, and switch back once the
 * flagged turn is answered, at most `maxReturns` times in a row.
 *
 * Categories absent from `routes` keep the route they shipped with, because the
 * override is merged rather than substituted. Each value is a model id or a
 * chain walked until one is usable, and the ids are full because every stage
 * goes through the catalogue lookup. Both arguments are validated here, since
 * they arrive from config.json as written.
 */
export const writeRefusalFallbackModel = (
  oldFile: string,
  routes: unknown = {},
  maxReturns: unknown = DEFAULT_MAX_RETURNS
): string | null => {
  const budget = validMaxReturns(maxReturns);
  const valid = validRoutes(routes, routeLimits(oldFile));
  const steps: Array<(file: string) => string | null> = [
    patchRouteMerge,
    file => patchRouteSupplier(file, valid),
    // Choosing the model and returning to the session's own afterwards are one
    // behaviour, so they share a toggle: half of it would either move the
    // session and leave it there, or return it to a model the table had picked.
    file => patchPublishReturn(file, budget),
    patchSubscribeCallbacks,
    patchPublishLine,
    patchPublishMessage,
    patchPublishEvent,
    patchReturnOnReplTurnEnd,
    patchReturnOnHeadlessTurnEnd,
  ];
  let file: string | null = oldFile;
  for (const step of steps) {
    file = step(file);
    if (file === null) return null;
  }
  return file;
};
