import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeRefusalFallbackModel } from './refusalFallbackModel';

// Every fixture below is copied verbatim from the pristine 2.1.281 bundle at
// the site the patch targets, inside the module that holds it. Text invented to
// resemble a site passes a patch that lands somewhere else entirely, which is
// the one failure these tests exist to catch.

const module = (index: number, chunk: string, ...body: string[]): string =>
  `\n/*@@TWEAKCC_MODULE:${index}:/$bunfs/root/${chunk}@@*/\n${body.join('')}`;

// Session state: the reset event's announcement, the restore, and the reset
// event's hub with its subscribe.
const EMITTER =
  'function cn(e,t,o){let r=fn.of(e);if(o)r.emit(e.id,t,o);else r.emit(e.id,t)}';
const RESTORE =
  'function gn(){let e=n(),t=e.modelSelection.refusalFallbackModelLatch();if(e.modelSelection.unlatchRefusalFallbackModel(),!t||e.modelSelection.mainLoopModelOverride()!==t.fallbackModel)return;return e.modelSelection.overrideMainLoopModel(t.previousOverride),{appStateModel:t.previousAppStateModel,forSessionValue:t.previousModelForSession,overrideValue:t.previousOverride,restoredToExplicitOverride:t.previousOverride!==void 0,fallbackModel:t.fallbackModel}}';
const EVENT =
  'var fn=new Mt(()=>Fe());function Pd(e){return fn.of(n()).subscribe(e)}';

// The restore's callbacks: the app-state registration the REPL and headless
// both call with their own setState, headless's model-drop registration, and
// the app-state writer.
const APPLY_REGISTRATION =
  'function kft(e){return Pd((o,r,n)=>{if(!n)return;Qt(n,e),i("tengu_refusal_fallback_latch_reset",{source:c(r),restored_to_explicit_override:n.restoredToExplicitOverride,model_scope:c(kz(n.fallbackModel))})})}';
const DROP_REGISTRATION = 'function P2r(e){return Pd((o,r,n)=>{if(n)e()})}';
const WRITER =
  'function Qt(e,o){let r,n;if(o((l)=>{let d=e.overrideValue??e.forSessionValue??e.appStateModel,s=ro()?wE(d,l.fastMode):!!l.fastMode;return r=l.fastMode,n=s,l.mainLoopModel===e.appStateModel&&l.mainLoopModelForSession===e.forSessionValue&&s===!!l.fastMode?l:{...l,mainLoopModel:e.appStateModel,mainLoopModelForSession:e.forSessionValue,fastMode:s}}),n!==void 0)vE(r,n);zu(e.overrideValue)}';

// Headless's SDK event queue.
const QUEUE =
  'function Tke(e){nr().setEnqueueListener(e)}function Fa(e){nr().enqueue(e)}';

// The refusal copy and routing: the walker, the routes supplier, the message
// for the switch, and what a route may hold: the category predicates and their
// normaliser, and the chain cut with its length. The length's declaration is
// cut after the constant; the route tables that follow it in the same
// statement are not needed here.
const WALKER =
  'function Dmr(e){let{originalModelCanonical:n,apiRefusalCategory:r}=e,s=e.routesOverride??_2(n),g=r!=null&&Object.hasOwn(s,r)?s[r]:void 0;if(g!==void 0){let h=w2(g),_=Mmr(h,e.resolveTarget);if(_!==void 0)return{matched:"category",model:_.model,remainingChain:_.remainingChain,skippedStages:_.skippedStages,chainLength:h.length};return{matched:"none",model:void 0,reason:"mapped_target_unresolvable",skippedStages:h.slice(0,-1),chainLength:h.length}}if(S2()&&!e.armedTargetIsRefusingModel)return{matched:"catch_all",model:e.armedFallbackModel};return{matched:"none",model:void 0,reason:"unmapped"}}';
const SUPPLIER = 'function o0n(){return}';
const SWITCHED =
  'function kT(e,n,r){return zmr("switched",{model:li(e),fallback:n},e,r)??`Switched to ${n}.`}';
const CATEGORIES =
  'function uXt(e){return e==="cyber"||e==="bio"}function f2(e){return e==="frontier_llm"||e==="reasoning_extraction"}function A7(e){return uXt(e)||f2(e)?e:"other"}';
