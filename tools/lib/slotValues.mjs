// What each catalogued prompt slot RENDERS, resolved from the pristine bundle.
//
// A catalogue entry stores the text between slots and the slot labels, but not
// what a slot puts into the prompt. checkSlotContext needs that: the defects it
// exists for are a slot whose value is a sentence FRAGMENT (" and potentially
// assigned to teammates") or a bare NAME ("ReadNotifications") left standing
// where a sentence starts, while a slot whose value is a whole sentence or
// section can sit anywhere. Neither shape is visible from the override alone.
//
// Two parses per module, each doing what it is canonical for:
//   - Babel, through the extractor's own templateShape/templateIdentifierNodes
//     (lib/bundleSites.cjs), finds each catalogued template and the AST node
//     behind slot N. The extractor's slot order depends on Babel node types
//     (optional chains), so this half must not change parser.
//   - acorn + eslint-scope (both already devDependencies, the pair ESLint
//     itself runs on) answer "what is this identifier bound to": block and
//     function scope, `var` hoisting, closures, for-of/for-in and destructuring
//     bindings, shadowing, and every write to THE SAME binding. A hand-rolled
//     resolver keyed on spelling got each of those wrong.
// The two are joined on source offsets.
//
// A slot's value is the set of every string it can render:
//   - a string literal, or a template literal (nested `${}` kept opaque);
//   - a variable: its initializer AND every later `=` assignment to that same
//     binding, including from nested closures, plus "undefined" when it is
//     declared without an initializer and not definitely assigned before
//     every read;
//   - an import, followed under its EXPORTED name to the defining module;
//   - every branch of `?:`, `||` and `??`; for `&&`, the right side plus the
//     left side's falsy rendering ("false", "0", "", "null", "undefined");
//   - `+` concatenation of resolved parts;
//   - a call's every `return`, plus "undefined" when the body can complete
//     normally (a real completion check, not a last-statement guess). Where a
//     return is a function of the parameters, each call site substitutes its
//     own arguments, so `x=f("A")` and `y=f(" and more")` stay apart;
//   - a parameter: the argument at every call site of THAT function (the
//     approach of tools/checkParamSlotLiterals.mjs, with real references
//     instead of names); a missing or explicit-`undefined` argument takes the
//     default, or renders "undefined" without one.
//
// FAIL SAFE. Anything the resolver does not model exactly contributes an
// UNKNOWN branch (null) rather than being skipped, so checkSlotContext keeps
// its word rule running for that slot. Unknown includes: runtime data
// (member reads, computed numbers, user text), any method call except the
// literal-argument string transforms below, async functions and generators,
// a parameter or function binding that is ever reassigned, a function that
// escapes (exported, default-exported, namespace- or dynamically imported,
// passed or stored as a value), destructuring and loop bindings, and an
// argument that may or may not be `undefined` when a default exists.
//
// Caching never depends on query order: results are memoised per binding and
// per function, and a dependency cycle (`s = s + " more"`, a recursive helper)
// keeps each member's own non-cyclic branches plus unknown (see `memo`).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const { analyze } = require('eslint-scope');
const { splitModuleBundle, parseModuleSegment } = require('./moduleBundle.cjs');
const {
  PARSE_OPTIONS,
  templateShape,
  templateIdentifierNodes,
} = require('./bundleSites.cjs');

export const OPAQUE = '\u0000';
// A recursion guard against pathological chains, not a precision knob: the
// real bundle never reaches it (stats.depthLimited reports any hit).
const MAX_DEPTH = 2000;
const MAX_BRANCHES = 64;

const uniq = list => {
  const out = [];
  const seen = new Set();
  for (const b of list) {
    const k = b === null ? '\u0001null' : b;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
    if (out.length > MAX_BRANCHES) return [null];
  }
  return out;
};

const piecesKey = pieces => pieces.join('\u0002');

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);
const isFunction = n => !!n && FUNCTION_TYPES.has(n.type);

// `${X.slice(0,-1)}`, `${X.trim()}`: the slot renders X's value, transformed.
// The transform is applied when its arguments are literal; otherwise X's value
// stands in, which keeps its shape (a fragment stays a fragment).
const STRING_METHODS = new Set([
  'slice',
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
]);
const literalNumber = a =>
  (a.type === 'NumericLiteral' || a.type === 'Literal') &&
  typeof a.value === 'number'
    ? a.value
    : a.type === 'UnaryExpression' && a.operator === '-'
      ? -literalNumber(a.argument)
      : NaN;
