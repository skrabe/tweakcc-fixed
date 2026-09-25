// Finds every description string in Claude Code's settings JSON schema.
//
// CC sends that schema to the model whole (the /update-config command prompt
// and the "settings.json validation failed" message both carry
// `JSON.stringify(schema)`), so every `.describe(...)` inside it is
// model-facing. The schema is not a static object: it is built by a function
// whose children are minified identifiers, lazy wrappers and calls into other
// modules, so the finder walks everything REACHABLE from the root object,
// resolving bindings through local scopes, the module top level, and ESM
// imports.
//
// Offsets are JS string indices into the virtual bundle, the same space the
// extractor's shifted segment ASTs use.
const { splitModuleBundle, parseModuleSegment } = require('./moduleBundle.cjs');

// Stable top-level setting names; the root is the object literal carrying most
// of them, so one rename cannot blind the finder.
const ROOT_KEYS = [
  '$schema',
  'apiKeyHelper',
  'cleanupPeriodDays',
  'env',
  'permissions',
  'hooks',
  'model',
  'statusLine',
  'enabledPlugins',
  'includeCoAuthoredBy',
  'outputStyle',
  'forceLoginMethod',
];
const ROOT_QUORUM = 8;
const WRAPPER_MAX = 400;

// CC's own test (`sm` in the bundle): a property whose description matches is
// deleted from the schema before it is sent, together with its subtree.
const INTERNAL_RE = /^@internal(?:\b|$)/;

const isFunctionNode = n =>
  n &&
  (n.type === 'FunctionDeclaration' ||
    n.type === 'FunctionExpression' ||
    n.type === 'ArrowFunctionExpression' ||
    n.type === 'ObjectMethod');

const propKeyName = p => {
  if (p.computed) return null;
  if (p.key.type === 'Identifier') return p.key.name;
  if (p.key.type === 'StringLiteral') return p.key.value;
  if (p.key.type === 'NumericLiteral') return String(p.key.value);
  return null;
};

// Flatten a `.describe()` argument into its literal fragments. Returns null
// for anything that is not built purely from string literals and templates.
// An identifier operand is followed to its declaration when that is itself
// literal: CC 2.1.282 appends a shared note constant to the sandbox
// excludedCommands description (`"…sources. "+Md`), and without this the
// whole description was invisible to the finder.
function literalFragments(node, lookup, depth = 0) {
  if (node.type === 'Identifier' && lookup && depth < 4) {
    const init = lookup(node.name);
    return init ? literalFragments(init, lookup, depth + 1) : null;
  }
  if (node.type === 'StringLiteral') {
    return [{ start: node.start, end: node.end, value: node.value }];
  }
  if (node.type === 'TemplateLiteral') {
    // Interpolations render at run time; `quasis` keeps the literal parts so a
    // rendered description can be matched back to its template.
    const quasis = node.quasis.map(q => q.value.cooked);
    return [
      { start: node.start, end: node.end, value: quasis.join('${}'), quasis },
    ];
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = literalFragments(node.left, lookup, depth);
    const r = literalFragments(node.right, lookup, depth);
    return l && r ? [...l, ...r] : null;
  }
  return null;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const UNKNOWN = Symbol('unknown');

// The value of a call argument when it is a literal (`!0`, `!1`, `void 0`,
// strings, numbers, null); UNKNOWN otherwise. CC builds sibling schemas from
// one factory with a boolean flag (`ar(!1)` for settings, `ar(!0)` for
// known_marketplaces.json), so the flag decides which arm of `e?A:B` is sent.
function constantOf(node) {
  if (!node) return undefined;
  switch (node.type) {
    case 'BooleanLiteral':
    case 'StringLiteral':
    case 'NumericLiteral':
      return node.value;
    case 'NullLiteral':
      return null;
    case 'UnaryExpression': {
      if (node.operator === 'void') return undefined;
      if (node.operator !== '!') return UNKNOWN;
      const v = constantOf(node.argument);
      return v === UNKNOWN ? UNKNOWN : !v;
    }
    default:
      return UNKNOWN;
  }
}

const paramNames = fn =>
  (fn.params || []).map(p =>
    p.type === 'Identifier'
      ? p.name
      : p.type === 'AssignmentPattern' && p.left.type === 'Identifier'
        ? p.left.name
        : null
  );

// Does a rendered description (as the model sees it) come from `desc`?
// Template interpolations match any text.
function matchesRendered(desc, rendered) {
  if (!desc.fragments.some(f => f.quasis)) return desc.joined === rendered;
  const parts = desc.fragments.map(f =>
    f.quasis ? f.quasis.map(escapeRe).join('[\\s\\S]*?') : escapeRe(f.value)
  );
  return new RegExp(`^${parts.join('')}$`).test(rendered);
}

const DISCRIMINATOR_KEYS = ['type', 'source', 'kind'];

function discriminator(obj) {
  for (const p of obj.properties) {
    if (p.type !== 'ObjectProperty') continue;
    if (!DISCRIMINATOR_KEYS.includes(propKeyName(p))) continue;
    let v = p.value;
    while (
      v.type === 'CallExpression' &&
      v.callee.type === 'MemberExpression' &&
      v.arguments.length <= 1
    ) {
      v = v.callee.object;
    }
    if (
      v.type === 'CallExpression' &&
      v.callee.type === 'Identifier' &&
      v.arguments.length === 1 &&
      v.arguments[0].type === 'StringLiteral'
    ) {
      return v.arguments[0].value;
    }
  }
  return null;
}

// A description on a union member object belongs to that member.
function describedPath(schema, keyPath) {
  let n = schema;
  while (n.type === 'CallExpression' && n.callee.type === 'MemberExpression') {
    n = n.callee.object;
  }
  if (
    n.type === 'CallExpression' &&
    n.arguments.length >= 1 &&
    n.arguments[0].type === 'ObjectExpression'
  ) {
    const tag = discriminator(n.arguments[0]);
    if (tag) return [...keyPath, `(${tag})`];
  }
  return keyPath;
}

// Declarations visible at a function's top level (var-hoisted + block-level
// let/const/function directly in its body). Minified code reuses short names
// across functions, so each function gets its own scope frame.
function collectDeclarations(statements, into) {
  for (const st of statements) {
    if (!st) continue;
    if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) {
        if (d.id.type === 'Identifier' && d.init) into.set(d.id.name, d.init);
      }
    } else if (st.type === 'FunctionDeclaration' && st.id) {
      into.set(st.id.name, st);
    } else if (
      st.type === 'ExportNamedDeclaration' &&
      st.declaration &&
      st.declaration.type !== 'ClassDeclaration'
    ) {
      collectDeclarations([st.declaration], into);
    }
  }
  return into;
}