const CHAIN_LENGTH = 'var p2=3;';
const CHAIN = 'function w2(e){return(typeof e==="string"?[e]:e).slice(0,p2)}';

// The main loop that asks for the routes, and the REPL's message constructor.
// The supplier is reached only through the call site's shape; the other
// empty-body functions in the bundle may not be touched.
const CALL_SITE =
  'el:h.model,triedModels:[Ize(h.model)]}),routesOverride:o0n()}):void 0,pl=Pi!==void 0?Pi.model:Gi;';
const DECOY = 'function Rit(){return}';
const MESSAGE =
  'function Rx(e,n){return{type:"system",subtype:"informational",content:e,isMeta:!1,timestamp:new Date().toISOString(),uuid:rnn(),level:n}}';

const REPL =
  'Yo=await this._runImpl(dt,jo,h,k,D,V,ee,Ce,Pe,De,Le,zo,We,Co??void 0,Je,$e)}finally{eo.clearPending(),this.stream.deferredSlashEchoUuid=null;try{ut.flush()}catch(Zo){u(Zo)}if(this._frameNotifier.flush(),this.stream.pendingPreservedInsert!==null)i("tengu_compact_preserved_unanchored",{preservedCount:this.stream.pendingPreservedInsert.preserved.length}),ko({type:"append",messages:this.stream.pendingPreservedInsert.preserved}),this.stream.pendingPreservedInsert=null;';

const HEADLESS =
  'noteTurnEnded(e,r,n){if(this.selector.noteTurnEnded(e),e||n.num_turns>0){if(!e&&this.heldCompletionChars>0)y("print_task_notification_coalesce");this.heldCompletionChars=0,this.heldCompletionWorkload=void 0}else if(r.queryHeldForNextTurn===!0&&typeof r.value==="string"&&n.result==="")this.heldCompletionChars+=r.value.length,this.heldCompletionWorkload=r.workload}';

const SESSION_STATE = module(15, 'chunk-w7yjn2r1.js', EMITTER, RESTORE, EVENT);
const ROUTING = module(
  244,
  'chunk-f1d8q1ry.js',
  CATEGORIES,
  CHAIN_LENGTH,
  SUPPLIER,
  SWITCHED,
  CHAIN,
  WALKER
);

const bundle = (sessionState = SESSION_STATE, routing = ROUTING): string =>
  [
    sessionState,
    module(128, 'chunk-zfg8t6ef.js', QUEUE),
    routing,
    module(355, 'chunk-k0q6ndrk.js', MESSAGE, DECOY, CALL_SITE),
    module(
      565,
      'chunk-bja7hb37.js',
      APPLY_REGISTRATION,
      DROP_REGISTRATION,
      WRITER
    ),
    module(1223, 'chunk-skp01brc.js', HEADLESS),
    module(1405, 'chunk-cz85x099.js', REPL),
  ].join('');

const BUNDLE = bundle();

const ROUTES = {
  bio: ['claude-opus-5', 'claude-opus-4-8'],
  cyber: ['claude-opus-5', 'claude-opus-4-8'],
};

const patched = (...args: unknown[]): string => {
  const out = writeRefusalFallbackModel(
    BUNDLE,
    ...(args as [unknown, unknown])
  );
  expect(out).not.toBeNull();
  return out as string;
};

/** A module's text in a virtual bundle, by its index. */
const moduleText = (file: string, index: number): string => {
  const mark = `/*@@TWEAKCC_MODULE:${index}:`;
  const start = file.indexOf(mark);
  const next = file.indexOf('/*@@TWEAKCC_MODULE:', start + mark.length);
  return file.slice(
    file.indexOf('@@*/', start) + 4,
    next === -1 ? undefined : next
  );
};

const warnings = () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return () => warn.mock.calls.map(call => String(call[0]));
};

afterEach(() => {
  vi.restoreAllMocks();
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(g)) {
    if (key.startsWith('__tweakccRefusalFallback')) delete g[key];
  }
});

