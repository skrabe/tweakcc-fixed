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
// either named by the patch's splices or found by the patch's own finders.
// Whatever that code calls is resolved by the name it calls, from the
// declarations of its own module, and anything not declared there is stubbed
// without being named.
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  findRouteSupplier,
  findRouteWalker,
  routeLimits,
  writeRefusalFallbackModel,
} from './refusalFallbackModel';
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
// This runs the refusal walker and the routes supplier of the patched bundle
// against the same inputs as the pristine one's. Both are found in the pristine
// bundle by the patch's own finders, and each is then taken by name from the
// same module of either bundle, whose splices change bodies but keep names and
// module boundaries.

const MODULE_MARK = '/*@@TWEAKCC_MODULE:';

/** The header naming the module that holds `at`. */
const moduleHeaderAt = (src: string, at: number): string => {
  const start = src.lastIndexOf(MODULE_MARK, at);
  if (start < 0) throw new Error('bundle has no module markers');
  return src.slice(start, src.indexOf('@@*/', start) + 4);
};

/** The text of the module a header names. */
const moduleText = (src: string, header: string): string => {
  const start = src.indexOf(header);
  if (start < 0) throw new Error(`no module ${header} in bundle`);
  const end = src.indexOf(MODULE_MARK, start + header.length);
  return src.slice(start + header.length, end < 0 ? undefined : end);
};

interface ModuleDeclarations {
  /** Each top-level declaration, as an expression for its value. */
  declared: Map<string, string>;
  /** Each imported name: the importing path and the name it exports. */
  imported: Map<string, [string, string]>;
  /** Each exported name: the name declared for it. */
  exported: Map<string, string>;
}

const declarations = (text: string): ModuleDeclarations => {
  const file = ts.createSourceFile(
    'module.js',
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  );
  const source = (node: ts.Node): string =>
    text.slice(node.getStart(file), node.end);
  const out = new Map<string, string>();
  const imported = new Map<string, [string, string]>();
  const exported = new Map<string, string>();
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          imported.set(element.name.text, [
            statement.moduleSpecifier.text,
            (element.propertyName ?? element.name).text,
          ]);
        }
      }
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exported.set(
          element.name.text,
          (element.propertyName ?? element.name).text
        );
      }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      // Written as an expression, the declaration still names itself.
      out.set(
        statement.name.text,
        `(${source(statement).replace(/^export\s+(default\s+)?/, '')})`
      );
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        out.set(
          declaration.name.text,
          declaration.initializer
            ? `(${source(declaration.initializer)})`
            : 'undefined'
        );
      }
    }
  }
  return { declared: out, imported, exported };
};

type Scope = ((name: string) => unknown) & {
  exported: (name: string) => unknown;
};

/**
 * The scopes of a bundle's modules, by module header. Each module's
 * declarations are evaluated the first time something reads them, in a scope
 * where the names they read resolve the same way: a name the module imports
 * from another module of the bundle resolves in that module's scope, and a
 * name the module neither declares nor imports from the bundle, and that is
 * not a global, is a stub returning nothing.
 */
const bundleScopes = (src: string): ((header: string) => Scope) => {
  const scopes = new Map<string, Scope>();
  const headerOf = (path: string): string | undefined => {
    const at = src.indexOf(`:${path}@@*/`);
    return at < 0 ? undefined : moduleHeaderAt(src, at);
  };
  const scopeOf = (header: string): Scope => {
    const known = scopes.get(header);
    if (known) return known;
    const { declared, imported, exported } = declarations(
      moduleText(src, header)
    );
    const values = new Map<string, unknown>();
    const stub = () => undefined;
    const resolve = (key: string): unknown => {
      const code = declared.get(key);
      if (code !== undefined) {
        return new Function('scope', `with (scope) { return ${code}; }`)(scope);
      }
      const from = imported.get(key);
      const source = from && headerOf(from[0]);
      return source ? scopeOf(source).exported(from[1]) : stub;
    };
    const scope: Record<string, unknown> = new Proxy(
      {},
      {
        has: (_, key) =>
          typeof key === 'string' &&
          (declared.has(key) || imported.has(key) || !(key in globalThis)),
        get: (_, key) => {
          if (typeof key !== 'string') return undefined;
          if (!values.has(key)) values.set(key, resolve(key));
          return values.get(key);
        },
      }
    );
    const named = Object.assign((name: string) => scope[name], {
      exported: (name: string) => scope[exported.get(name) ?? name],
    });
    scopes.set(header, named);
    return named;
  };
  return scopeOf;
};

interface RefusalResult {
  matched: string;
  model?: string;
  reason?: string;
  [key: string]: unknown;
}

/** Where the pristine bundle keeps the walker and the supplier, by name. */
interface RoutingSites {
  walker: string;
  walkerModule: string;
  supplier: string;
  supplierModule: string;
  wrapper?: string;
}