function createFinder(code) {
  const segments = splitModuleBundle(code) || [
    { name: '<bundle>', start: 0, source: code },
  ];
  const byName = new Map(segments.map(s => [s.name, s]));
  const modules = new Map();

  function loadModule(seg) {
    if (modules.has(seg.name)) return modules.get(seg.name);
    const ast = parseModuleSegment(seg, null, 'settingsSchema');
    let mod = null;
    if (ast) {
      const top = collectDeclarations(ast.program.body, new Map());
      const imports = new Map();
      const exports = new Map();
      for (const st of ast.program.body) {
        if (st.type === 'ImportDeclaration') {
          for (const sp of st.specifiers) {
            if (sp.type === 'ImportSpecifier') {
              const imported =
                sp.imported.type === 'Identifier'
                  ? sp.imported.name
                  : sp.imported.value;
              imports.set(sp.local.name, {
                from: st.source.value,
                name: imported,
              });
            }
          }
        } else if (st.type === 'ExportNamedDeclaration' && !st.source) {
          for (const sp of st.specifiers || []) {
            const exported =
              sp.exported.type === 'Identifier'
                ? sp.exported.name
                : sp.exported.value;
            exports.set(exported, sp.local.name);
          }
        }
      }
      mod = { seg, ast, top, imports, exports };
    }
    modules.set(seg.name, mod);
    return mod;
  }

  function findRoot() {
    for (const seg of segments) {
      let hits = 0;
      for (const k of ROOT_KEYS) if (seg.source.includes(`${k}:`)) hits++;
      if (hits < ROOT_QUORUM) continue;
      const mod = loadModule(seg);
      if (!mod) continue;
      let best = null;
      const visit = (node, scopes) => {
        if (!node || typeof node !== 'object' || best) return;
        if (Array.isArray(node)) {
          for (const c of node) visit(c, scopes);
          return;
        }
        if (node.type === 'ObjectExpression') {
          const keys = new Set(
            node.properties
              .filter(p => p.type === 'ObjectProperty')
              .map(propKeyName)
          );
          const n = ROOT_KEYS.filter(k => keys.has(k)).length;
          if (n >= ROOT_QUORUM) {
            best = { node, scopes };
            return;
          }
        }
        let next = scopes;
        if (isFunctionNode(node) && node.body.type === 'BlockStatement') {
          next = [...scopes, collectDeclarations(node.body.body, new Map())];
        }
        for (const key of Object.keys(node)) {
          if (key === 'loc' || key === 'start' || key === 'end') continue;
          const child = node[key];
          if (child && typeof child === 'object') visit(child, next);
        }
      };
      visit(mod.ast.program, []);
      if (best) return { mod, ...best };
    }
    return null;
  }

  function resolve(name, mod, scopes) {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].has(name)) {
        return {
          node: scopes[i].get(name),
          mod,
          scopes: scopes.slice(0, i + 1),
        };
      }
    }
    if (mod.top.has(name)) return { node: mod.top.get(name), mod, scopes: [] };
    const imp = mod.imports.get(name);
    if (!imp) return null;
    const seg = byName.get(imp.from);
    if (!seg) return null;
    const target = loadModule(seg);
    if (!target) return null;
    const local = target.exports.get(imp.name) || imp.name;
    return resolve(local, target, []);
  }

  function run() {
    const root = findRoot();
    if (!root) return { root: null, descriptions: [] };
    const descriptions = [];
    const visited = new Set();
    const seenDescribe = new Set();

    const walk = (node, ctx) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const c of node) walk(c, ctx);
        return;
      }
      switch (node.type) {
        case 'ObjectExpression': {
          // A union member is named by its literal discriminator
          // (`type:R("command")`), so sibling variants get distinct paths.
          const tag = discriminator(node);
          if (tag) ctx = { ...ctx, keyPath: [...ctx.keyPath, `(${tag})`] };
          for (const p of node.properties) {
            if (p.type === 'SpreadElement') {
              walk(p.argument, {
                ...ctx,
                gated: ctx.gated || p.argument.type === 'LogicalExpression',
              });
            } else if (p.type === 'ObjectProperty') {
              const k = propKeyName(p);
              const d = propertyDescription(p.value);
              if (d && INTERNAL_RE.test(d.joined)) continue;
              walk(p.value, {
                ...ctx,
                keyPath: k ? [...ctx.keyPath, k] : ctx.keyPath,
              });
            } else if (p.type === 'ObjectMethod') {
              walk(p.body, {
                ...ctx,
                keyPath: [...ctx.keyPath, propKeyName(p) || '?'],
              });
            }
          }
          return;
        }
        case 'CallExpression': {
          const c = node.callee;
          if (
            c.type === 'MemberExpression' &&
            !c.computed &&
            c.property.type === 'Identifier' &&
            c.property.name === 'describe' &&
            node.arguments.length === 1
          ) {
            const frags = literalFragments(node.arguments[0], name => {
              const r = resolve(name, ctx.mod, ctx.scopes);
              return r ? r.node : null;
            });
            if (frags && !seenDescribe.has(node.start)) {
              seenDescribe.add(node.start);
              descriptions.push({
                keyPath: describedPath(c.object, ctx.keyPath).join('.'),
                fragments: frags,
                joined: frags.map(f => f.value).join(''),
                gated: ctx.gated,
                module: ctx.mod.seg.name,
              });
            }
          }
          if (c.type === 'Identifier') {
            const r = resolve(c.name, ctx.mod, ctx.scopes);
            if (r && isFunctionNode(r.node)) {
              const names = paramNames(r.node);
              const bound = new Map();
              names.forEach((n, i) => {
                if (!n) return;
                const v =
                  i < node.arguments.length
                    ? constantOf(node.arguments[i])
                    : undefined;
                if (v !== UNKNOWN) bound.set(n, v);
              });
              const sig = [...bound].map(([k, v]) => `${k}=${v}`).join(',');
              const key = `${r.mod.seg.name}:${r.node.start}:${sig}`;
              if (!visited.has(key)) {
                visited.add(key);
                walk(r.node, {
                  ...ctx,
                  mod: r.mod,
                  scopes: r.scopes,
                  bind: bound,
                });
              }
              walk(node.arguments, ctx);
              return;
            }
          }
          walk(c, ctx);
          walk(node.arguments, ctx);
          return;
        }
        case 'ConditionalExpression': {
          const v =
            node.test.type === 'Identifier' && ctx.params.has(node.test.name)
              ? ctx.params.get(node.test.name)
              : UNKNOWN;
          if (v === UNKNOWN) {
            walk(node.test, ctx);
            walk(node.consequent, ctx);
            walk(node.alternate, ctx);
          } else {
            walk(v ? node.consequent : node.alternate, ctx);
          }
          return;
        }
        case 'Identifier': {
          const r = resolve(node.name, ctx.mod, ctx.scopes);
          if (!r) return;
          const key = `${r.mod.seg.name}:${r.node.start}`;
          if (visited.has(key)) return;
          visited.add(key);
          // Library code (zod itself) has no describe literals, so a large
          // binding without one is skipped; small ones are lazy wrappers
          // (`f(()=>x(V(y)))`) that only point at the real sub-schema.
          const len = r.node.end - r.node.start;
          if (len > WRAPPER_MAX) {
            const src = r.mod.seg.source.slice(
              r.node.start - r.mod.seg.start,
              r.node.end - r.mod.seg.start
            );
            if (!src.includes('.describe(')) return;
          }
          walk(r.node, { ...ctx, mod: r.mod, scopes: r.scopes });
          return;
        }
        case 'MemberExpression':
          walk(node.object, ctx);
          if (node.computed) walk(node.property, ctx);
          return;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
        case 'ObjectMethod': {
          const scopes =
            node.body.type === 'BlockStatement'
              ? [...ctx.scopes, collectDeclarations(node.body.body, new Map())]
              : ctx.scopes;
          const params = new Map(ctx.params);
          for (const n of paramNames(node)) if (n) params.delete(n);
          for (const [k, v] of ctx.bind || []) params.set(k, v);
          walk(node.body, { ...ctx, scopes, params, bind: null });
          return;
        }
        default:
          for (const key of Object.keys(node)) {
            if (
              key === 'loc' ||
              key === 'start' ||
              key === 'end' ||
              key === 'leadingComments' ||
              key === 'trailingComments' ||
              key === 'id'
            ) {
              continue;
            }
            const child = node[key];
            if (child && typeof child === 'object') walk(child, ctx);
          }
      }
    };

    walk(root.node, {
      keyPath: [],
      mod: root.mod,
      scopes: root.scopes,
      gated: false,
      params: new Map(),
      bind: null,
    });
    return {
      root: { module: root.mod.seg.name, start: root.node.start },
      descriptions,
    };
  }

  // The description a property value carries at its outermost `.describe()`
  // (what JSON-schema generation puts on that property).
  function propertyDescription(value) {
    let n = value;
    while (
      n &&
      n.type === 'CallExpression' &&
      n.callee.type === 'MemberExpression'
    ) {
      const prop = n.callee.property;
      if (prop.type === 'Identifier' && prop.name === 'describe') {
        const frags =
          n.arguments.length === 1 && literalFragments(n.arguments[0]);
        return frags ? { joined: frags.map(f => f.value).join('') } : null;
      }
      n = n.callee.object;
    }
    return null;
  }

  return { run };
}