// Apply a string transform when it can be evaluated exactly; otherwise the
// result is unknown.
const applyMethod = (call, value) => {
  if (value === null) return null;
  const name = call.callee.property.name;
  if (name === 'slice') {
    const nums = call.arguments.map(literalNumber);
    return nums.some(Number.isNaN) ? null : value.slice(...nums);
  }
  if (call.arguments.length) return null;
  return value[name]();
};
const isStringMethodCall = expr =>
  expr.type === 'CallExpression' &&
  expr.callee.type === 'MemberExpression' &&
  !expr.callee.computed &&
  expr.callee.object.type === 'Identifier' &&
  expr.callee.property.type === 'Identifier' &&
  STRING_METHODS.has(expr.callee.property.name);

// Which identifier nodes in one (Babel) interpolation are RENDERED, and how:
// `value` (the binding's own value), `call` (the function's return), or a
// string-method call on it. A ternary or `&&` condition, a member's object,
// and a call's arguments are not rendered.
const renderedRoles = (expr, out = new Map()) => {
  if (!expr) return out;
  switch (expr.type) {
    case 'Identifier':
      out.set(expr, 'value');
      break;
    case 'ConditionalExpression':
      renderedRoles(expr.consequent, out);
      renderedRoles(expr.alternate, out);
      break;
    case 'LogicalExpression':
      if (expr.operator !== '&&') renderedRoles(expr.left, out);
      renderedRoles(expr.right, out);
      break;
    case 'BinaryExpression':
      if (expr.operator === '+') {
        renderedRoles(expr.left, out);
        renderedRoles(expr.right, out);
      }
      break;
    case 'CallExpression':
      if (expr.callee.type === 'Identifier') out.set(expr.callee, 'call');
      else if (isStringMethodCall(expr))
        out.set(expr.callee.object, { method: expr });
      break;
    case 'TemplateLiteral':
      for (const e of expr.expressions) renderedRoles(e, out);
      break;
    case 'SequenceExpression':
      renderedRoles(expr.expressions[expr.expressions.length - 1], out);
      break;
    default:
  }
  return out;
};

const ACORN_OPTIONS = {
  ecmaVersion: 'latest',
  allowHashBang: true,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  ranges: true,
};

// Only these node types are ever asked for their parent; recording every
// node's parent roughly doubled the resolver's memory on the real bundle.
const PARENT_OF = new Set([
  'Identifier',
  'VariableDeclarator',
  'VariableDeclaration',
  ...FUNCTION_TYPES,
]);

// One module, parsed for resolution: its eslint-scope analysis, a parent map,
// identifiers by offset (to join Babel's slot nodes), references by
// identifier node, and its export table.
const buildModule = (name, source) => {
  let ast;
  let sourceType = 'module';
  try {
    ast = acorn.parse(source, { ...ACORN_OPTIONS, sourceType });
  } catch {
    sourceType = 'script';
    try {
      ast = acorn.parse(source, { ...ACORN_OPTIONS, sourceType });
    } catch {
      return null;
    }
  }
  const scopeManager = analyze(ast, { ecmaVersion: 2025, sourceType });
  const parent = new Map();
  const identAt = new Map();
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'Identifier') identAt.set(node.start, node);
    for (const key of Object.keys(node)) {
      if (key === 'range' || key === 'loc') continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v)
          if (c && typeof c.type === 'string') {
            if (PARENT_OF.has(c.type)) parent.set(c, node);
            stack.push(c);
          }
      } else if (v && typeof v.type === 'string') {
        if (PARENT_OF.has(v.type)) parent.set(v, node);
        stack.push(v);
      }
    }
  }
  const refs = new Map();
  for (const scope of scopeManager.scopes)
    for (const r of scope.references) refs.set(r.identifier, r);
  const moduleScope =
    scopeManager.scopes.find(s => s.type === 'module') ||
    scopeManager.globalScope;
  const exports = new Map();
  let reExportsAll = false;
  for (const stmt of ast.body) {
    if (stmt.type === 'ExportAllDeclaration') reExportsAll = true;
    if (stmt.type === 'ExportDefaultDeclaration') {
      const d = stmt.declaration;
      if (d.id) exports.set('default', { local: d.id.name });
      else if (d.type === 'Identifier')
        exports.set('default', { local: d.name });
      continue;
    }
    if (stmt.type !== 'ExportNamedDeclaration') continue;
    const from = stmt.source ? stmt.source.value : null;
    for (const sp of stmt.specifiers || []) {
      const exported = sp.exported.name ?? sp.exported.value;
      const local = sp.local.name ?? sp.local.value;
      exports.set(exported, from ? { from, imported: local } : { local });
    }
    const d = stmt.declaration;
    if (d && d.id) exports.set(d.id.name, { local: d.id.name });
    if (d && d.type === 'VariableDeclaration')
      for (const v of d.declarations)
        if (v.id.type === 'Identifier')
          exports.set(v.id.name, { local: v.id.name });
  }
  return {
    name,
    ast,
    scopeManager,
    parent,
    identAt,
    refs,
    moduleScope,
    exports,
    reExportsAll,
  };
};