describe('writeRefusalFallbackModel: routing', () => {
  it('merges the override over the defaults instead of replacing them', () => {
    const out = patched(ROUTES);
    // Replacing the table would leave a category the routes omit with no
    // fallback at all, so the default table has to survive in the expression.
    expect(out).toContain(
      's=Object.assign({},_2(n),e.routesOverride??{}),g=r!=null'
    );
    expect(out).not.toContain('s=e.routesOverride??_2(n)');
  });

  it('supplies the configured routes from the supplier the walker is given', () => {
    expect(patched(ROUTES)).toContain(
      `function o0n(){return ${JSON.stringify(ROUTES)}}`
    );
  });

  it('leaves an empty-body function that is not passed as routesOverride alone', () => {
    // Many declarations in the bundle have the body `{return}`. Selecting on
    // the body alone rewrites whichever comes first.
    expect(patched(ROUTES)).toContain(DECOY);
  });
});

describe('writeRefusalFallbackModel: config validation', () => {
  it('skips a route that is not a model id or a list of them, and says why', () => {
    const warned = warnings();
    const out = patched({
      cyber: 'claude-opus-5',
      bio: ['claude-opus-5', 'claude-opus-4-8'],
      frontier_llm: null,
      other: 3,
      empty: [],
      blank: ['claude-opus-5', ' '],
    });
    expect(out).toContain(
      'function o0n(){return {"cyber":"claude-opus-5","bio":["claude-opus-5","claude-opus-4-8"]}}'
    );
    for (const category of ['frontier_llm', 'other', 'empty', 'blank']) {
      expect(
        warned().some(w => w.includes(`refusalFallbackRoutes.${category}`))
      ).toBe(true);
    }
  });

  it('ignores routes that are not a map, and says why', () => {
    const warned = warnings();
    expect(patched(['claude-opus-5'])).toContain('function o0n(){return {}}');
    expect(warned()).toHaveLength(1);
  });

  it('names a category this build does not know, from its own normaliser', () => {
    const warned = warnings();
    // A typo keeps the stock route for the real category, and nothing at
    // refusal time says so.
    const out = patched({ Cyber: 'claude-opus-5', bio: 'claude-opus-5' });
    expect(warned()).toEqual([
      'patch: refusalFallbackModel: refusalFallbackRoutes.Cyber is not a refusal category this Claude Code knows (cyber, bio, frontier_llm, reasoning_extraction), so it never matches',
    ]);
    // Named, not dropped: the build is the one that decides what matches.
    expect(out).toContain('{"Cyber":"claude-opus-5","bio":"claude-opus-5"}');
  });

  it('names a chain longer than Claude Code tries', () => {
    const warned = warnings();
    const chain = [
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ];
    expect(patched({ cyber: chain })).toContain(
      JSON.stringify({ cyber: chain })
    );
    expect(warned()).toEqual([
      'patch: refusalFallbackModel: refusalFallbackRoutes.cyber lists 4 models, and Claude Code tries only the first 3',
    ]);
  });

  it('skips both checks on a build that does not show its limits', () => {
    const warned = warnings();
    const bare = bundle(
      SESSION_STATE,
      module(244, 'chunk-f1d8q1ry.js', SUPPLIER, SWITCHED, WALKER)
    );
    expect(
      writeRefusalFallbackModel(bare, {
        Cyber: ['a', 'b', 'c', 'd'],
      })
    ).not.toBeNull();
    expect(warned()).toEqual([]);
  });

  it('writes a budget that is not a whole number as the default, and says why', () => {
    const warned = warnings();
    for (const bad of ['oops', '1}', 1.5, -1]) {
      const out = patched(ROUTES, bad);
      expect(out).toContain('if(__tweakccR.returns>=1){');
      expect(out).not.toContain('oops');
    }
    expect(warned()).toHaveLength(4);
  });

  it('takes the budget it is given, and compiles the check out for null', () => {
    expect(patched(ROUTES, 3)).toContain('if(__tweakccR.returns>=3){');
    expect(patched(ROUTES, 0)).toContain('if(__tweakccR.returns>=0){');
    expect(patched(ROUTES, null)).not.toContain('__tweakccR.returns>=');
    expect(patched(ROUTES)).toContain('if(__tweakccR.returns>=1){');
  });
});

