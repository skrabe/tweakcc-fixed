// What each catalogued prompt slot RENDERS, resolved from the pristine bundle.
//
// A catalogue entry stores the text between slots and the slot labels, but not
// what a slot puts into the prompt. checkSlotContext needs that: the defects it
// exists for are a slot whose value is a sentence FRAGMENT (" and potentially
// assigned to teammates") or a bare NAME ("ReadNotifications") left standing
// where a sentence starts, while a slot whose value is a whole sentence or
// section can sit anywhere. Neither shape is visible from the override alone.
//
// Resolution reuses the extractor's own slot order (templateIdentifierNodes in
// lib/bundleSites.cjs, the traversal templateShape builds `identifiers` from)
// and the block-scope rules of lib/slotScope.mjs (nearest preceding
// declarator, as in checkSlotLiterals), extended with parameters, function
// returns and module imports. A slot's value is the set of every string it can
// render:
//   - a string literal, or a template literal (nested `${}` kept opaque);
//   - an identifier bound to one of those, followed through imports;
//   - every branch of `?:`, `||` and `??` ("" counts as a branch), the right
//     side of `&&` plus "";
//   - `+` concatenation of resolved parts;
//   - a call's every `return`;
//   - a parameter's arguments at every call site in its module (the approach
//     of tools/checkParamSlotLiterals.mjs), plus unknown when exported;
//   - a `let x;` declared bare and then assigned: every assignment's value.
// Anything else — parameters, member reads, method calls, numbers computed at
// runtime — is an UNKNOWN branch (null). Unknown is reported, never guessed.

import { createRequire } from 'node:module';
import {
  walkScoped,
  resolveBinding,
  isFunctionNode,
  isScope,
  declaratorsOf,
  exportsOf,
} from './slotScope.mjs';

const require = createRequire(import.meta.url);
const { splitModuleBundle, parseModuleSegment } = require('./moduleBundle.cjs');
const {
  PARSE_OPTIONS,
  templateShape,
  templateIdentifierNodes,
} = require('./bundleSites.cjs');
const parser = require('@babel/parser');

export const OPAQUE = '\u0000';
const MAX_DEPTH = 10;
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
const applyMethod = (call, value) => {
  if (value === null) return null;
  const name = call.callee.property.name;
  const nums = call.arguments.map(a =>
    a.type === 'NumericLiteral'
      ? a.value
      : a.type === 'UnaryExpression' &&
          a.operator === '-' &&
          a.argument.type === 'NumericLiteral'
        ? -a.argument.value
        : NaN
  );
  if (name === 'slice')
    return nums.some(Number.isNaN) ? value : value.slice(...nums);
  return value[name]();
};

// Which identifier nodes in one interpolation are RENDERED, and how: `value`
// (the binding's own value) or `call` (the function's return). A ternary or
// `&&` condition, a member's object, and a call's arguments are not rendered.
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

export class BundleResolver {
  constructor(source) {
    this.source = source;
    this.segments = splitModuleBundle(source);
    this.byName = new Map();
    if (this.segments)
      for (const s of this.segments) this.byName.set(s.name, s);
    this.modules = new Map();
    this.moduleOf = new WeakMap();
    this.returnCache = new WeakMap();
    this.paramCache = new Map();
    this.callIndex = new WeakMap();
    this.importers = null;
  }

  // Which modules import which exported name from which module, read from the
  // import statements' text so no module has to be parsed to find out.
  importersOf(moduleName, exported) {
    if (!this.importers) {
      this.importers = new Map();
      for (const seg of this.segments || []) {
        for (const m of seg.source.matchAll(
          /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g
        )) {
          for (const spec of m[1].split(',')) {
            const [imp, local] = spec.trim().split(/\s+as\s+/);
            if (!imp) continue;
            const key = `${m[2]}\0${imp}`;
            const list = this.importers.get(key) || [];
            list.push({ module: seg.name, local: local || imp });
            this.importers.set(key, list);
          }
        }
      }
    }
    return this.importers.get(`${moduleName}\0${exported}`) || [];
  }