function findSettingsDescriptions(code) {
  return createFinder(code).run();
}

// The bundle as --apply's matcher sees it: its search regex accepts a quote,
// newline or non-ASCII character in either escaped or literal form, so escapes
// are decoded before counting.
function decodeEscapes(s) {
  return s.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([nrt])|(['"`$\\]))/g,
    (m, cp, u4, x2, ctl, q) => {
      if (cp || u4 || x2) {
        return String.fromCodePoint(parseInt(cp || u4 || x2, 16));
      }
      if (ctl) return { n: '\n', r: '\r', t: '\t' }[ctl];
      return q;
    }
  );
}

const countOccurrences = (hay, needle) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    n++;
  }
  return n;
};

// Per fragment start offset: its description's key path, its position in a
// `+` chain, and whether it is safe to catalogue. A fragment is safe only when
// every place --apply could match its text is one of the schema's own sites of
// that text; otherwise an override would land on an unrelated string.
function buildSettingsIndex(code, found = findSettingsDescriptions(code)) {
  const decoded = decodeEscapes(code);
  const probeOf = f =>
    f.quasis
      ? f.quasis.reduce((a, b) => (b.length > a.length ? b : a), '')
      : f.value;
  const sites = new Map();
  for (const d of found.descriptions) {
    for (const f of d.fragments) {
      const probe = probeOf(f);
      sites.set(probe, (sites.get(probe) || 0) + 1);
    }
  }
  const index = new Map();
  for (const d of found.descriptions) {
    d.fragments.forEach((f, i) => {
      const probe = probeOf(f);
      const matches = probe ? countOccurrences(decoded, probe) : 0;
      index.set(f.start, {
        keyPath: d.keyPath,
        part: i + 1,
        parts: d.fragments.length,
        gated: d.gated,
        safe: probe.length > 0 && matches === sites.get(probe),
        matches,
        sites: sites.get(probe),
      });
    });
  }
  return index;
}

module.exports = {
  findSettingsDescriptions,
  buildSettingsIndex,
  decodeEscapes,
  matchesRendered,
  INTERNAL_RE,
  ROOT_KEYS,
};
