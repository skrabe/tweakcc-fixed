// Block-scoped identifier resolution over a parsed bundle module, shared by
// the gates that need to know what a prompt slot's expression evaluates to:
// tools/checkSlotLiterals.mjs (literal prose hiding in slots) and
// tools/lib/slotValues.mjs (each slot's rendered value, for checkSlotContext).

export const isScope = node =>
  node.type === 'BlockStatement' || node.type === 'Program';

/**
 * Walk the AST tracking the enclosing BLOCK scopes, so a bare-identifier slot
 * can be resolved against the declarators actually in scope at that point.
 *
 * Block, not function. A minified bundle declares `let` in every sibling `if`
 * body of one large function; a function-scoped index merges all of them, and
 * the second cut of this gate did exactly that — three detached-process status
 * strings declared in one block were attributed to five cross-session prompts
 * in another.
 */
export function walk(node, scopeStack, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, scopeStack, visit);
    return;
  }
  const nextStack = isScope(node) ? [...scopeStack, node] : scopeStack;
  visit(node, nextStack);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments') continue;
    const v = node[key];
    if (v && typeof v === 'object') walk(v, nextStack, visit);
  }
}

/**
 * Declarators belonging to one block scope, stopping at nested blocks and
 * nested functions. Memoised per node: without it this re-walks large subtrees
 * for every slot and the run goes from seconds to minutes.
 */
const declCache = new WeakMap();
export function declaratorsOf(scopeNode) {
  const cached = declCache.get(scopeNode);
  if (cached) return cached;
  const index = new Map();
  const visit = (node, top) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, top);
      return;
    }
    if (!top && isScope(node)) return;
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'ObjectMethod' ||
      node.type === 'ClassMethod'
    ) {
      return;
    }
    if (
      node.type === 'VariableDeclarator' &&
      node.id &&
      node.id.type === 'Identifier' &&
      node.init
    ) {
      const list = index.get(node.id.name) || [];
      list.push({ init: node.init, start: node.start });
      index.set(node.id.name, list);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments') continue;
      const v = node[key];
      if (v && typeof v === 'object') visit(v, false);
    }
  };
  visit(scopeNode, true);
  declCache.set(scopeNode, index);
  return index;
}

/**
 * The init for `name` as seen from `useStart`: innermost enclosing function
 * first, and within it the NEAREST PRECEDING declarator.
 *
 * Both halves matter. A minified bundle reuses one-letter names across every
 * sibling block of a large function, so taking every declarator of that name
 * attributes unrelated text to the slot — the first cut did exactly that, and
 * pinned three detached-process status strings from offset 23.8M onto eleven
 * unrelated prompts around offset 3.4M. Restricting to the last declarator
 * before the use site is conservative (a hoisted `var` assigned later is
 * missed) and that is the correct trade here: a missed finding costs one
 * uncatalogued slot, an invented one costs trust in the whole gate.
 */
export function resolveIdentifier(name, scopeStack, useStart) {
  for (let i = scopeStack.length - 1; i >= 0; i--) {
    const decls = declaratorsOf(scopeStack[i]).get(name);
    if (!decls) continue;
    let best = null;
    for (const d of decls) {
      if (d.start >= useStart) continue;
      if (!best || d.start > best.start) best = d;
    }
    return best ? [best.init] : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Function-aware resolution, for callers that follow a slot's value through
// declarations, function returns and module imports (tools/lib/slotValues.mjs).
// It keeps the rules above — block scopes, nearest preceding declarator — and
// adds the one thing a value resolver cannot do without: a minified function's
// parameter shadows every outer binding of the same one-letter name, so a
// name bound by a parameter on the path resolves to "runtime data", never to an
// unrelated outer declarator.
// ---------------------------------------------------------------------------

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);
export const isFunctionNode = node => !!node && FUNCTION_TYPES.has(node.type);

export function patternNames(p, out = []) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  else if (p.type === 'ObjectPattern')
    for (const prop of p.properties)
      patternNames(prop.type === 'RestElement' ? prop : prop.value, out);
  else if (p.type === 'ArrayPattern')
    for (const el of p.elements) patternNames(el, out);
  return out;
}

const paramCache = new WeakMap();
const paramsOf = node => {
  let set = paramCache.get(node);
  if (!set) {
    const names =
      node.type === 'CatchClause'
        ? patternNames(node.param)
        : node.params.flatMap(p => patternNames(p));
    set = new Set(names);
    paramCache.set(node, set);
  }
  return set;
};

/**
 * Like `walk`, but the stack also carries every enclosing function (and catch
 * clause), so a resolver can see parameter bindings. `visit` may return false
 * to skip a node's children.
 */
export function walkScoped(node, stack, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walkScoped(n, stack, visit);
    return;
  }
  const opens =
    isScope(node) || isFunctionNode(node) || node.type === 'CatchClause';
  const next = opens ? [...stack, node] : stack;
  if (visit(node, next) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments') continue;
    const v = node[key];
    if (v && typeof v === 'object') walkScoped(v, next, visit);
  }
}