describe('writeRefusalFallbackModel: the return', () => {
  it('publishes the return and its subscription beside the restore, emitting on its own hub', () => {
    const state = moduleText(patched(ROUTES), 15);
    expect(state).toContain(
      'globalThis.__tweakccRefusalFallbackOnReturn=(__tweakccF)=>(globalThis.__tweakccRefusalFallbackHub??=new Mt(()=>Fe())).of(n()).subscribe(__tweakccF);globalThis.__tweakccRefusalFallbackReturn=()=>{let __tweakccS=n(),'
    );
    expect(state).toMatch(
      /let __tweakccT=gn\(\);[^]*\(globalThis\.__tweakccRefusalFallbackHub\?\?=new Mt\(\(\)=>Fe\(\)\)\)\.of\(__tweakccS\)\.emit\(__tweakccT\);[^]*\};function gn\(\)/
    );
    // The session-switch broadcast is left to the resets it reports.
    expect(state).not.toContain('cn(__tweakccS');
  });

  it("takes the hub from the restore's own module", () => {
    // The same hub shape in another module belongs to other state.
    const elsewhere = bundle(
      module(15, 'chunk-w7yjn2r1.js', EMITTER, RESTORE)
    ).replace(QUEUE, QUEUE + EVENT);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeRefusalFallbackModel(elsewhere, ROUTES)).toBeNull();
    expect(String(error.mock.calls[0]?.[0])).toContain("reset event's hub");
  });

  it('subscribes both restore callbacks to the return hub, keeping their stock bodies', () => {
    const callbacks = moduleText(patched(ROUTES), 565);
    expect(callbacks).toContain(
      'function kft(e){let __tweakccU=__tweakccRefusalFallbackApplyOnReset(e),__tweakccV=globalThis.__tweakccRefusalFallbackOnReturn?.((__tweakccT)=>Qt(__tweakccT,e));return()=>{__tweakccV?.(),__tweakccU()}}' +
        APPLY_REGISTRATION.replace(
          'function kft(',
          'function __tweakccRefusalFallbackApplyOnReset('
        )
    );
    expect(callbacks).toContain(
      'function P2r(e){let __tweakccU=__tweakccRefusalFallbackDropOnReset(e),__tweakccV=globalThis.__tweakccRefusalFallbackOnReturn?.(()=>e());return()=>{__tweakccV?.(),__tweakccU()}}' +
        DROP_REGISTRATION.replace(
          'function P2r(',
          'function __tweakccRefusalFallbackDropOnReset('
        )
    );
    expect(callbacks).toContain(WRITER);
  });

  it('publishes the transcript line beside the switch message, with its display names', () => {
    expect(moduleText(patched(ROUTES), 244)).toMatch(
      /globalThis\.__tweakccRefusalFallbackLine=\(__tweakccN\)=>\{[^]*li\(__tweakccN\.model\)[^]*li\(__tweakccN\.fallback\)[^]*\};function kT\(/
    );
  });

  it("publishes the REPL's message constructor and headless's event queue", () => {
    const out = patched(ROUTES);
    expect(moduleText(out, 355)).toContain(
      'globalThis.__tweakccRefusalFallbackMessage=Rx;function Rx(e,n)'
    );
    expect(moduleText(out, 128)).toContain(
      'globalThis.__tweakccRefusalFallbackEvent=Fa;function Tke(e)'
    );
  });

  it("returns at the end of an interactive turn and appends the line through the finally's own append", () => {
    const repl = moduleText(patched(ROUTES), 1405);
    expect(repl).toContain(
      '}finally{try{let __tweakccN=globalThis.__tweakccRefusalFallbackReturn?.();'
    );
    expect(repl).toContain(
      'ko({type:"append",messages:[__tweakccM]})}}catch{}'
    );
    // The splice is guarded and ahead of the finally's own work, which runs
    // whatever the return does.
    expect(repl).toContain('}}catch{}eo.clearPending()');
  });

  it('returns at the end of a headless turn and queues the line ahead of the result', () => {
    const headless = moduleText(patched(ROUTES), 1223);
    expect(headless).toMatch(
      /noteTurnEnded\(e,r,n\)\{try\{let __tweakccN=globalThis\.__tweakccRefusalFallbackReturn\?\.\(\);[^]*globalThis\.__tweakccRefusalFallbackEvent\?\.\(\{type:"system",subtype:"informational",content:__tweakccL\.content,level:__tweakccL\.level\}\)\}\}catch\{\}if\(this\.selector\.noteTurnEnded\(e\)/
    );
  });

  it('is idempotent', () => {
    const once = patched(ROUTES);
    expect(writeRefusalFallbackModel(once, ROUTES)).toBe(once);
  });

  for (const [site, text] of [
    ['walker', WALKER],
    ['routes call site', CALL_SITE],
    ['restore', RESTORE],
    ["reset event's hub", EVENT],
    ['app-state registration', APPLY_REGISTRATION],
    ['model-drop registration', DROP_REGISTRATION],
    ['switch message', SWITCHED],
    ['message constructor', MESSAGE],
    ['event queue', QUEUE],
    ['REPL turn end', REPL],
    ['headless turn end', HEADLESS],
  ] as const) {
    it(`fails rather than half-patching when the ${site} is absent`, () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(
        writeRefusalFallbackModel(BUNDLE.replace(text, ''), ROUTES)
      ).toBeNull();
    });
  }
});

