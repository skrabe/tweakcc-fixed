// refusal-fallback-model against a pristine cli.js, run rather than read.
//
// The sweep in allPatchesAgainstPristine proves each patch applies and leaves a
// bundle that parses. It cannot tell a splice that works from one that is
// well-formed and sitting on a site nothing reads, because both produce valid
// output. For a patch whose whole point is WHERE a decision lands, the
// assertion has to run the decision.
//
// Gated like that sweep, behind TWEAKCC_PRISTINE_PATCHES=1 (`pnpm test:pristine`),
// because it needs a pristine cli.js on disk. Nothing here is lifted from the
// bundle by a shape stricter than the patch's own anchors: what these read is
// either named by the patch's splices or found the way the patch finds it, and
// everything the bundle's code calls beyond that is stubbed without being named.
import { beforeAll, describe, expect, it } from 'vitest';
import { writeRefusalFallbackModel } from './refusalFallbackModel';
import { findStatementEnd } from './toolsets';
import {
  findPristineCliJs,
  NOT_ENABLED,
  NO_PRISTINE_CLI_JS,
} from './pristineCliJs';

const ENABLED = process.env.TWEAKCC_PRISTINE_PATCHES === '1';
const pristine = ENABLED ? findPristineCliJs() : null;
const skipReason = !ENABLED
  ? NOT_ENABLED
  : !pristine
    ? NO_PRISTINE_CLI_JS
    : null;

/**
 * Lift `function NAME(...){...}` whole, by counting braces from its opening.
 * Minified names are reused from one module to the next, so given an `anchor`
 * it lifts the definition nearest to it.
 */
const grabFunction = (src: string, name: string, anchor?: number): string => {
  const head = `function ${name}(`;
  let i = src.indexOf(head);
  if (i < 0) throw new Error(`no function ${name} in bundle`);
  if (anchor !== undefined) {
    for (let j = i; j >= 0; j = src.indexOf(head, j + 1)) {
      if (Math.abs(j - anchor) < Math.abs(i - anchor)) i = j;
    }
  }
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error(`unbalanced body for ${name}`);
};

const matchOrThrow = (
  match: RegExpMatchArray | null,
  what: string
): RegExpMatchArray => {
  if (!match) throw new Error(`no ${what} in bundle`);
  return match;
};

const escapeName = (name: string): string => name.replace(/\$/g, '\\$');

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
//
// This lifts the refusal routing out of the patched bundle and executes it
// against the same inputs as the pristine one.

interface RefusalResult {
  matched: string;
  model: string | undefined;
  reason?: string;
}
interface RefusalRouter {
  route: (e: Record<string, unknown>) => RefusalResult;
  routes: () => Record<string, string | string[]> | undefined;
  /** The route tables the bundle ships, one per kind of flagged model. */
  tables: Array<Record<string, unknown>>;
}

/** `NAME=VALUE` as declared, the declaration nearest to `anchor`. */
const definitionNear = (
  src: string,
  name: string,
  value: string,
  anchor: number
): string => {
  const pattern = new RegExp(`(?<![$\\w.])${escapeName(name)}=${value}`, 'g');
  let best: RegExpMatchArray | undefined;
  for (const match of src.matchAll(pattern)) {
    if (
      best === undefined ||
      Math.abs(match.index! - anchor) < Math.abs(best.index! - anchor)
    ) {
      best = match;
    }
  }
  if (best === undefined) throw new Error(`no ${name} declaration in bundle`);
  return best[0];
};

/** The names one build gives the refusal routing. */
interface RefusalRouterNames {
  walker: string;
  selector: string;
  predicate: string;
  tables: string[];
  normalize: string;
  walk: string;
  chainLimit: string;
  catchAll: string;
  supplier: string;
}

/** Where the walker is declared; its head survives the patch unchanged. */
const walkerAt = (src: string, walker: string): number =>
  matchOrThrow(
    src.match(
      new RegExp(
        `function ${escapeName(walker)}\\([$\\w]+\\)\\{let\\{originalModelCanonical:`
      )
    ),
    'refusal walker'
  ).index!;

/**
 * Name every piece of the refusal routing by its shape. Minified names change
 * with each build and are reused across modules; the shapes hold. Read from
 * the pristine bundle and reused for the patched one, whose splices change
 * bodies but keep every name.
 */
