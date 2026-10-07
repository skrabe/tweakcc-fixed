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
//     binding, including from nested closures; a compound assignment, a
//     destructuring or for-of/for-in binding is runtime data;
//   - an import, followed under its EXPORTED name to the defining module;
//   - every branch of `?:`, `||` and `??`, the right side of `&&` plus "";
//   - `+` concatenation of resolved parts;
//   - a call's every `return`, plus "undefined" when the body can fall
//     through (any body whose last statement is not a return or throw);
//   - a parameter: the argument at every call site of THAT function (the
//     approach of tools/checkParamSlotLiterals.mjs, with real references
//     instead of names), "undefined" for a missing non-default argument, and
//     unknown as well when the function escapes — exported, passed or stored
//     as a value, aliased, or reassigned — since its other callers are unseen.
// Anything else (member reads, method calls, computed numbers) is an UNKNOWN
// branch, null. Unknown is reported, never guessed.
//
// Caching never depends on query order: results are memoised per binding and
// per function, and a binding on a dependency cycle resolves to unknown for
// every member of its cycle (see `memo`).

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
const applyMethod = (call, value) => {
  if (value === null) return null;
  const name = call.callee.property.name;
  if (name === 'slice') {
    const nums = call.arguments.map(literalNumber);
    return nums.some(Number.isNaN) ? value : value.slice(...nums);
  }
  return value[name]();
};

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
      else if (
        expr.callee.type === 'MemberExpression' &&
        expr.callee.object.type === 'Identifier' &&
        STRING_METHODS.has(expr.callee.property.name)
      )
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
  for (const stmt of ast.body) {
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
  };
};

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
  // strongly-connected-components bookkeeping. A binding that depends on
  // itself (`s = s + " more"`, mutually recursive helpers) has no finite
  // literal set, so every member of a cyclic component resolves to unknown.
  // Component membership is a property of the graph, not of which slot was
  // queried first, so cached results never depend on query order; a value
  // computed inside an unfinished component is provisional and is replaced
  // when its root closes.
  memo(key, compute) {
    if (this.cache.has(key)) return this.cache.get(key);
    const frame = this.frames.get(key);
    if (frame && frame.onStack) {
      const cur = this.current;
      if (cur) cur.low = Math.min(cur.low, frame.index);
      if (cur === frame) frame.self = true;
      return [null];
    }
    const mine = { key, index: this.counter, low: this.counter, onStack: true };
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
      const cyclic = members.length > 1 || mine.self;
      for (const m of members) {
        this.cache.set(m.key, cyclic ? [null] : result);
        this.frames.delete(m.key);
      }
      return cyclic ? [null] : result;
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
  // import statements' text so no module has to be parsed to find out.
  importersOf(moduleName, exported) {
    if (!this.importers) {
      this.importers = new Map();
      for (const seg of this.segments) {
        for (const m of seg.source.matchAll(
          /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g
        )) {
          for (const spec of m[1].split(',')) {
            const [imp] = spec.trim().split(/\s+as\s+/);
            if (!imp) continue;
            const key = `${m[2]}\0${imp}`;
            const list = this.importers.get(key) || [];
            if (!list.includes(seg.name)) list.push(seg.name);
            this.importers.set(key, list);
          }
        }
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
    if (def.node.type !== 'ImportSpecifier') return null;
    const imported = def.node.imported.name ?? def.node.imported.value;
    return this.exportedVariable(def.parent.source.value, imported, depth + 1);
  }

  identValue(mod, ident, depth) {
    if (!ident || this.tooDeep(depth)) return [null];
    const ref = mod.refs.get(ident);
    if (!ref || !ref.resolved)
      return ident.name === 'undefined' ? ['undefined'] : [null];
    return this.variableValue(mod, ref.resolved, depth + 1);
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
      if (def.type === 'Parameter') return this.paramValue(mod, def, depth);
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
      return out;
    });
  }

  // The function nodes a callee identifier can be, with their modules.
  calleeFunctions(mod, ident, depth) {
    if (this.tooDeep(depth)) return null;
    const ref = mod.refs.get(ident);
    if (!ref || !ref.resolved) return null;
    return this.variableFunctions(mod, ref.resolved, depth + 1);
  }

  variableFunctions(mod, v, depth) {
    if (this.tooDeep(depth)) return null;
    const def = v.defs[0];
    if (!def) return null;
    if (def.type === 'FunctionName') return [{ mod, fn: def.node }];
    if (def.type === 'ImportBinding') {
      const t = this.importTarget(mod, def, depth);
      return t ? this.variableFunctions(t.mod, t.v, depth + 1) : null;
    }
    if (def.type !== 'Variable') return null;
    const out = [];
    for (const r of v.references.filter(x => x.isWrite())) {
      if (!r.writeExpr || !isFunction(r.writeExpr) || r.isReadWrite())
        return null;
      out.push({ mod, fn: r.writeExpr });
    }
    return out.length ? out : null;
  }

  callValue(mod, ident, depth) {
    const fns = this.calleeFunctions(mod, ident, depth);
    if (!fns) return [null];
    return uniq(fns.flatMap(f => this.returns(f.mod, f.fn, depth + 1)));
  }

  returns(mod, fn, depth) {
    return this.memo(`${mod.name}\0f\0${fn.start}`, () => {
      if (fn.type === 'ArrowFunctionExpression' && fn.expression)
        return this.branches(mod, fn.body, depth + 1);
      const out = [];
      const stack = [...fn.body.body];
      while (stack.length) {
        const node = stack.pop();
        if (isFunction(node)) continue;
        if (node.type === 'ReturnStatement') {
          out.push(
            ...(node.argument
              ? this.branches(mod, node.argument, depth + 1)
              : ['undefined'])
          );
          continue;
        }
        for (const key of Object.keys(node)) {
          if (key === 'range' || key === 'loc') continue;
          const c = node[key];
          if (Array.isArray(c)) {
            for (const x of c)
              if (x && typeof x.type === 'string') stack.push(x);
          } else if (c && typeof c.type === 'string') stack.push(c);
        }
      }
      const last = fn.body.body[fn.body.body.length - 1];
      if (!last || !/^(Return|Throw)Statement$/.test(last.type))
        out.push('undefined');
      return out;
    });
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

  argumentAt(mod, call, index, param, depth) {
    const args = call.arguments;
    if (args.slice(0, index + 1).some(a => a.type === 'SpreadElement'))
      return [null];
    const arg = args[index];
    if (arg) return this.branches(mod, arg, depth + 1);
    return param.type === 'AssignmentPattern'
      ? this.branches(mod, param.right, depth + 1)
      : ['undefined'];
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
      return this.argumentAt(mod, p, index, param, depth);
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
          out.push(...this.argumentAt(m, call, index, param, depth));
        else out.push(null);
      }
    };
    takeRefs(mod, fnVar);
    // An exported function escapes (its use in `export{…}` is already a
    // non-call reference above); add the calls its importers make too.
    for (const [exported, e] of mod.exports) {
      if (e.local !== fnVar.name || mod.moduleScope.set.get(e.local) !== fnVar)
        continue;
      out.push(null);
      for (const importer of this.importersOf(mod.name, exported)) {
        const im = this.module(importer);
        if (!im) continue;
        for (const v of im.moduleScope.variables) {
          const d = v.defs[0];
          if (
            d?.type === 'ImportBinding' &&
            d.parent.source.value === mod.name &&
            (d.node.imported?.name ?? d.node.imported?.value) === exported
          )
            takeRefs(im, v);
        }
      }
    }
    if (!out.length) out.push(null);
    return out;
  }

  branches(mod, expr, depth) {
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
          ...this.branches(mod, expr.consequent, depth + 1),
          ...this.branches(mod, expr.alternate, depth + 1),
        ]);
      case 'LogicalExpression':
        return uniq([
          ...(expr.operator === '&&'
            ? ['']
            : this.branches(mod, expr.left, depth + 1)),
          ...this.branches(mod, expr.right, depth + 1),
        ]);
      case 'BinaryExpression': {
        if (expr.operator !== '+') return [null];
        const l = this.branches(mod, expr.left, depth + 1);
        const r = this.branches(mod, expr.right, depth + 1);
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
          depth + 1
        );
      case 'Identifier':
        return this.identValue(mod, expr, depth + 1);
      case 'CallExpression':
        if (expr.callee.type === 'Identifier')
          return this.callValue(mod, expr.callee, depth + 1);
        if (
          expr.callee.type === 'MemberExpression' &&
          expr.callee.object.type === 'Identifier' &&
          !expr.callee.computed &&
          STRING_METHODS.has(expr.callee.property.name)
        )
          return this.identValue(mod, expr.callee.object, depth + 1).map(v =>
            applyMethod(expr, v)
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
    else if (job.role === 'call') b = resolver.callValue(mod, ident, 0);
    else if (job.role === 'value') b = resolver.identValue(mod, ident, 0);
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