// The spliced code, executed: the session state module and the restore
// callbacks' module as patched, on stand-ins for Claude Code's per-root registry
// and emitter written the way the bundle writes them, with the session, the
// app-state writer and the telemetry stubbed.

interface Latch {
  fallbackModel: string;
  previousOverride: string | undefined;
  previousAppStateModel: string | undefined;
  previousModelForSession: string | undefined;
}

type Root = object;

const fakeSession = (id: string, root: Root) => {
  let latch: Latch | undefined;
  let override: string | undefined = 'claude-fable-5-1';
  return {
    id,
    root,
    modelSelection: {
      refusalFallbackModelLatch: () => latch,
      unlatchRefusalFallbackModel: () => {
        latch = undefined;
      },
      mainLoopModelOverride: () => override,
      overrideMainLoopModel: (model: string | undefined) => {
        override = model;
      },
    },
    /** What the client does when a message is flagged. */
    flag(fallback = 'claude-opus-4-8') {
      latch = {
        fallbackModel: fallback,
        previousOverride: override,
        previousAppStateModel: override,
        previousModelForSession: override,
      };
      override = fallback;
    },
    pickModel(model: string) {
      override = model;
    },
    get override() {
      return override;
    },
  };
};
type FakeSession = ReturnType<typeof fakeSession>;

/** The bundle's per-root registry: one value per session root, made on first use. */
class Registry<T> {
  #make: () => T;
  #values = new WeakMap<Root, T>();
  constructor(make: () => T) {
    this.#make = make;
  }
  of(session: { root: Root }): T {
    let value = this.#values.get(session.root);
    if (value === undefined) {
      value = this.#make();
      this.#values.set(session.root, value);
    }
    return value;
  }
}