const fnCache = new WeakMap();
/** Function declarations owned by one block scope (not nested blocks). */
export function functionsOf(scopeNode) {
  let index = fnCache.get(scopeNode);
  if (index) return index;
  index = new Map();
  for (const stmt of scopeNode.body || []) {
    const decl =
      stmt.type === 'ExportNamedDeclaration' ||
      stmt.type === 'ExportDefaultDeclaration'
        ? stmt.declaration
        : stmt;
    if (decl && decl.type === 'FunctionDeclaration' && decl.id)
      index.set(decl.id.name, decl);
  }
  fnCache.set(scopeNode, index);
  return index;
}

const importCache = new WeakMap();
/** A module program's imports: local name -> { source, imported }. */
export function importsOf(program) {
  let index = importCache.get(program);
  if (index) return index;
  index = new Map();
  for (const stmt of program.body || []) {
    if (stmt.type !== 'ImportDeclaration') continue;
    for (const sp of stmt.specifiers) {
      const imported =
        sp.type === 'ImportSpecifier'
          ? (sp.imported.name ?? sp.imported.value)
          : sp.type === 'ImportDefaultSpecifier'
            ? 'default'
            : '*';
      index.set(sp.local.name, { source: stmt.source.value, imported });
    }
  }
  importCache.set(program, index);
  return index;
}

const exportCache = new WeakMap();
/** A module program's exports: exported name -> local name. */
export function exportsOf(program) {
  let index = exportCache.get(program);
  if (index) return index;
  index = new Map();
  for (const stmt of program.body || []) {
    if (stmt.type !== 'ExportNamedDeclaration') continue;
    for (const sp of stmt.specifiers || []) {
      const exported = sp.exported.name ?? sp.exported.value;
      if (sp.local) index.set(exported, sp.local.name);
    }
    const d = stmt.declaration;
    if (d && d.type === 'FunctionDeclaration' && d.id)
      index.set(d.id.name, d.id.name);
    if (d && d.type === 'VariableDeclaration')
      for (const v of d.declarations)
        for (const n of patternNames(v.id)) index.set(n, n);
  }
  exportCache.set(program, index);
  return index;
}

/**
 * What `name` is bound to at `useStart`, seen through `stack` (from
 * walkScoped). One of:
 *   { kind: 'decl', init, stack }      a declarator with an initializer
 *   { kind: 'function', fn, stack }    a function declaration
 *   { kind: 'import', source, imported }
 *   { kind: 'assigned', scope, stack } `let x;` later assigned with `x = …`
 *   { kind: 'param', fn, index, stack } a parameter (values at call sites)
 *   { kind: 'param' }                  a destructured or catch parameter
 *   null                               not found / not resolvable
 * In a block, the nearest PRECEDING declarator wins, as in resolveIdentifier.
 * A use before every declarator of the name is accepted only when the name has
 * exactly one declarator in that scope: a module-level `var X="Read"` declared
 * after the function that interpolates it is the common bundle shape.
 */
export function resolveBinding(name, stack, useStart) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const node = stack[i];
    if (isFunctionNode(node) || node.type === 'CatchClause') {
      if (paramsOf(node).has(name)) {
        if (node.type === 'CatchClause') return { kind: 'param' };
        const index = node.params.findIndex(
          p =>
            (p.type === 'Identifier' && p.name === name) ||
            (p.type === 'AssignmentPattern' &&
              p.left.type === 'Identifier' &&
              p.left.name === name)
        );
        return index === -1
          ? { kind: 'param' }
          : { kind: 'param', fn: node, index, stack: stack.slice(0, i) };
      }
      if (node.type === 'FunctionExpression' && node.id?.name === name)
        return { kind: 'function', fn: node, stack: stack.slice(0, i) };
      continue;
    }
    if (!isScope(node)) continue;
    const decls = declaratorsOf(node).get(name);
    if (decls) {
      let best = null;
      for (const d of decls) {
        if (d.start >= useStart) continue;
        if (!best || d.start > best.start) best = d;
      }
      if (!best && decls.length === 1) best = decls[0];
      if (!best) return null;
      return { kind: 'decl', init: best.init, stack: stack.slice(0, i + 1) };
    }
    const fn = functionsOf(node).get(name);
    if (fn) return { kind: 'function', fn, stack: stack.slice(0, i + 1) };
    if (bareDeclaratorsOf(node).has(name))
      return { kind: 'assigned', scope: node, stack: stack.slice(0, i) };
    if (node.type === 'Program') {
      const imp = importsOf(node).get(name);
      if (imp) return { kind: 'import', ...imp };
    }
  }
  return null;
}

const bareCache = new WeakMap();
/** Names a block scope declares WITHOUT an initializer (`let a, b;`). */
export function bareDeclaratorsOf(scopeNode) {
  let names = bareCache.get(scopeNode);
  if (names) return names;
  names = new Set();
  const visit = (node, top) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, top);
      return;
    }
    if (!top && (isScope(node) || isFunctionNode(node))) return;
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      !node.init
    )
      names.add(node.id.name);
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments') continue;
      const v = node[key];
      if (v && typeof v === 'object') visit(v, false);
    }
  };
  visit(scopeNode, true);
  bareCache.set(scopeNode, names);
  return names;
}