// Can control reach the end of `node` (and so run the statement after it)?
// Conservative: anything not modelled can complete.
const loopBodyBreaks = node => {
  let found = false;
  const walk = (n, depth) => {
    if (!n || found || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x, depth);
      return;
    }
    if (typeof n.type !== 'string' || isFunction(n)) return;
    if (n.type === 'BreakStatement' && (depth === 0 || n.label)) {
      found = true;
      return;
    }
    const nested = /^(For|ForIn|ForOf|While|DoWhile|Switch)Statement$/.test(
      n.type
    );
    for (const key of Object.keys(n)) {
      if (key === 'range' || key === 'loc') continue;
      walk(n[key], depth + (nested ? 1 : 0));
    }
  };
  walk(node, 0);
  return found;
};
export const canComplete = node => {
  if (!node) return true;
  switch (node.type) {
    case 'ReturnStatement':
    case 'ThrowStatement':
      return false;
    case 'BlockStatement':
      return node.body.every(canComplete);
    case 'IfStatement':
      return (
        !node.alternate ||
        canComplete(node.consequent) ||
        canComplete(node.alternate)
      );
    case 'TryStatement': {
      if (node.finalizer && !canComplete(node.finalizer)) return false;
      return (
        canComplete(node.block) ||
        (!!node.handler && canComplete(node.handler.body))
      );
    }
    case 'SwitchStatement': {
      if (!node.cases.some(c => c.test === null)) return true;
      if (node.cases.some(c => loopBodyBreaks(c.consequent))) return true;
      const last = node.cases[node.cases.length - 1];
      return last.consequent.every(canComplete);
    }
    case 'LabeledStatement':
      return canComplete(node.body) || loopBodyBreaks(node.body);
    case 'WhileStatement':
    case 'ForStatement': {
      const infinite =
        node.type === 'ForStatement'
          ? !node.test
          : node.test.type === 'Literal' && node.test.value === true;
      return !infinite || loopBodyBreaks(node.body);
    }
    case 'DoWhileStatement':
      return canComplete(node.body) || loopBodyBreaks(node.body);
    default:
      return true;
  }
};

const FALSY_RENDERINGS = new Set([
  '',
  'false',
  '0',
  'null',
  'undefined',
  'NaN',
]);
const BOOLEAN_OPERATORS = new Set([
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'instanceof',
]);

export class BundleResolver {
  constructor(source) {
    this.source = source;
    this.segments = splitModuleBundle(source) || [
      { name: null, start: 0, source },
    ];
    this.byName = new Map(this.segments.map(s => [s.name, s]));
    this.modules = new Map();
    this.cache = new Map();
    this.frames = new Map();
    this.tarjan = [];
    this.current = null;
    this.counter = 0;
    this.depthLimited = 0;
    this.cycleNull = new Set();
    this.substituting = new Set();
    this.importers = null;
  }

  module(name) {
    if (this.modules.has(name)) return this.modules.get(name);
    const seg = this.byName.get(name);
    const mod = seg ? buildModule(name, seg.source) : null;
    this.modules.set(name, mod);
    return mod;
  }