const routingSites = (src: string): RoutingSites => {
  const walker = findRouteWalker(src);
  if (!walker) throw new Error('no refusal walker in bundle');
  const supplier = findRouteSupplier(src);
  if (!supplier) throw new Error('no refusal routes supplier in bundle');
  return {
    walker: walker.walker,
    walkerModule: moduleHeaderAt(src, walker.index),
    supplier: supplier.name,
    supplierModule: moduleHeaderAt(src, supplier.index),
    wrapper: supplier.wrapper?.name,
  };
};

type Router = (
  flagged: string,
  category: string,
  usable?: (model: string) => boolean
) => RefusalResult;

/**
 * The bundle's routing as the main loop calls it: the supplier's routes as the
 * override, and a resolver standing for "can this session use that model".
 */
const routerOf = (src: string, sites: RoutingSites): Router => {
  const scopeOf = bundleScopes(src);
  const walkerScope = scopeOf(sites.walkerModule);
  const supplierScope = scopeOf(sites.supplierModule);
  const walk = walkerScope(sites.walker) as (
    e: Record<string, unknown>
  ) => RefusalResult;
  const supply = sites.wrapper
    ? (supplierScope(sites.wrapper) as (e: Record<string, unknown>) => unknown)
    : (supplierScope(sites.supplier) as () => unknown);
  return (flagged, category, usable = model => !REJECTED.has(model)) =>
    walk({
      originalModelCanonical: flagged,
      apiRefusalCategory: category,
      armedFallbackModel: 'claude-armed-fallback',
      armedTargetIsRefusingModel: false,
      resolveTarget: (model: string) => (usable(model) ? model : undefined),
      routesOverride: supply({
        canonical: flagged,
        servedRefusalRoutes: undefined,
      }),
    });
};

/** Models no session can use: a typo, or one the account is not entitled to. */
const REJECTED = new Set(['claude-nonexistent-1', 'claude-nonexistent-2']);

const FLAGGED = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
];

const pick = ({ matched, model, reason }: RefusalResult) => ({
  matched,
  model,
  ...(reason ? { reason } : {}),
});

// Every expectation about a route the configuration leaves alone is read from
// the stock routing of the same bundle, never written down, so these hold
// whatever a release puts in its tables.
describe.skipIf(skipReason !== null)('refusal routing, executed', () => {
  let sites: RoutingSites;
  let stock: Router;
  let categories: string[];

  beforeAll(() => {
    sites = routingSites(pristine!.source);
    stock = routerOf(pristine!.source, sites);
    categories = [
      ...(routeLimits(pristine!.source).categories ?? ['cyber', 'bio']),
    ];
  });

  /** The routing of the bundle patched with `routes`. */
  const patchedWith = (routes: Record<string, string | string[]>): Router => {
    const src = writeRefusalFallbackModel(pristine!.source, routes);
    if (src === null) throw new Error('patch failed on the pristine bundle');
    return routerOf(src, sites);
  };

  /** The categories stock routes by its table for `flagged`. */
  const stockRouted = (flagged: string): string[] =>
    categories.filter(c => stock(flagged, c).matched === 'category');

  it('routes a configured category to the head of its chain', () => {
    const patched = patchedWith(
      Object.fromEntries(categories.map(c => [c, 'claude-user-choice']))
    );
    for (const flagged of FLAGGED) {
      for (const category of categories) {
        expect(
          pick(patched(flagged, category)),
          `${flagged} ${category}`
        ).toEqual({ matched: 'category', model: 'claude-user-choice' });
      }
    }
  });

  it('walks a configured chain in order', () => {
    const category = categories[0]!;
    const patched = patchedWith({
      [category]: ['claude-user-first', 'claude-user-second'],
    });
    expect(
      pick(patched(FLAGGED[0]!, category, m => m !== 'claude-user-first'))
    ).toEqual({ matched: 'category', model: 'claude-user-second' });
  });

  it('falls back to the stock route when no configured model is usable', () => {
    // CC's walker stops at a mapped chain with no usable model before it looks
    // anywhere else, so without the stock route behind it a typo costs the
    // retry that stock makes.
    const patched = patchedWith(
      Object.fromEntries(
        categories.map(c => [
          c,
          ['claude-nonexistent-1', 'claude-nonexistent-2'],
        ])
      )
    );
    let backed = 0;
    for (const flagged of FLAGGED) {
      for (const category of stockRouted(flagged)) {
        backed++;
        expect(
          pick(patched(flagged, category)),
          `${flagged} ${category}`
        ).toEqual(pick(stock(flagged, category)));
      }
    }
    expect(backed).toBeGreaterThan(0);
  });

  it('routes every category the configuration leaves out exactly as stock does', () => {
    // Replacing the table rather than merging would leave these unmapped.
    const configured = FLAGGED.flatMap(stockRouted)[0];
    expect(configured).toBeDefined();
    const patched = patchedWith({ [configured!]: 'claude-user-choice' });
    let compared = 0;
    for (const flagged of FLAGGED) {
      for (const category of [...categories, 'nosuch']) {
        if (category === configured) continue;
        if (stock(flagged, category).matched === 'category') compared++;
        expect(patched(flagged, category), `${flagged} ${category}`).toEqual(
          stock(flagged, category)
        );
      }
    }
    expect(compared).toBeGreaterThan(0);
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