  // Every `name(...)` call in a program, with the scope stack at the call.
  calls(program) {
    let index = this.callIndex.get(program);
    if (index) return index;
    index = new Map();
    walkScoped(program, [], (node, stack) => {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        const list = index.get(node.callee.name) || [];
        list.push({ call: node, stack });
        index.set(node.callee.name, list);
      }
      return true;
    });
    this.callIndex.set(program, index);
    return index;
  }

  // A parameter's values are the arguments its function is called with, as in
  // tools/checkParamSlotLiterals.mjs: find the function's name, then every
  // call to that name in the same module that resolves to the same function.
  // A function the module exports may be called from elsewhere, so an
  // exported one also keeps an unknown branch.
  paramValue(b, depth) {
    const key = b.fn;
    const memo = this.paramCache.get(key)?.[b.index];
    if (memo) return memo;
    const slot = this.paramCache.get(key) || [];
    slot[b.index] = [null];
    this.paramCache.set(key, slot);
    const program = b.stack[0];
    let fname = b.fn.id?.name ?? null;
    if (!fname) {
      for (let i = b.stack.length - 1; i >= 0 && !fname; i--) {
        if (!isScope(b.stack[i])) continue;
        for (const [n, ds] of declaratorsOf(b.stack[i]))
          if (ds.some(d => d.init === b.fn)) fname = n;
      }
    }
    const out = [];
    if (!fname || !program || program.type !== 'Program') out.push(null);
    else {
      const param = b.fn.params[b.index];
      const fallback =
        param.type === 'AssignmentPattern'
          ? this.branches(param.right, [...b.stack, b.fn], depth + 1)
          : [''];
      let seen = 0;
      const take = (call, stack) => {
        seen++;
        const arg = call.arguments[b.index];
        if (!arg) out.push(...fallback);
        else if (arg.type === 'SpreadElement') out.push(null);
        else out.push(...this.branches(arg, stack, depth + 1));
      };
      for (const { call, stack } of this.calls(program).get(fname) || []) {
        const target = resolveBinding(fname, stack, call.start);
        const fn =
          target?.kind === 'function'
            ? target.fn
            : target?.kind === 'decl'
              ? target.init
              : null;
        if (fn === b.fn) take(call, stack);
      }
      // An exported function is also called from the modules importing it.
      const home = this.moduleOf.get(program);
      for (const [exported, local] of exportsOf(program)) {
        if (local !== fname || !home) continue;
        for (const imp of this.importersOf(home, exported)) {
          const mod = this.module(imp.module);
          if (!mod) {
            out.push(null);
            continue;
          }
          for (const { call, stack } of this.calls(mod.program).get(
            imp.local
          ) || [])
            if (resolveBinding(imp.local, stack, call.start)?.kind === 'import')
              take(call, stack);
        }
      }
      if (!seen) out.push(null);
    }
    const res = uniq(out);
    slot[b.index] = res;
    return res;
  }

  assignedValue(b, name, depth) {
    const out = [];
    walkScoped(b.scope, b.stack, (node, st) => {
      if (isFunctionNode(node)) return false;
      if (
        node.type === 'AssignmentExpression' &&
        node.operator === '=' &&
        node.left.type === 'Identifier' &&
        node.left.name === name
      )
        out.push(...this.branches(node.right, st, depth + 1));
      return true;
    });
    return out.length ? uniq(out) : [null];
  }

  module(name) {
    if (this.modules.has(name)) return this.modules.get(name);
    const seg = this.byName.get(name);
    const ast = seg
      ? parseModuleSegment(seg, PARSE_OPTIONS, 'slot-values')
      : null;
    const mod = ast ? { name, program: ast.program } : null;
    if (mod) this.moduleOf.set(mod.program, name);
    this.modules.set(name, mod);
    return mod;
  }

  // Every module, parsed in turn; the caller visits each program. Modules other
  // code imports from stay cached; the rest are dropped after their visit.
  *programs() {
    if (!this.segments) {
      const ast = parser.parse(this.source, PARSE_OPTIONS);
      yield { name: null, program: ast.program };
      return;
    }
    for (const seg of this.segments) {
      const cached = this.modules.get(seg.name);
      const mod = cached === undefined ? this.module(seg.name) : cached;
      if (mod) yield mod;
    }
  }

  binding(name, stack, useStart, depth) {
    let b = resolveBinding(name, stack, useStart);
    let hops = 0;
    while (b && b.kind === 'import' && hops++ < MAX_DEPTH) {
      const mod = this.module(b.source);
      if (!mod) return null;
      const local =
        b.imported === '*' ? null : exportsOf(mod.program).get(b.imported);
      if (!local) return null;
      b = resolveBinding(local, [mod.program], Infinity);
    }
    return depth > MAX_DEPTH ? null : b;
  }

  identifierValue(name, stack, useStart, depth) {
    if (name === 'undefined') return [''];
    const b = this.binding(name, stack, useStart, depth);
    if (!b) return [null];
    if (b.kind === 'param')
      return b.fn ? this.paramValue(b, depth + 1) : [null];
    if (b.kind === 'assigned') return this.assignedValue(b, name, depth + 1);
    if (b.kind !== 'decl' || isFunctionNode(b.init)) return [null];
    return this.branches(b.init, b.stack, depth + 1);
  }

  callValue(name, stack, useStart, depth) {
    const b = this.binding(name, stack, useStart, depth);
    if (!b) return [null];
    if (b.kind === 'function') return this.returns(b.fn, b.stack, depth + 1);
    if (b.kind === 'decl' && isFunctionNode(b.init))
      return this.returns(b.init, b.stack, depth + 1);
    return [null];
  }

  returns(fn, stack, depth) {
    if (depth > MAX_DEPTH) return [null];
    if (this.returnCache.has(fn)) return this.returnCache.get(fn);
    this.returnCache.set(fn, [null]);
    const inner = [...stack, fn];
    let out = [];
    if (
      fn.type === 'ArrowFunctionExpression' &&
      fn.body.type !== 'BlockStatement'
    ) {
      out = this.branches(fn.body, inner, depth + 1);
    } else {
      let sawReturn = false;
      walkScoped(fn.body, inner, (node, st) => {
        if (isFunctionNode(node)) return false;
        if (node.type !== 'ReturnStatement') return true;
        sawReturn = true;
        out.push(
          ...(node.argument
            ? this.branches(node.argument, st, depth + 1)
            : [''])
        );
        return false;
      });
      if (!sawReturn) out.push('');
    }
    out = uniq(out);
    this.returnCache.set(fn, out);
    return out;
  }

  branches(expr, stack, depth) {
    if (!expr || depth > MAX_DEPTH) return [null];
    switch (expr.type) {
      case 'StringLiteral':
        return [expr.value];
      case 'NullLiteral':
        return [''];
      case 'NumericLiteral':
        return [String(expr.value)];
      case 'TemplateLiteral':
        return [
          expr.quasis.map(q => q.value.cooked ?? q.value.raw).join(OPAQUE),
        ];
      case 'ConditionalExpression':
        return uniq([
          ...this.branches(expr.consequent, stack, depth + 1),
          ...this.branches(expr.alternate, stack, depth + 1),
        ]);
      case 'LogicalExpression':
        return uniq([
          ...(expr.operator === '&&'
            ? ['']
            : this.branches(expr.left, stack, depth + 1)),
          ...this.branches(expr.right, stack, depth + 1),
        ]);
      case 'BinaryExpression': {
        if (expr.operator !== '+') return [null];
        const l = this.branches(expr.left, stack, depth + 1);
        const r = this.branches(expr.right, stack, depth + 1);
        if (l.length * r.length > MAX_BRANCHES) return [null];
        const out = [];
        for (const a of l)
          for (const b of r) out.push(a === null || b === null ? null : a + b);
        return uniq(out);
      }
      case 'SequenceExpression':
        return this.branches(
          expr.expressions[expr.expressions.length - 1],
          stack,
          depth + 1
        );
      case 'Identifier':
        return this.identifierValue(expr.name, stack, expr.start, depth + 1);
      case 'CallExpression':
        if (expr.callee.type === 'Identifier')
          return this.callValue(expr.callee.name, stack, expr.start, depth + 1);
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
 * aggregated over every site and every rendered position of the label, and
 * stats counts slot positions by outcome.
 */
export function resolveSlotValues(source, catalogue) {
  const byPieces = new Map();
  for (const p of catalogue.prompts || []) {
    if (!p.id || !Array.isArray(p.pieces) || p.pieces.length < 2) continue;
    const k = piecesKey(p.pieces);
    if (!byPieces.has(k)) byPieces.set(k, []);
    byPieces.get(k).push(p);
  }
  const resolver = new BundleResolver(source);
  const values = new Map();
  const matched = new Set();
  const stats = { positions: 0, resolved: 0, unknown: 0, notRendered: 0 };
  const add = (id, label, branches) => {
    if (!values.has(id)) values.set(id, new Map());
    const m = values.get(id);
    const prev = m.get(label);
    m.set(label, {
      branches: uniq([...(prev ? prev.branches : []), ...branches]),
    });
  };
  for (const { program } of resolver.programs()) {
    walkScoped(program, [], (node, stack) => {
      if (node.type !== 'TemplateLiteral' || !node.expressions.length)
        return true;
      const shape = templateShape(node, source);
      const entries = byPieces.get(piecesKey(shape.pieces));
      if (!entries) return true;
      const idNodes = templateIdentifierNodes(node);
      const roles = new Map();
      for (const e of node.expressions) renderedRoles(e, roles);
      for (const p of entries) {
        if (JSON.stringify(p.identifiers) !== JSON.stringify(shape.identifiers))
          continue;
        matched.add(p.id);
        idNodes.forEach(({ node: idn }, k) => {
          const label = (p.identifierMap || {})[String(p.identifiers[k])];
          if (!label) return;
          stats.positions++;
          const role = roles.get(idn);
          if (!role) {
            stats.notRendered++;
            return;
          }
          const b =
            role === 'call'
              ? resolver.callValue(idn.name, stack, idn.start, 0)
              : role === 'value'
                ? resolver.identifierValue(idn.name, stack, idn.start, 0)
                : resolver
                    .identifierValue(idn.name, stack, idn.start, 0)
                    .map(v => applyMethod(role.method, v));
          if (b.some(x => x === null)) stats.unknown++;
          else stats.resolved++;
          add(p.id, label, b);
        });
      }
      return true;
    });
  }
  stats.promptsMatched = matched.size;
  return { values, stats };
}