  // Memoise a computation over the value-dependency graph with Tarjan's
  // strongly-connected-components bookkeeping. When a component closes and
  // it is cyclic, each member is recomputed ONCE with every member of the
  // component reading as unknown: the result keeps the member's own branches
  // that do not run through the cycle, plus unknown. That recomputation sees
  // the same inputs whichever member the query entered by, so cached results
  // never depend on query order (the first, provisional pass does, which is
  // why it is thrown away).
  memo(key, compute) {
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.cycleNull.has(key)) return [null];
    const frame = this.frames.get(key);
    if (frame && frame.onStack) {
      const cur = this.current;
      if (cur) cur.low = Math.min(cur.low, frame.index);
      if (cur === frame) frame.self = true;
      return [null];
    }
    const mine = {
      key,
      compute,
      index: this.counter,
      low: this.counter,
      onStack: true,
    };
    this.counter++;
    this.frames.set(key, mine);
    this.tarjan.push(mine);
    const parent = this.current;
    this.current = mine;
    let result;
    try {
      result = uniq(compute());
    } finally {
      this.current = parent;
    }
    if (mine.low === mine.index) {
      const members = [];
      let f;
      do {
        f = this.tarjan.pop();
        f.onStack = false;
        members.push(f);
      } while (f !== mine);
      for (const m of members) this.frames.delete(m.key);
      if (members.length === 1 && !mine.self) {
        this.cache.set(key, result);
        return result;
      }
      for (const m of members) this.cycleNull.add(m.key);
      const finals = members.map(m => {
        const saved = this.current;
        this.current = null;
        try {
          return uniq([...m.compute(), null]);
        } finally {
          this.current = saved;
        }
      });
      members.forEach((m, i) => {
        this.cycleNull.delete(m.key);
        this.cache.set(m.key, finals[i]);
      });
      return this.cache.get(key);
    }
    if (parent) parent.low = Math.min(parent.low, mine.low);
    return result;
  }

  tooDeep(depth) {
    if (depth <= MAX_DEPTH) return false;
    this.depthLimited++;
    return true;
  }

  // Which modules import which exported name from which module, read from the
  // import statements' text so no module has to be parsed to find out:
  // `import{a as b}from"m"`, `import D,{a}from'm'`, `import*as N from"m"`
  // (recorded under "*", meaning every export escapes) and `import("m")`.
  importersOf(moduleName, exported) {
    if (!this.importers) {
      this.importers = new Map();
      const note = (src, name, importer) => {
        const key = `${src}\0${name}`;
        const list = this.importers.get(key) || [];
        if (!list.includes(importer)) list.push(importer);
        this.importers.set(key, list);
      };
      const IMPORT =
        /import\s*(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s*as\s+[\w$]+)?\s*from\s*["']([^"']+)["']/g;
      const STAR =
        /import\s*(?:[\w$]+\s*,\s*)?\*\s*as\s+[\w$]+\s*from\s*["']([^"']+)["']/g;
      const DYNAMIC = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
      for (const seg of this.segments) {
        for (const m of seg.source.matchAll(IMPORT)) {
          if (m[1]) note(m[3], 'default', seg.name);
          for (const spec of (m[2] || '').split(',')) {
            const [imp] = spec.trim().split(/\s+as\s+/);
            if (imp) note(m[3], imp, seg.name);
          }
        }
        for (const m of seg.source.matchAll(STAR)) note(m[1], '*', seg.name);
        for (const m of seg.source.matchAll(DYNAMIC)) note(m[1], '*', seg.name);
      }
    }
    return this.importers.get(`${moduleName}\0${exported}`) || [];
  }

  // The variable an export name stands for, following re-exports.
  exportedVariable(moduleName, exported, depth) {
    if (this.tooDeep(depth)) return null;
    const mod = this.module(moduleName);
    const e = mod && mod.exports.get(exported);
    if (!e) return null;
    if (e.from) return this.exportedVariable(e.from, e.imported, depth + 1);
    const v = mod.moduleScope.set.get(e.local);
    return v ? { mod, v } : null;
  }

  importTarget(mod, def, depth) {
    const imported =
      def.node.type === 'ImportSpecifier'
        ? (def.node.imported.name ?? def.node.imported.value)
        : def.node.type === 'ImportDefaultSpecifier'
          ? 'default'
          : null;
    if (!imported) return null;
    return this.exportedVariable(def.parent.source.value, imported, depth + 1);
  }

  identValue(mod, ident, depth, env) {
    if (!ident || this.tooDeep(depth)) return [null];
    const ref = mod.refs.get(ident);
    if (!ref || !ref.resolved)
      return ident.name === 'undefined' ? ['undefined'] : [null];
    if (env && env.has(ref.resolved)) return env.get(ref.resolved);
    return this.variableValue(mod, ref.resolved, depth + 1);
  }

  // Is the declared-but-uninitialised `v` definitely assigned before every
  // read? Only the simple, common shape is proved: the declaration's block
  // holds, after it, a statement that assigns `v` on every path, and every
  // read of `v` comes after that statement.
  definitelyAssigned(mod, v) {
    const decl = v.defs[0]?.parent;
    const block = decl && mod.parent.get(decl);
    if (!block || !Array.isArray(block.body)) return false;
    const writes = new Set(
      v.references.filter(r => r.isWrite()).map(r => r.identifier)
    );
    const assigns = node => {
      if (!node) return false;
      switch (node.type) {
        case 'ExpressionStatement':
          return assigns(node.expression);
        case 'AssignmentExpression':
          return node.operator === '=' && writes.has(node.left);
        case 'SequenceExpression':
          return node.expressions.some(assigns);
        case 'BlockStatement':
          return node.body.some(assigns);
        case 'IfStatement':
          return (
            !!node.alternate &&
            assigns(node.consequent) &&
            assigns(node.alternate)
          );
        case 'TryStatement':
          return (
            assigns(node.block) && (!node.handler || assigns(node.handler.body))
          );
        default:
          return false;
      }
    };
    const after = block.body.slice(block.body.indexOf(decl) + 1);
    const done = after.find(assigns);
    if (!done) return false;
    return v.references
      .filter(r => r.isRead())
      .every(r => r.identifier.start >= done.end);
  }

  isLoopBinding(mod, v) {
    return v.defs.some(d => {
      const loop = d.parent && mod.parent.get(d.parent);
      return (
        !!loop &&
        /^For(Of|In)Statement$/.test(loop.type) &&
        loop.left === d.parent
      );
    });
  }

  // Does every read of `v` see a value? Either an initialised declarator
  // sits in a block that holds every read, after it (a later declarator of
  // the same `let a=…,b=a` counts; a `var`
  // initialised inside an `if` and read after it does not), or the binding
  // is definitely assigned (see definitelyAssigned).
  readsSeeAValue(mod, v) {
    const reads = v.references.filter(r => r.isRead());
    for (const d of v.defs) {
      if (!d.node.init) continue;
      const block = mod.parent.get(d.parent);
      if (
        block &&
        Array.isArray(block.body) &&
        reads.every(
          r => r.identifier.start >= d.node.end && r.identifier.end <= block.end
        )
      )
        return true;
    }
    return this.definitelyAssigned(mod, v);
  }

  variableValue(mod, v, depth) {
    const vkey = `${mod.name}\0v\0${v.name}\0${v.defs[0]?.name?.start ?? v.scope.block.start}`;
    return this.memo(vkey, () => {
      const def = v.defs[0];
      if (!def) return [null];
      if (def.type === 'ImportBinding') {
        const t = this.importTarget(mod, def, depth);
        return t ? this.variableValue(t.mod, t.v, depth + 1) : [null];
      }
      if (def.type === 'Parameter') {
        const out = this.paramValue(mod, def, depth);
        // A parameter reassigned in the body (`x ??= …`, `if (c) x = o.p`)
        // is not just its arguments.
        return v.references.some(r => r.isWrite() && !r.init)
          ? [...out, null]
          : out;
      }
      if (def.type !== 'Variable') return [null];
      if (v.defs.some(d => d.node.id.type !== 'Identifier')) return [null];
      const writes = v.references.filter(r => r.isWrite());
      if (!writes.length) return ['undefined'];
      const out = [];
      for (const r of writes) {
        const p = mod.parent.get(r.identifier);
        const loopBinding =
          p &&
          (((p.type === 'ForOfStatement' || p.type === 'ForInStatement') &&
            p.left === r.identifier) ||
            (p.type === 'VariableDeclarator' &&
              /^For(Of|In)Statement$/.test(
                mod.parent.get(mod.parent.get(p))?.type || ''
              ) &&
              mod.parent.get(mod.parent.get(p)).left === mod.parent.get(p)));
        if (r.partial || r.isReadWrite() || loopBinding || !r.writeExpr)
          out.push(null);
        else out.push(...this.branches(mod, r.writeExpr, depth + 1));
      }
      if (!this.isLoopBinding(mod, v) && !this.readsSeeAValue(mod, v))
        out.push('undefined');
      return out;
    });
  }

  // The functions a callee identifier can be, with their modules, and
  // whether it may also be something unseen (a reassigned declaration, a
  // non-function write).
  calleeFunctions(mod, ident, depth, env) {
    if (this.tooDeep(depth)) return { fns: [], unknown: true };
    const ref = mod.refs.get(ident);
    if (!ref || !ref.resolved || (env && env.has(ref.resolved)))
      return { fns: [], unknown: true };
    return this.variableFunctions(mod, ref.resolved, depth + 1);
  }

  variableFunctions(mod, v, depth) {
    if (this.tooDeep(depth)) return { fns: [], unknown: true };
    const def = v.defs[0];
    if (!def) return { fns: [], unknown: true };
    if (def.type === 'FunctionName')
      return {
        fns: [{ mod, fn: def.node }],
        unknown: v.references.some(r => r.isWrite() && !r.init),
      };
    if (def.type === 'ImportBinding') {
      const t = this.importTarget(mod, def, depth);
      return t
        ? this.variableFunctions(t.mod, t.v, depth + 1)
        : { fns: [], unknown: true };
    }
    if (def.type !== 'Variable') return { fns: [], unknown: true };
    const fns = [];
    let unknown = false;
    for (const r of v.references.filter(x => x.isWrite())) {
      if (!r.writeExpr || !isFunction(r.writeExpr) || r.isReadWrite())
        unknown = true;
      else fns.push({ mod, fn: r.writeExpr });
    }
    return { fns, unknown: unknown || !fns.length };
  }

  // The value of `callee(...args)`. A function whose returns depend on its
  // parameters is evaluated with THIS call's arguments substituted, so two
  // calls of one helper never pool their arguments; a recursive call falls
  // back to the function's memoised return set (every call site's union).
  callValue(mod, call, depth, env) {
    const { fns, unknown } = this.calleeFunctions(mod, call.callee, depth, env);
    const out = unknown ? [null] : [];
    for (const { mod: fm, fn } of fns) {
      if (fn.async || fn.generator) {
        out.push(null);
        continue;
      }
      if (this.substituting.has(fn) || !fn.params.length) {
        out.push(...this.returns(fm, fn, depth + 1));
        continue;
      }
      const sub = this.paramEnv(fm, fn, call, mod, depth, env);
      if (!sub) {
        out.push(...this.returns(fm, fn, depth + 1));
        continue;
      }
      this.substituting.add(fn);
      try {
        out.push(...this.returnSet(fm, fn, depth + 1, sub));
      } finally {
        this.substituting.delete(fn);
      }
    }
    return uniq(out);
  }

  // Parameter variable -> branches for one call. Only plain and defaulted
  // identifier parameters are substituted; anything else falls back.
  paramEnv(fm, fn, call, cm, depth, env) {
    const vars = fm.scopeManager.getDeclaredVariables(fn);
    const sub = new Map();
    for (let i = 0; i < fn.params.length; i++) {
      const p = fn.params[i];
      const id = p.type === 'AssignmentPattern' ? p.left : p;
      if (id.type !== 'Identifier') return null;
      const v = vars.find(x => x.defs.some(d => d.name === id));
      if (!v) return null;
      if (v.references.some(r => r.isWrite() && !r.init)) return null;
      sub.set(v, this.argumentAt(cm, call, i, p, fm, depth, env));
    }
    return sub;
  }

  returns(mod, fn, depth) {
    return this.memo(`${mod.name}\0f\0${fn.start}`, () =>
      fn.async || fn.generator
        ? [null]
        : this.returnSet(mod, fn, depth + 1, null)
    );
  }

  returnSet(mod, fn, depth, env) {
    if (fn.type === 'ArrowFunctionExpression' && fn.expression)
      return this.branches(mod, fn.body, depth + 1, env);
    const out = [];
    const stack = [...fn.body.body];
    while (stack.length) {
      const node = stack.pop();
      if (isFunction(node)) continue;
      if (node.type === 'ReturnStatement') {
        out.push(
          ...(node.argument
            ? this.branches(mod, node.argument, depth + 1, env)
            : ['undefined'])
        );
        continue;
      }
      for (const key of Object.keys(node)) {
        if (key === 'range' || key === 'loc') continue;
        const c = node[key];
        if (Array.isArray(c)) {
          for (const x of c) if (x && typeof x.type === 'string') stack.push(x);
        } else if (c && typeof c.type === 'string') stack.push(c);
      }
    }
    if (canComplete(fn.body)) out.push('undefined');
    return out;
  }

  // The function's own variable, if it has one we can follow every use of.
  functionVariable(mod, fn) {
    if (fn.type === 'FunctionDeclaration' && fn.id)
      return mod.scopeManager
        .getDeclaredVariables(fn)
        .find(
          x =>
            x.name === fn.id.name && x.defs.some(d => d.type === 'FunctionName')
        );
    const p = mod.parent.get(fn);
    if (
      p &&
      p.type === 'VariableDeclarator' &&
      p.init === fn &&
      p.id.type === 'Identifier'
    )
      return mod.scopeManager.getDeclaredVariables(p)[0];
    return null;
  }

  // What parameter `index` (node `param`, of a function in module `fm`)
  // receives from `call` (in module `cm`). A missing argument or an explicit
  // `undefined` / `void 0` takes the default; an argument that may or may
  // not be undefined at runtime, with a default present, is unknown too.
  argumentAt(cm, call, index, param, fm, depth, env) {
    const args = call.arguments;
    if (args.slice(0, index + 1).some(a => a.type === 'SpreadElement'))
      return [null];
    const hasDefault = param.type === 'AssignmentPattern';
    const fallback = () =>
      hasDefault
        ? this.branches(fm, param.right, depth + 1, null)
        : ['undefined'];
    const arg = args[index];
    const isUndefined =
      arg &&
      ((arg.type === 'Identifier' &&
        arg.name === 'undefined' &&
        !cm.refs.get(arg)?.resolved) ||
        (arg.type === 'UnaryExpression' && arg.operator === 'void'));
    if (!arg || isUndefined) return fallback();
    const got = this.branches(cm, arg, depth + 1, env);
    if (!hasDefault) return got;
    if (got.includes('undefined'))
      return uniq([...got.filter(b => b !== 'undefined'), ...fallback(), null]);
    return got;
  }

  paramValue(mod, def, depth) {
    const fn = def.node;
    if (!isFunction(fn)) return [null];
    const index = fn.params.findIndex(
      p =>
        p === def.name ||
        (p.type === 'AssignmentPattern' && p.left === def.name)
    );
    if (index === -1) return [null];
    const param = fn.params[index];
    const p = mod.parent.get(fn);
    // An IIFE: the one call is right there.
    if (p && p.type === 'CallExpression' && p.callee === fn)
      return this.argumentAt(mod, p, index, param, mod, depth, null);
    const fnVar = this.functionVariable(mod, fn);
    if (!fnVar) return [null];
    const out = [];
    const takeRefs = (m, variable) => {
      for (const r of variable.references) {
        if (r.init) continue;
        if (r.isWrite()) {
          out.push(null);
          continue;
        }
        const call = m.parent.get(r.identifier);
        if (
          call &&
          call.type === 'CallExpression' &&
          call.callee === r.identifier
        )
          out.push(...this.argumentAt(m, call, index, param, mod, depth, null));
        else out.push(null);
      }
    };
    takeRefs(mod, fnVar);
    // An exported function escapes (its use in `export{…}` is already a
    // non-call reference above); a namespace or dynamic import of its module
    // lets anything call it. Add the calls its named importers make too.
    if (this.importersOf(mod.name, '*').length || mod.reExportsAll)
      out.push(null);
    for (const [exported, e] of mod.exports) {
      if (e.local !== fnVar.name || mod.moduleScope.set.get(e.local) !== fnVar)
        continue;
      out.push(null);
      for (const importer of this.importersOf(mod.name, exported)) {
        const im = this.module(importer);
        if (!im) continue;
        for (const v of im.moduleScope.variables) {
          const d = v.defs[0];
          if (d?.type !== 'ImportBinding' || d.parent.source.value !== mod.name)
            continue;
          const name =
            d.node.type === 'ImportDefaultSpecifier'
              ? 'default'
              : (d.node.imported?.name ?? d.node.imported?.value);
          if (name === exported) takeRefs(im, v);
        }
      }
    }
    if (!out.length) out.push(null);
    return out;
  }

  // The falsy renderings `left && right` can produce from its left side.
  falsyBranches(mod, left, depth, env) {
    if (
      (left.type === 'UnaryExpression' && left.operator === '!') ||
      (left.type === 'BinaryExpression' && BOOLEAN_OPERATORS.has(left.operator))
    )
      return ['false'];
    return this.branches(mod, left, depth + 1, env).filter(
      b => b === null || FALSY_RENDERINGS.has(b)
    );
  }

  branches(mod, expr, depth, env = null) {
    if (!expr || this.tooDeep(depth)) return [null];
    switch (expr.type) {
      case 'Literal':
        if (expr.regex) return [null];
        return [expr.value === null ? 'null' : String(expr.value)];
      case 'TemplateLiteral':
        return [
          expr.quasis.map(q => q.value.cooked ?? q.value.raw).join(OPAQUE),
        ];
      case 'ConditionalExpression':
        return uniq([
          ...this.branches(mod, expr.consequent, depth + 1, env),
          ...this.branches(mod, expr.alternate, depth + 1, env),
        ]);
      case 'LogicalExpression':
        return uniq([
          ...(expr.operator === '&&'
            ? this.falsyBranches(mod, expr.left, depth, env)
            : this.branches(mod, expr.left, depth + 1, env)),
          ...this.branches(mod, expr.right, depth + 1, env),
        ]);
      case 'BinaryExpression': {
        if (expr.operator !== '+') return [null];
        const l = this.branches(mod, expr.left, depth + 1, env);
        const r = this.branches(mod, expr.right, depth + 1, env);
        if (l.length * r.length > MAX_BRANCHES) return [null];
        const out = [];
        for (const a of l)
          for (const b of r) out.push(a === null || b === null ? null : a + b);
        return uniq(out);
      }
      case 'SequenceExpression':
        return this.branches(
          mod,
          expr.expressions[expr.expressions.length - 1],
          depth + 1,
          env
        );
      case 'Identifier':
        return this.identValue(mod, expr, depth + 1, env);
      case 'CallExpression':
        if (expr.callee.type === 'Identifier')
          return this.callValue(mod, expr, depth + 1, env);
        if (isStringMethodCall(expr))
          return this.identValue(mod, expr.callee.object, depth + 1, env).map(
            v => applyMethod(expr, v)
          );
        return [null];
      default:
        return [null];
    }
  }
}

