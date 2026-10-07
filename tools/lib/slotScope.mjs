// Block-scoped identifier resolution over a parsed bundle module, used by
// tools/checkSlotLiterals.mjs (literal prose hiding in slots). Deliberately
// shallow — nearest preceding declarator by name. tools/lib/slotValues.mjs
// needs exact bindings (closures, hoisting, loop and destructuring bindings,
// every write to one binding) and uses eslint-scope instead.

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