/** The bundle's emitter: every listener runs, and failures surface after. */
const emitter = () => {
  const listeners = new Set<(...args: unknown[]) => void>();
  return {
    subscribe(listener: (...args: unknown[]) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(...args: unknown[]) {
      const failures: unknown[] = [];
      for (const listener of listeners) {
        try {
          listener(...args);
        } catch (failure) {
          failures.push(failure);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures);
    },
  };
};

type Registration = (callback: unknown) => () => void;

const world = (budget?: unknown) => {
  const out = patched(ROUTES, budget);
  let current: FakeSession = fakeSession('session-1', {});
  const { Pd, cn } = new Function(
    'n',
    'Mt',
    'Fe',
    `${moduleText(out, 15)};return{Pd,cn}`
  )(() => current, Registry, emitter) as {
    Pd: (listener: unknown) => () => void;
    cn: (session: FakeSession, reason: string, result?: unknown) => void;
  };
  const callbacks = moduleText(out, 565);
  const registrations = callbacks.slice(0, callbacks.indexOf('function Qt('));
  const writes: Array<{ result: unknown; setState: unknown }> = [];
  const telemetry: unknown[][] = [];
  const { kft, P2r } = new Function(
    'Pd',
    'Qt',
    'i',
    'c',
    'kz',
    `${registrations};return{kft,P2r}`
  )(
    Pd,
    (result: unknown, setState: unknown) => writes.push({ result, setState }),
    (...args: unknown[]) => telemetry.push(args),
    (value: unknown) => value,
    (value: unknown) => value
  ) as { kft: Registration; P2r: Registration };

  // A listener standing for the reset event's other subscribers.
  const resets: unknown[][] = [];
  Pd((...args: unknown[]) => resets.push(args));

  const setState = () => {};
  const drops: string[] = [];
  const unsubscribeApply = kft(setState);
  P2r(() => drops.push(current.id));

  return {
    turnEnd: (globalThis as Record<string, unknown>)
      .__tweakccRefusalFallbackReturn as () => unknown,
    kft,
    P2r,
    cn,
    setState,
    unsubscribeApply,
    writes,
    drops,
    resets,
    telemetry,
    get session(): FakeSession {
      return current;
    },
    /** Resume another conversation on the same root, or open a new root. */
    switchTo(id: string, root: Root = current.root) {
      current = fakeSession(id, root);
      return current;
    },
    use(session: FakeSession) {
      current = session;
    },
  };
};

describe('the return, executed', () => {
  it('switches back after a flagged turn and hands the result to the two callbacks alone', () => {
    const run = world();
    run.session.flag();
    expect(run.turnEnd()).toEqual({
      held: false,
      returns: 1,
      model: 'claude-fable-5-1',
      fallback: 'claude-opus-4-8',
    });
    expect(run.session.override).toBe('claude-fable-5-1');
    expect(run.writes).toEqual([
      {
        result: {
          appStateModel: 'claude-fable-5-1',
          forSessionValue: 'claude-fable-5-1',
          overrideValue: 'claude-fable-5-1',
          restoredToExplicitOverride: true,
          fallbackModel: 'claude-opus-4-8',
        },
        setState: run.setState,
      },
    ]);
    expect(run.drops).toEqual(['session-1']);
    // No other listener of the session-switch broadcast hears a return, and
    // the latch-reset telemetry reports only the resets it always reported.
    expect(run.resets).toEqual([]);
    expect(run.telemetry).toEqual([]);
  });

  it('leaves the stock reset path as it was', () => {
    const run = world();
    const result = { fallbackModel: 'claude-opus-4-8' };
    run.cn(run.session, 'clear', result);
    expect(run.writes).toEqual([{ result, setState: run.setState }]);
    expect(run.drops).toEqual(['session-1']);
    expect(run.telemetry).toHaveLength(1);
    expect(run.telemetry[0]?.[0]).toBe('tengu_refusal_fallback_latch_reset');
  });

  it('leaves a /model chosen during the turn alone', () => {
    const run = world();
    run.session.flag();
    run.session.pickModel('claude-opus-5-5');
    expect(run.turnEnd()).toBeUndefined();
    expect(run.session.override).toBe('claude-opus-5-5');
    expect(run.writes).toEqual([]);
  });

  it('keeps the fallback when the model is flagged again right after a return, and says so once', () => {
    const run = world();
    run.session.flag();
    run.turnEnd();
    run.session.flag();
    expect(run.turnEnd()).toEqual({
      held: true,
      returns: 1,
      model: 'claude-fable-5-1',
      fallback: 'claude-opus-4-8',
    });
    expect(run.session.override).toBe('claude-opus-4-8');
    expect(run.turnEnd()).toBeUndefined();
    expect(run.writes).toHaveLength(1);
  });

  it('starts the budget over after a turn that ends unflagged', () => {
    const run = world();
    run.session.flag();
    run.turnEnd();
    expect(run.turnEnd()).toBeUndefined();
    run.session.flag();
    expect(run.turnEnd()).toMatchObject({ held: false });
  });

  it('starts the budget over when another conversation is resumed on the same root', () => {
    const run = world();
    run.session.flag();
    run.turnEnd();
    run.session.flag();
    expect(run.turnEnd()).toMatchObject({ held: true });
    // Resuming another conversation re-latches through the same writer.
    run.switchTo('session-2');
    run.session.flag();
    expect(run.turnEnd()).toMatchObject({ held: false });
    expect(run.drops.at(-1)).toBe('session-2');
  });

  it('keeps a budget per session root, so sessions ending turns in one process do not reset each other', () => {
    const run = world();
    const first = run.session;
    first.flag();
    expect(run.turnEnd()).toMatchObject({ held: false });
    const second = run.switchTo('session-2', {});
    second.flag();
    expect(run.turnEnd()).toMatchObject({ held: false });
    run.use(first);
    first.flag();
    expect(run.turnEnd()).toMatchObject({ held: true });
    run.use(second);
    second.flag();
    expect(run.turnEnd()).toMatchObject({ held: true });
  });

  it("hands a return only to the callbacks subscribed for the session's root", () => {
    const run = world();
    const first = run.session;
    const second = run.switchTo('session-2', {});
    const secondSetState = () => {};
    run.kft(secondSetState);
    run.use(first);
    first.flag();
    run.turnEnd();
    expect(run.writes.map(w => w.setState)).toEqual([run.setState]);
    run.use(second);
    second.flag();
    run.turnEnd();
    expect(run.writes.map(w => w.setState)).toEqual([
      run.setState,
      secondSetState,
    ]);
  });

  it('leaves both hubs when a registration is unsubscribed', () => {
    const run = world();
    run.unsubscribeApply();
    run.session.flag();
    run.turnEnd();
    expect(run.writes).toEqual([]);
    expect(run.drops).toEqual(['session-1']);
    run.cn(run.session, 'clear', { fallbackModel: 'claude-opus-4-8' });
    expect(run.writes).toEqual([]);
    expect(run.telemetry).toEqual([]);
  });

  it('never stops returning with a null budget, and never returns with 0', () => {
    const unbounded = world(null);
    for (let turn = 0; turn < 3; turn++) {
      unbounded.session.flag();
      expect(unbounded.turnEnd()).toMatchObject({ held: false });
    }
    const never = world(0);
    never.session.flag();
    expect(never.turnEnd()).toMatchObject({ held: true, returns: 0 });
    expect(never.session.override).toBe('claude-opus-4-8');
    expect(never.writes).toEqual([]);
  });
});

describe('the transcript line, executed', () => {
  const line = () => {
    const names: Record<string, string> = {
      'claude-fable-5-1': 'Fable 5.1',
      'claude-opus-4-8': 'Opus 4.8',
    };
    const text = moduleText(patched(ROUTES), 244);
    const statement = text.slice(
      text.indexOf('globalThis.__tweakccRefusalFallbackLine='),
      text.indexOf('function kT(')
    );
    new Function('li', statement)((model: string) => names[model] ?? model);
    return (globalThis as Record<string, unknown>)
      .__tweakccRefusalFallbackLine as (n: unknown) => {
      content: string;
      level: string;
    };
  };

  it('names the model the session switched back to', () => {
    expect(
      line()({
        held: false,
        returns: 1,
        model: 'claude-fable-5-1',
        fallback: 'claude-opus-4-8',
      })
    ).toEqual({ content: 'Switched back to Fable 5.1.', level: 'notice' });
  });

  it('says the session stays on the fallback when the budget is spent', () => {
    expect(
      line()({
        held: true,
        returns: 1,
        model: 'claude-fable-5-1',
        fallback: 'claude-opus-4-8',
      })
    ).toEqual({
      content:
        'Staying on Opus 4.8 for this session · Fable 5.1 was flagged again after switching back · /model to change',
      level: 'warning',
    });
  });

  it('claims no switch back when the budget allowed none', () => {
    expect(
      line()({
        held: true,
        returns: 0,
        model: 'claude-fable-5-1',
        fallback: 'claude-opus-4-8',
      })
    ).toEqual({
      content: 'Staying on Opus 4.8 for this session · /model to change',
      level: 'warning',
    });
  });

  it('names the default model when the session had no model of its own', () => {
    expect(
      line()({
        held: false,
        returns: 1,
        model: undefined,
        fallback: 'claude-opus-4-8',
      }).content
    ).toBe('Switched back to the default model.');
  });
});