/**
 * Resolve every slot of every catalogued prompt found in `source`.
 * Returns { values, stats } where values is
 *   Map<id, Map<label, { branches: (string|null)[] }>>
 * aggregated over every site and every rendered position of the label.
 * `stats.slotBearing` counts catalogue ids with at least one slot and
 * `stats.promptsMatched` how many of them were located in the bundle.
 * `options.reverse` walks modules and slots in reverse order (an
 * order-independence check; results must not change).
 */
export function resolveSlotValues(source, catalogue, options = {}) {
  const byPieces = new Map();
  const slotBearing = new Set();
  for (const p of catalogue.prompts || []) {
    if (!p.id || !Array.isArray(p.pieces) || p.pieces.length < 2) continue;
    slotBearing.add(p.id);
    const k = piecesKey(p.pieces);
    if (!byPieces.has(k)) byPieces.set(k, []);
    byPieces.get(k).push(p);
  }
  const resolver = new BundleResolver(source);
  const values = new Map();
  const matched = new Set();
  const stats = { positions: 0, resolved: 0, unknown: 0, notRendered: 0 };
  const jobs = [];
  const segments = options.reverse
    ? [...resolver.segments].reverse()
    : resolver.segments;
  for (const seg of segments) {
    const ast =
      seg.name === null
        ? require('@babel/parser').parse(source, PARSE_OPTIONS)
        : parseModuleSegment(seg, PARSE_OPTIONS, 'slot-values');
    if (!ast) continue;
    const stack = [ast.program];
    while (stack.length) {
      const node = stack.pop();
      if (node.type === 'TemplateLiteral' && node.expressions.length) {
        const shape = templateShape(node, source);
        const entries = byPieces.get(piecesKey(shape.pieces));
        if (entries) {
          const idNodes = templateIdentifierNodes(node);
          const roles = new Map();
          for (const e of node.expressions) renderedRoles(e, roles);
          for (const p of entries) {
            if (
              JSON.stringify(p.identifiers) !==
              JSON.stringify(shape.identifiers)
            )
              continue;
            matched.add(p.id);
            idNodes.forEach(({ node: idn }, k) => {
              const label = (p.identifierMap || {})[String(p.identifiers[k])];
              if (label)
                jobs.push({
                  id: p.id,
                  label,
                  seg,
                  start: idn.start - seg.start,
                  role: roles.get(idn),
                });
            });
          }
        }
      }
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        const v = node[key];
        if (Array.isArray(v)) {
          for (const c of v) if (c && typeof c.type === 'string') stack.push(c);
        } else if (v && typeof v.type === 'string') stack.push(v);
      }
    }
  }
  if (options.reverse) jobs.reverse();
  const add = (id, label, branches) => {
    if (!values.has(id)) values.set(id, new Map());
    const m = values.get(id);
    const prev = m.get(label);
    m.set(label, {
      branches: uniq([...(prev ? prev.branches : []), ...branches]),
    });
  };
  for (const job of jobs) {
    stats.positions++;
    if (!job.role) {
      stats.notRendered++;
      continue;
    }
    const mod = resolver.module(job.seg.name);
    const ident = mod && mod.identAt.get(job.start);
    let b;
    if (!ident) b = [null];
    else if (job.role === 'call') {
      const call = mod.parent.get(ident);
      b =
        call && call.type === 'CallExpression' && call.callee === ident
          ? resolver.callValue(mod, call, 0, null)
          : [null];
    } else if (job.role === 'value') b = resolver.identValue(mod, ident, 0);
    else
      b = resolver
        .identValue(mod, ident, 0)
        .map(v => applyMethod(job.role.method, v));
    if (b.some(x => x === null)) stats.unknown++;
    else stats.resolved++;
    add(job.id, job.label, b);
  }
  // Branch order is an artefact of traversal; sort so equal sets compare equal.
  for (const m of values.values())
    for (const [l, v] of m)
      m.set(l, {
        branches: [...v.branches].sort((a, b) =>
          a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0
        ),
      });
  stats.promptsMatched = matched.size;
  stats.depthLimited = resolver.depthLimited;
  stats.slotBearing = slotBearing.size;
  return { values, stats };
}