const refusalRouterNames = (src: string): RefusalRouterNames => {
  const head = matchOrThrow(
    src.match(
      /function ([$\w]+)\(([$\w]+)\)\{let\{originalModelCanonical:[$\w]+,apiRefusalCategory:[$\w]+\}=\2,[$\w]+=\2\.routesOverride\?\?([$\w]+)\(/
    ),
    'refusal walker'
  );
  const [, walker, , selector] = head;
  const at = head.index!;
  const [, , normalize, walk] = matchOrThrow(
    grabFunction(src, walker, at).match(
      /let ([$\w]+)=([$\w]+)\([$\w]+\),[$\w]+=([$\w]+)\(\1,[$\w]+\.resolveTarget\)/
    ),
    'refusal chain walk'
  );
  const selectorBody = grabFunction(src, selector, at);
  const [, predicate] = matchOrThrow(
    selectorBody.match(/if\(([$\w]+)\([$\w]+\)\)return /),
    'refusal table predicate'
  );
  const tables = [...selectorBody.matchAll(/return ([$\w]+)/g)].map(
    match => match[1]
  );
  const [, chainLimit] = matchOrThrow(
    grabFunction(src, normalize, at).match(/\.slice\(0,([$\w]+)\)/),
    'refusal chain limit'
  );
  const [, catchAll] = matchOrThrow(
    src.match(
      /function ([$\w]+)\(\)\{let [$\w]+=process\.env\.CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL\b/
    ),
    'refusal catch-all switch'
  );
  const [, supplier] = matchOrThrow(
    src.match(/routesOverride:([$\w]+)\(\)/),
    'refusal routes supplier'
  );
  return {
    walker,
    selector,
    predicate,
    tables,
    normalize,
    walk,
    chainLimit,
    catchAll,
    supplier,
  };
};

/**
 * Evaluate just the routing functions, with their environment stubbed to the
 * branch a normal session takes: the legacy-table predicate false, and the
 * catch-all off, which is what it is without
 * CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL.
 */
const buildRefusalRouter = (
  src: string,
  names: RefusalRouterNames
): RefusalRouter => {
  const at = walkerAt(src, names.walker);
  const tables = names.tables.map(table =>
    definitionNear(src, table, '\\{[^}]*\\}', at)
  );
  const routing = [names.selector, names.normalize, names.walk, names.walker]
    .map(name => grabFunction(src, name, at))
    .join(' ');
  const supplier = grabFunction(
    src,
    names.supplier,
    src.indexOf(`routesOverride:${names.supplier}()`)
  );
  return (
    new Function(`
      var ${definitionNear(src, names.chainLimit, '\\d+', at)};
      var ${tables.join(',')};
      var ${names.predicate} = () => false;
      var ${names.catchAll} = () => false;
      ${routing} ${supplier}
      return {
        route: ${names.walker},
        routes: ${names.supplier},
        tables: [${names.tables.join(',')}],
      };
    `) as () => RefusalRouter
  )();
};

const EVERY_MODEL = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-5-5',
  'claude-fable-5-1',
];
/** The client's "can this session use that model" hook. */
const modelsUsable =
  (allowed: string[]) =>
  (m: string): string | undefined =>
    allowed.includes(m) ? m : undefined;

// Every expectation about a route the configuration leaves alone is read from
// the stock routing of the same bundle, never written down, so these hold
// whatever a release puts in its tables.
describe.skipIf(skipReason !== null)('refusal routing, executed', () => {
  let names: RefusalRouterNames;
  let stock: RefusalRouter;

  beforeAll(() => {
    names = refusalRouterNames(pristine!.source);
    stock = buildRefusalRouter(pristine!.source, names);
  });

  /** The routing of the bundle patched with `routes`. */
  const patchedWith = (
    routes: Record<string, string | string[]>
  ): RefusalRouter =>
    buildRefusalRouter(
      writeRefusalFallbackModel(pristine!.source, routes) as string,
      names
    );

  const ask = (
    r: RefusalRouter,
    model: string,
    category: string,
    resolve: (m: string) => string | undefined
  ): RefusalResult => {
    const out = r.route({
      originalModelCanonical: model,
      apiRefusalCategory: category,
      resolveTarget: resolve,
      routesOverride: r.routes(),
    });
    return {
      matched: out.matched,
      model: out.model,
      ...(out.reason ? { reason: out.reason } : {}),
    };
  };

  it('routes a configured category to the head of its chain', () => {
    for (const flagged of EVERY_MODEL) {
      const shipped = ask(stock, flagged, 'cyber', modelsUsable(EVERY_MODEL));
      // A head the stock route already picks would pass unpatched.
      const head = EVERY_MODEL.find(
        m => m !== shipped.model && m !== flagged
      ) as string;
      expect(
        ask(
          patchedWith({ cyber: [head] }),
          flagged,
          'cyber',
          modelsUsable(EVERY_MODEL)
        ),
        flagged
      ).toEqual({ matched: 'category', model: head });
    }
  });

  it('drops a rung only when the head of the chain is unusable', () => {
    const patched = patchedWith({
      cyber: ['claude-opus-5', 'claude-opus-4-8'],
    });
    expect(
      ask(
        patched,
        'claude-fable-5-1',
        'cyber',
        modelsUsable(['claude-opus-4-8'])
      )
    ).toEqual({ matched: 'category', model: 'claude-opus-4-8' });
    expect(ask(patched, 'claude-fable-5-1', 'cyber', modelsUsable([]))).toEqual(
      {
        matched: 'none',
        model: undefined,
        reason: 'mapped_target_unresolvable',
      }
    );
  });

  it('routes every category the configuration leaves out exactly as stock does', () => {
    // Replacing the table rather than merging would leave these unmapped.
    const patched = patchedWith({ cyber: 'claude-opus-5-5' });
    const left = new Set(stock.tables.flatMap(table => Object.keys(table)));
    left.delete('cyber');
    expect(left.size).toBeGreaterThan(0);
    for (const flagged of EVERY_MODEL) {
      for (const category of [...left, 'nosuch']) {
        expect(
          ask(patched, flagged, category, modelsUsable(EVERY_MODEL)),
          `${flagged} ${category}`
        ).toEqual(ask(stock, flagged, category, modelsUsable(EVERY_MODEL)));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The return
// ---------------------------------------------------------------------------
//
// The return crosses modules: a turn's end calls the function published beside
// the restore, which hands the restore's result to the callbacks subscribed to
// the return hub, and those were subscribed from another module by the same
// registrations the REPL and headless use for the reset event. This runs that
// path on Claude Code's own restore, registrations and app-state writer, lifted
// from the patched bundle. The session, and the registry and emitter the hubs
// are made of, are stand-ins written the way the bundle writes them; the
// writer's own helpers and the registrations' telemetry resolve to stubs that
// record their calls without being named.

/** The statement starting at `prefix`, through the `;` that ends it. */
const grabStatement = (
  src: string,
  prefix: string
): { text: string; at: number } => {
  const at = src.indexOf(prefix);
  if (at < 0) throw new Error(`no ${prefix} in bundle`);
  const end = findStatementEnd(src, at);
  if (end === null) throw new Error(`no end to ${prefix}`);
  return { text: src.slice(at, end), at };
};

/** A session's refusal state, moved the way the client moves it. */
const fakeSession = (id: string) => {
  let latch: Record<string, string | undefined> | undefined;
  let override: string | undefined = 'claude-fable-5-1';
  return {
    id,
    root: {},
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
    flag(fallback: string) {
      latch = {
        fallbackModel: fallback,
        previousOverride: override,
        previousAppStateModel: override,
        previousModelForSession: override,
      };
      override = fallback;
    },
  };
};

/** The bundle's per-root registry: one value per session root, made on first use. */
class Registry<T> {
  #make: () => T;
  #values = new WeakMap<object, T>();
  constructor(make: () => T) {
    this.#make = make;
  }
  of(session: { root: object }): T {
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

/**
 * A scope for lifted code in which every name it does not declare, and that is
 * not a global, is a stub recording its calls. The code's own names resolve in
 * its own scopes first, so only what it reaches for outside itself lands here.
 */
const stubbedScope = (
  bound: Record<string, unknown>,
  calls: Array<[string, unknown[]]>
): object =>
  new Proxy(bound, {
    has: (target, key) =>
      typeof key === 'string' && (key in target || !(key in globalThis)),
    get: (target, key) => {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push([key, args]);
        return undefined;
      };
    },
  });

describe.skipIf(skipReason !== null)('refusal return, executed', () => {
  it("switches back through the return hub alone, into each surface's own state", () => {
    const src = writeRefusalFallbackModel(pristine!.source, {
      cyber: 'claude-opus-5',
    }) as string;

    // The session module: the subscription and the return published beside
    // the restore, the restore they name, and the reset event's hub, which the
    // patch found beside the restore by the same registry and accessor.
    const subscription = grabStatement(
      src,
      'globalThis.__tweakccRefusalFallbackOnReturn='
    );
    const publish = grabStatement(
      src,
      'globalThis.__tweakccRefusalFallbackReturn='
    );
    const [, registry, factory, state] = matchOrThrow(
      subscription.text.match(
        /new ([$\w]+)\(\(\)=>([$\w]+)\(\)\)\)\.of\(([$\w]+)\(\)\)/
      ),
      'return hub'
    );
    const [, restore] = matchOrThrow(
      publish.text.match(/let __tweakccT=([$\w]+)\(\)/),
      'restore'
    );
    const resetHub = matchOrThrow(
      src.match(
        new RegExp(
          `var ([$\\w]+)=new ${escapeName(registry)}\\(\\(\\)=>${escapeName(factory)}\\(\\)\\);function ([$\\w]+)\\(([$\\w]+)\\)\\{return \\1\\.of\\(${escapeName(state)}\\(\\)\\)\\.subscribe\\(\\3\\)\\}`
        )
      ),
      "reset event's hub"
    );

    const session = fakeSession('session-1');
    const { resetSubscribe } = new Function(
      'Registry',
      'emitter',
      'session',
      `
        var ${registry} = Registry, ${factory} = emitter, ${state} = session;
        ${resetHub[0]}
        ${grabFunction(src, restore, publish.at)}
        ${subscription.text};
        ${publish.text};
        return { resetSubscribe: ${resetHub[2]} };
      `
    )(Registry, emitter, () => session) as {
      resetSubscribe: (listener: (...args: unknown[]) => void) => () => void;
    };

    // The registrations' module: both registrations as patched, with their
    // stock bodies, and the app-state writer the patch named in its applier.
    const apply = matchOrThrow(
      src.match(
        /function ([$\w]+)\(([$\w]+)\)\{let __tweakccU=__tweakccRefusalFallbackApplyOnReset\(\2\),__tweakccV=globalThis\.__tweakccRefusalFallbackOnReturn\?\.\(\(__tweakccT\)=>([$\w]+)\(__tweakccT,\2\)\)/
      ),
      'app-state registration'
    );
    const drop = matchOrThrow(
      src.match(
        /function ([$\w]+)\(([$\w]+)\)\{let __tweakccU=__tweakccRefusalFallbackDropOnReset\(\2\)/
      ),
      'model-drop registration'
    );
    const [, applyName, , writer] = apply;
    const [, subscribe] = matchOrThrow(
      grabFunction(
        src,
        '__tweakccRefusalFallbackApplyOnReset',
        apply.index
      ).match(/\{return ([$\w]+)\(\(/),
      'reset subscribe in the registrations'
    );
    const lifted = [
      grabFunction(src, applyName, apply.index),
      grabFunction(src, '__tweakccRefusalFallbackApplyOnReset', apply.index),
      grabFunction(src, drop[1], drop.index),
      grabFunction(src, '__tweakccRefusalFallbackDropOnReset', drop.index),
      grabFunction(src, writer, apply.index),
    ].join('\n');

    const calls: Array<[string, unknown[]]> = [];
    const surfaces = new Function(
      'scope',
      `with (scope) { ${lifted}\n return { apply: ${applyName}, drop: ${drop[1]} }; }`
    )(stubbedScope({ [subscribe]: resetSubscribe }, calls)) as {
      apply: (setState: (u: (s: unknown) => unknown) => void) => () => void;
      drop: (callback: () => void) => () => void;
    };

    // What the rest of the session-switch broadcast would hear.
    const resets: unknown[][] = [];
    resetSubscribe((...args: unknown[]) => resets.push(args));

    let appState: Record<string, unknown> = {
      mainLoopModel: 'claude-opus-4-8',
      mainLoopModelForSession: 'claude-opus-4-8',
      fastMode: false,
    };
    surfaces.apply(updater => {
      appState = updater(appState) as Record<string, unknown>;
    });
    let startupModelDropped = false;
    surfaces.drop(() => {
      startupModelDropped = true;
    });

    session.flag('claude-opus-4-8');
    const turnEnd = (globalThis as Record<string, unknown>)
      .__tweakccRefusalFallbackReturn as () => unknown;
    try {
      expect(turnEnd()).toEqual({
        held: false,
        returns: 1,
        model: 'claude-fable-5-1',
        fallback: 'claude-opus-4-8',
      });
    } finally {
      const g = globalThis as Record<string, unknown>;
      for (const key of Object.keys(g)) {
        if (key.startsWith('__tweakccRefusalFallback')) delete g[key];
      }
    }
    // The session's model is read as mainLoopModelForSession ?? mainLoopModel,
    // so both have to move, and headless has to stop reading its startup model.
    expect(appState.mainLoopModel).toBe('claude-fable-5-1');
    expect(appState.mainLoopModelForSession).toBe('claude-fable-5-1');
    expect(startupModelDropped).toBe(true);
    // Nothing else on the session-switch broadcast heard it, and the latch
    // reset telemetry, which only a reset sends, was not sent.
    expect(resets).toEqual([]);
    expect(
      calls.some(([, args]) => args[0] === 'tengu_refusal_fallback_latch_reset')
    ).toBe(false);
  });
});
