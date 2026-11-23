#!/usr/bin/env node
// Sibling-arm gate: when one arm of a switch or ternary is a catalogued
// model-facing literal, every other arm that returns a literal is almost
// certainly model-facing too, so each must be catalogued or carry a verdict.
//
// Why this exists. The extractor finds prompts one literal at a time: a long
// string clears the prose gate, a short one only gets in through a cache
// verdict. A short arm whose verdict was never asked for therefore falls
// through silently, even when its sibling arm two cases up is catalogued. On CC
// 2.1.295 the `call_only` arm of the unreachable-attached-machines reminder
// ("${h} A call to ${s?"it":"one of them"} takes up to 10 seconds to fail and
// ${y}") was missed while its `rechecked` sibling was catalogued; only a
// cross-check against the upstream catalogue noticed. The artifact approval
// question builder had two more (`delete` and the unattended `public_change`
// arm) with every other case catalogued.
//
// A group is
//   - a `switch`: the literals returned from each of its cases (through `if`
//     blocks inside the case, ternary arms, array elements, `+` chains and
//     `||`/`??`), plus the return it falls out to (the statements after it,
//     when it has no `default` or a case `break`s) as its default arm,
//   - a returned ternary: the literal leaves of a conditional that is a
//     `return` argument or an arrow body,
//   - a list: an array literal holding a `...xs.map(cb)` / `...xs.flatMap(cb)`
//     spread, whose arms are its plain elements and every return of those
//     callbacks (nested switches included),
//   - a call group: the arguments at one position across every call of one
//     function binding in a module (`p("Clicked.")`, `p("text must be a
//     string")`), the callee resolved lexically by name and never followed, or
//   - a respelling row: `[needle, replacement]` in a table of such pairs. Its
//     anchor is not an arm but the catalogued prompt whose text contains the
//     needle, since the replacement renders into that prompt at runtime; a
//     needle that is a bare key token marks a lookup table and anchors nothing.
// An array, `+` chain or `[…].join()` that is one value of a group (a case's
// return, a call's argument) is one arm when the extractor ruled its joined
// text (a composite verdict), beside any leaf ruled on its own; otherwise its
// own literal leaves are the arms, each under the body the extractor looks it
// up by (a composite element is a fragment). The leaves of a join group are
// always its arms: there the joined text is the group.
// A group is checked only when one of its arms is catalogued (a `model` cache
// verdict or a catalogue body). Each other arm that has no verdict at all
// (current or pre-promotion key), is not catalogued, and reads as words (two
// or more outside `${}`, counting the literals a slot falls back to; in a join
// or return union any letter, so a one-word heading line counts) is a finding.
// A bare word (`error`, `read_file`) never is: the extractor hard-excludes it,
// since a content-keyed verdict on it would catalogue every code comparison of
// that word. Arms that already carry a `ui`/`internal` verdict were ruled on
// and are not re-reported.
//
// Usage:
//   node tools/checkSiblingArms.mjs <cli.js> <prompts.json>
//     [--cache data/prompt-classification.json] [--json]
// Exit 0 = no finding, 1 = findings, 2 = usage error or a bundle segment acorn
// could not parse (its arms were never seen, so a pass would be unearned).
// With --json, stdout is the JSON alone and the summary goes to stderr.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  buildEntries,
  detectVersion,
  entryKeys,
  keyVariants,
} from './probeCacheKey.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const ex = require('./promptExtractor.js');
const { splitModuleBundle } = require('./lib/moduleBundle.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE = path.join(
  HERE,
  '..',
  'data',
  'prompt-classification.json'
);

const USAGE =
  'usage: node tools/checkSiblingArms.mjs <cli.js> <prompts.json> [--cache <classification.json>] [--json]';

const FN_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

function parseSegment(source) {
  const opts = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
  };
  try {
    return acorn.parse(source, { ...opts, sourceType: 'module' });
  } catch {
    return acorn.parse(source, { ...opts, sourceType: 'script' });
  }
}

function childNodes(n) {
  const out = [];
  for (const key in n) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const c = n[key];
    if (!c || typeof c !== 'object') continue;
    if (Array.isArray(c)) {
      for (const x of c) if (x && typeof x.type === 'string') out.push(x);
    } else if (typeof c.type === 'string') out.push(c);
  }
  return out;
}

const isLiteralLeaf = n =>
  (n.type === 'Literal' && typeof n.value === 'string') ||
  n.type === 'TemplateLiteral';
const isConcat = n => n.type === 'BinaryExpression' && n.operator === '+';

// The arm nodes an expression can evaluate to, looking through ternary arms,
// `||`/`??` operands and the tail of a comma list. A literal, an array and a
// `+` chain are arm nodes; armOf() opens the last two.
function leaves(n, out = []) {
  if (!n) return out;
  if (isLiteralLeaf(n) || isConcat(n) || n.type === 'ArrayExpression')
    out.push(n);
  else if (n.type === 'ConditionalExpression') {
    leaves(n.consequent, out);
    leaves(n.alternate, out);
  } else if (n.type === 'LogicalExpression' && n.operator !== '&&') {
    leaves(n.left, out);
    leaves(n.right, out);
  } else if (n.type === 'SequenceExpression') leaves(n.expressions.at(-1), out);
  return out;
}

// The prose of a literal, from the AST: a template's cooked quasis, so a `{`
// inside a slot (`${e("{")} Please confirm`) cannot swallow the text after it,
// plus the literals a slot can render by itself: its ternary arms and `??`/`||`
// fallbacks. `${p??"the arguments"} ${d.message??"are not valid"}` has no word
// outside its slots.
const proseOf = n =>
  n.type === 'Literal'
    ? n.value
    : [
        ...n.quasis.map(q => q.value.cooked ?? q.value.raw),
        ...n.expressions.flatMap(e =>
          leaves(e).filter(isLiteralLeaf).map(proseOf)
        ),
      ].join(' ');

// An arm as absolute ranges: a literal carries its prose; an array or `+`
// chain carries `parts`, the arms of its elements / operands, used when the
// joined text has no verdict of its own.
function armOf(n, base) {
  const arm = { start: base + n.start, end: base + n.end };
  if (isLiteralLeaf(n)) {
    arm.text = proseOf(n);
    return arm;
  }
  const kids = isConcat(n)
    ? [n.left, n.right]
    : n.elements.filter(el => el && el.type !== 'SpreadElement');
  arm.parts = kids.flatMap(k => leaves(k)).map(k => armOf(k, base));
  return arm;
}

// Return arguments reachable from a case body without entering a nested
// function or, unless `intoSwitches`, a nested switch (which forms its own
// group).
function caseReturns(stmts, { intoSwitches = false } = {}) {
  const out = [];
  const stack = [...stmts];
  while (stack.length) {
    const n = stack.pop();
    if (
      !n ||
      FN_TYPES.has(n.type) ||
      (n.type === 'SwitchStatement' && !intoSwitches) ||
      n.type === 'ClassBody'
    )
      continue;
    if (n.type === 'ReturnStatement') {
      if (n.argument) out.push(n.argument);
      continue;
    }
    if (/Expression$/.test(n.type)) continue;
    stack.push(...childNodes(n));
  }
  return out;
}

const LOOP_TYPES = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

// `true`, `!0` and `1`-style constant tests never let a loop exit on its own.
const alwaysTrue = t =>
  !t ||
  (t.type === 'Literal' && Boolean(t.value)) ||
  (t.type === 'UnaryExpression' &&
    t.operator === '!' &&
    t.argument.type === 'Literal' &&
    !t.argument.value);

const union = (...sets) => new Set(sets.flatMap(s => [...s]));
const without = (set, ...drop) => {
  const out = new Set(set);
  for (const d of drop) out.delete(d);
  return out;
};

// How a statement can complete: 'normal', 'return', 'throw', 'break' and
// 'continue' (unlabelled), 'break:L' and 'continue:L'. Expressions are never
// entered, so a nested function's returns are not this statement's.
function completions(n) {
  if (!n) return new Set(['normal']);
  if (Array.isArray(n)) return listCompletions(n);
  switch (n.type) {
    case 'BlockStatement':
    case 'StaticBlock':
      return listCompletions(n.body);
    case 'ReturnStatement':
      return new Set(['return']);
    case 'ThrowStatement':
      return new Set(['throw']);
    case 'BreakStatement':
      return new Set([n.label ? `break:${n.label.name}` : 'break']);
    case 'ContinueStatement':
      return new Set([n.label ? `continue:${n.label.name}` : 'continue']);
    case 'IfStatement':
      return union(completions(n.consequent), completions(n.alternate));
    case 'LabeledStatement': {
      const c = completions(n.body);
      const out = without(
        c,
        `break:${n.label.name}`,
        `continue:${n.label.name}`
      );
      if (c.has(`break:${n.label.name}`)) out.add('normal');
      return out;
    }
    case 'SwitchStatement':
      return switchCompletions(n);
    case 'TryStatement': {
      let c = completions(n.block);
      if (n.handler)
        c = union(without(c, 'throw'), completions(n.handler.body));
      if (!n.finalizer) return c;
      const f = completions(n.finalizer);
      return f.has('normal') ? union(c, without(f, 'normal')) : f;
    }
    case 'WithStatement':
      return completions(n.body);
    default:
      if (LOOP_TYPES.has(n.type)) {
        const body = completions(n.body);
        const out = without(body, 'break', 'continue', 'normal');
        const each = n.type === 'ForInStatement' || n.type === 'ForOfStatement';
        const testRuns =
          n.type !== 'DoWhileStatement' ||
          body.has('normal') ||
          body.has('continue');
        if (body.has('break') || (testRuns && (each || !alwaysTrue(n.test))))
          out.add('normal');
        return out;
      }
      return new Set(['normal']);
  }
}

function listCompletions(stmts) {
  const out = new Set();
  for (const s of stmts) {
    const c = completions(s);
    for (const k of c) if (k !== 'normal') out.add(k);
    if (!c.has('normal')) return out;
  }
  out.add('normal');
  return out;
}

// A switch completes normally when no clause matches (no `default`), when a
// `break` binds to it, or when the last clause runs off its end (every clause
// that runs off its end falls through into the next).
function switchCompletions(sw) {
  const out = new Set();
  if (!sw.cases.some(c => c.test === null)) out.add('normal');
  sw.cases.forEach((c, i) => {
    const cc = completions(c.consequent);
    for (const k of cc) {
      if (k === 'break') out.add('normal');
      else if (k !== 'normal' || i === sw.cases.length - 1) out.add(k);
    }
  });
  if (!sw.cases.length) out.add('normal');
  return out;
}

// Can control leave the switch to the statements after it? A labelled
// `break` to the switch's own label leaves it too.
function fallsOut(sw, parents) {
  const c = switchCompletions(sw);
  if (c.has('normal')) return true;
  const p = parents && parents.get(sw);
  return p?.type === 'LabeledStatement' && c.has(`break:${p.label.name}`);
}

// The statements that run after a switch falls out: its later siblings in the
// enclosing statement list. Their return is the switch's default arm.
function fallOutStatements(sw, parents) {
  if (!fallsOut(sw, parents)) return [];
  let node = sw;
  let p = parents.get(node);
  while (p?.type === 'LabeledStatement') {
    node = p;
    p = parents.get(node);
  }
  const list = p && (Array.isArray(p.body) ? p.body : p.consequent);
  if (!Array.isArray(list)) return [];
  const i = list.indexOf(node);
  return i < 0 ? [] : list.slice(i + 1);
}

// Return arguments of a callback, through nested switches but not nested
// functions; an expression-bodied arrow returns its body.
const callbackReturns = fn =>
  fn.body.type === 'BlockStatement'
    ? caseReturns(fn.body.body, { intoSwitches: true })
    : [fn.body];

// `...xs.map(cb)` / `...xs.flatMap(cb)`: the callback whose returns become
// elements of the enclosing array. `map` and `flatMap` are built-in names.
function spreadCallback(el) {
  if (el?.type !== 'SpreadElement') return null;
  const call = el.argument;
  if (call.type !== 'CallExpression' || call.callee.type !== 'MemberExpression')
    return null;
  const name = call.callee.property?.name;
  if (name !== 'map' && name !== 'flatMap') return null;
  const fn = call.arguments[0];
  return fn && FN_TYPES.has(fn.type) ? fn : null;
}

// A list assembled from spread callbacks has no composite of its own (its
// elements are not all literals), so its clauses are only ever seen one by
// one. Arms: the plain elements and every callback return.
function listArms(arr) {
  const callbacks = arr.elements.map(spreadCallback);
  if (!callbacks.some(Boolean)) return null;
  return arr.elements.flatMap((el, i) => {
    if (!el) return [];
    if (callbacks[i])
      return callbackReturns(callbacks[i]).flatMap(r => leaves(r));
    return el.type === 'SpreadElement' ? [] : leaves(el);
  });
}

const plainString = n =>
  (n?.type === 'Literal' && typeof n.value === 'string') ||
  (n?.type === 'TemplateLiteral' && n.expressions.length === 0);
const isPair = n =>
  n?.type === 'ArrayExpression' &&
  n.elements.length === 2 &&
  n.elements.every(plainString);

// The cooked value of a plain string node.
const stringValue = n =>
  n.type === 'Literal' ? n.value : (n.quasis[0].value.cooked ?? '');

// Is `n` one row of a respelling table, `[[needle, replacement], …]`? The
// replacement is substituted for the needle in some host text at runtime, so
// it renders wherever that host does.
function isRespellingRow(n, parents) {
  if (!isPair(n)) return false;
  const table = parents.get(n);
  return table?.type === 'ArrayExpression' && table.elements.every(isPair);
}

// Is the top of a ternary chain returned? Climbs through the wrappers leaves()
// looks through, then requires a `return` or an arrow body.
function isReturned(node, parents) {
  let cur = node;
  let p = parents.get(cur);
  while (
    p &&
    (p.type === 'ArrayExpression' ||
      isConcat(p) ||
      (p.type === 'LogicalExpression' && p.operator !== '&&') ||
      (p.type === 'SequenceExpression' && p.expressions.at(-1) === cur))
  ) {
    cur = p;
    p = parents.get(cur);
  }
  if (!p) return false;
  if (p.type === 'ReturnStatement') return true;
  return p.type === 'ArrowFunctionExpression' && p.body === cur;
}

const FLOW_KINDS = new Set(['join', 'returns', 'calls']);

const BLOCK_TYPES = new Set([
  'BlockStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'SwitchStatement',
  'Program',
  'StaticBlock',
  'CatchClause',
]);

function flowGroups(nodes, parents, base) {
  const declarations = new Map();
  const bindings = new Map();
  const pushes = new Map();
  const functions = new Map();
  const functionOf = n => {
    if (functions.has(n)) return functions.get(n);
    const p = parents.get(n);
    const fn =
      !p || FN_TYPES.has(p.type) || p.type === 'Program' ? p : functionOf(p);
    functions.set(n, fn);
    return fn;
  };
  const blockOf = n => {
    let p = parents.get(n);
    while (p && !BLOCK_TYPES.has(p.type) && !FN_TYPES.has(p.type))
      p = parents.get(p);
    return p;
  };
  const declare = (scope, pattern) => {
    if (!scope || !pattern) return;
    if (pattern.type === 'Identifier') {
      if (!declarations.has(scope)) declarations.set(scope, new Set());
      declarations.get(scope).add(pattern.name);
    } else if (pattern.type === 'RestElement') declare(scope, pattern.argument);
    else if (pattern.type === 'AssignmentPattern') declare(scope, pattern.left);
    else if (pattern.type === 'ArrayPattern')
      for (const el of pattern.elements) declare(scope, el);
    else if (pattern.type === 'ObjectPattern')
      for (const prop of pattern.properties)
        declare(
          scope,
          prop.type === 'RestElement' ? prop.argument : prop.value
        );
  };
  const bindingScope = (from, name) => {
    const fn = functionOf(from);
    let p = parents.get(from);
    while (p) {
      if (declarations.get(p)?.has(name)) return p;
      if (p === fn) break;
      p = parents.get(p);
    }
    return null;
  };
  // Scope nodes keyed by identity: offsets collide (a function at 0 and its
  // Program both start at 0).
  const scopeIds = new Map();
  const scopeId = scope => {
    if (!scopeIds.has(scope)) scopeIds.set(scope, scopeIds.size);
    return scopeIds.get(scope);
  };
  const add = (map, scope, name, expr) => {
    if (!scope) return;
    if (!map.has(scope)) map.set(scope, new Map());
    const byName = map.get(scope);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(expr);
  };
  for (const n of nodes) {
    if (n.type === 'VariableDeclaration') {
      const scope = n.kind === 'var' ? functionOf(n) : blockOf(n);
      for (const d of n.declarations) declare(scope, d.id);
    } else if (FN_TYPES.has(n.type)) {
      for (const p of n.params) declare(n, p);
      if (n.id)
        declare(n.type === 'FunctionDeclaration' ? blockOf(n) : n, n.id);
    } else if (n.type === 'CatchClause') declare(n, n.param);
    else if (n.type === 'ClassDeclaration') declare(blockOf(n), n.id);
    else if (n.type === 'ImportDeclaration')
      for (const s of n.specifiers) declare(parents.get(n), s.local);
  }
  const roots = [];
  const returns = new Map();
  for (const n of nodes) {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init)
      add(bindings, bindingScope(n, n.id.name), n.id.name, n.init);
    else if (
      n.type === 'AssignmentExpression' &&
      n.left.type === 'Identifier' &&
      (n.operator === '=' || n.operator === '+=')
    )
      add(bindings, bindingScope(n, n.left.name), n.left.name, n.right);
    else if (
      n.type === 'CallExpression' &&
      n.callee.type === 'MemberExpression' &&
      !n.callee.computed &&
      n.callee.object.type === 'Identifier' &&
      ['push', 'unshift'].includes(n.callee.property.name)
    )
      for (const a of n.arguments)
        add(
          pushes,
          bindingScope(n, n.callee.object.name),
          n.callee.object.name,
          a.type === 'SpreadElement' ? a.argument : a
        );
    if (
      (n.type === 'CallExpression' &&
        n.callee.type === 'MemberExpression' &&
        !n.callee.computed &&
        n.callee.property.name === 'join') ||
      (isConcat(n) && !isConcat(parents.get(n) || {}))
    )
      roots.push({ node: n, kind: 'join', args: [n] });
    if (n.type === 'ReturnStatement' && n.argument) {
      const fn = functionOf(n);
      if (!fn || fn.type === 'Program') continue;
      if (!returns.has(fn)) returns.set(fn, []);
      returns.get(fn).push(n.argument);
    }
  }
  for (const [fn, args] of returns)
    if (args.length > 1) roots.push({ node: fn, kind: 'returns', args });

  // Call groups: the arguments at one position across every call of one
  // function binding (`p("Clicked.")`, `p("text must be a string")`). Bounded
  // by design: the callee resolves lexically within this module, by name, and
  // calls are never followed. An imported binding is a module-scope name too
  // (the code-split bundle imports its emitters from sibling chunks); grouping
  // its calls needs only the local name, never the implementation.
  const calleeScope = (from, name) => {
    for (let p = parents.get(from); p; p = parents.get(p))
      if (declarations.get(p)?.has(name)) return p;
    return null;
  };
  const calls = new Map();
  for (const n of nodes) {
    if (
      (n.type !== 'CallExpression' && n.type !== 'NewExpression') ||
      n.callee.type !== 'Identifier'
    )
      continue;
    const scope = calleeScope(n, n.callee.name);
    if (!scope) continue;
    for (const [i, a] of n.arguments.entries()) {
      // Past a spread the position of every later argument is unknown.
      if (a.type === 'SpreadElement') break;
      const key = `${scopeId(scope)}:${n.callee.name}:${i}`;
      if (!calls.has(key))
        calls.set(key, { node: n, args: [], sites: [], position: i });
      calls.get(key).args.push(a);
      calls.get(key).sites.push(n);
    }
  }
  for (const { node, args, sites, position } of calls.values())
    if (args.length > 1)
      roots.push({ node, kind: 'calls', args, sites, position });

  // `[…].join(sep)`: the extractor's composite for it spans the call, with the
  // separator applied.
  const isArrayJoin = n =>
    n.type === 'CallExpression' &&
    n.callee.type === 'MemberExpression' &&
    !n.callee.computed &&
    n.callee.property.name === 'join' &&
    n.callee.object.type === 'ArrayExpression';
  // The values an expression can take, into `out` (node -> arm). With `whole`
  // (the arguments of a call group and the values of a return set, each one
  // value), an array, `+` chain or `[…].join()` is one arm holding its own
  // flowed parts, so resolve() can read it as the composite the extractor
  // ruled; a joined string's own pieces (`whole` off) are the arms themselves.
  const flow = (n, out, seen, depth, via, whole) => {
    if (!n || depth > 6) return;
    if (
      whole &&
      (isConcat(n) || n.type === 'ArrayExpression' || isArrayJoin(n))
    ) {
      if (out.has(n)) return;
      const parts = new Map();
      out.set(n, { via, parts });
      open(isArrayJoin(n) ? n.callee.object : n, parts, seen, depth, via, true);
      if (!parts.size) out.delete(n);
    } else if (isLiteralLeaf(n)) {
      if (!out.has(n)) out.set(n, { via });
    } else open(n, out, seen, depth, via, whole);
  };
  const open = (n, out, seen, depth, via, whole) => {
    if (n.type === 'ConditionalExpression') {
      flow(n.consequent, out, seen, depth, via, whole);
      flow(n.alternate, out, seen, depth, via, whole);
    } else if (n.type === 'LogicalExpression') {
      if (n.operator !== '&&') flow(n.left, out, seen, depth, via, whole);
      flow(n.right, out, seen, depth, via, whole);
    } else if (isConcat(n)) {
      flow(n.left, out, seen, depth, via, whole);
      flow(n.right, out, seen, depth, via, whole);
    } else if (n.type === 'SequenceExpression') {
      flow(n.expressions.at(-1), out, seen, depth, via, whole);
    } else if (n.type === 'ArrayExpression') {
      for (const el of n.elements) {
        if (!el) continue;
        if (el.type !== 'SpreadElement') flow(el, out, seen, depth, via, whole);
        else {
          const fn = spreadCallback(el);
          if (fn) {
            if (fn.body.type !== 'BlockStatement')
              flow(fn.body, out, seen, depth + 1, via, whole);
          } else
            flow(
              el.argument,
              out,
              seen,
              depth + 1,
              via === 'direct' ? 'spread' : via,
              whole
            );
        }
      }
    } else if (n.type === 'Identifier') {
      const scope = bindingScope(n, n.name);
      if (!scope) return;
      const key = `${n.name}@${scopeId(scope)}`;
      if (seen.has(key)) return;
      seen.add(key);
      for (const expr of bindings.get(scope)?.get(n.name) || [])
        if (functionOf(expr) === functionOf(n))
          flow(expr, out, seen, depth + 1, 'ident', whole);
      for (const expr of pushes.get(scope)?.get(n.name) || [])
        if (functionOf(expr) === functionOf(n))
          flow(expr, out, seen, depth + 1, 'push', whole);
    } else if (n.type === 'CallExpression') {
      const c = n.callee;
      if (
        c.type === 'MemberExpression' &&
        !c.computed &&
        ['join', 'filter', 'concat', 'trim', 'slice', 'flat'].includes(
          c.property.name
        )
      ) {
        flow(c.object, out, seen, depth, via, whole);
        if (c.property.name === 'concat')
          for (const a of n.arguments) flow(a, out, seen, depth, via, whole);
      }
    } else if (n.type === 'ParenthesizedExpression') {
      flow(n.expression, out, seen, depth, via, whole);
    }
  };
  const armFrom = (n, { via, parts }) => ({
    start: base + n.start,
    end: base + n.end,
    ...(parts
      ? { parts: [...parts].map(([p, a]) => armFrom(p, a)) }
      : {
          text:
            n.type === 'Literal'
              ? n.value
              : n.quasis.map(q => q.value.cooked ?? q.value.raw).join(' '),
        }),
    via,
  });
  // Literals in a flowed value, through its composites: a group of one
  // array's elements still pairs them, as it did before arrays were arms.
  const leafCount = arms =>
    [...arms.values()].reduce(
      (n, a) => n + (a.parts ? leafCount(a.parts) : 1),
      0
    );
  const groups = [];
  for (const root of roots) {
    const out = new Map();
    const seen = new Set();
    for (const arg of root.args)
      flow(arg, out, seen, 0, 'direct', root.kind !== 'join');
    if (leafCount(out) < 2) continue;
    groups.push({
      kind: root.kind,
      at: base + root.node.start,
      end: base + root.node.end,
      ...(root.sites && {
        callee: root.node.callee.name,
        position: root.position,
        callSites: root.sites.map(c => ({
          start: base + c.start,
          end: base + c.end,
        })),
      }),
      arms: [...out].map(([n, a]) => armFrom(n, a)),
    });
  }
  return groups;
}

// Every switch / returned-ternary group in `code`, its arms as absolute
// ranges (see armOf), and the bundle segments acorn could not parse.
export function armGroups(code) {
  const segments = splitModuleBundle(code) || [
    { name: '', start: 0, source: code },
  ];
  const groups = [];
  const unparsed = [];
  for (const seg of segments) {
    let ast;
    try {
      ast = parseSegment(seg.source);
    } catch (err) {
      unparsed.push({
        name: seg.name,
        start: seg.start,
        error: err.message.split('\n')[0],
      });
      continue;
    }
    const parents = new Map();
    const nodes = [];
    const stack = [ast];
    while (stack.length) {
      const n = stack.pop();
      nodes.push(n);
      let arms = null;
      let kind = null;
      if (n.type === 'SwitchStatement') {
        kind = 'switch';
        arms = n.cases
          .map(c => c.consequent)
          .concat([fallOutStatements(n, parents)])
          .flatMap(stmts => caseReturns(stmts).flatMap(r => leaves(r)));
      } else if (n.type === 'ArrayExpression' && isRespellingRow(n, parents)) {
        const [needle, replacement] = n.elements;
        groups.push({
          kind: 'respelling',
          at: seg.start + n.start,
          needle: stringValue(needle),
          arms: [armOf(replacement, seg.start)],
        });
      } else if (n.type === 'ArrayExpression') {
        kind = 'list';
        arms = listArms(n);
      } else if (
        n.type === 'ConditionalExpression' &&
        parents.get(n)?.type !== 'ConditionalExpression' &&
        isReturned(n, parents)
      ) {
        kind = 'ternary';
        arms = leaves(n);
      }
      if (arms && arms.length > 1)
        groups.push({
          kind,
          at: seg.start + n.start,
          arms: arms.map(a => armOf(a, seg.start)),
        });
      for (const c of childNodes(n)) {
        parents.set(c, n);
        stack.push(c);
      }
    }
    groups.push(...flowGroups(nodes, parents, seg.start));
  }
  return { groups, unparsed };
}

// One word: letters, a one-letter word included, with inner apostrophes or
// hyphens, once surrounding punctuation is stripped. A token carrying `_` or
// `/`, or a dot between letters, is an identifier, path or host
// (`own_calls`, `/usr/bin/chromium`, `api.github.com`), not prose.
const WORD = /^[A-Za-z]+(?:['\u2019-][A-Za-z]+)*$/;
const isWord = token => {
  if (/[_/\\${}]/.test(token)) return false;
  const core = token.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
  return WORD.test(core);
};

// Two or more words in the literal text of an arm (a template's quasis, never
// its slots): an enum value, a bare slot or punctuation can be an arm but is
// never a prompt on its own.
export function readsAsWords(text) {
  let n = 0;
  for (const token of text.split(/\s+/)) {
    if (token && isWord(token) && ++n >= 2) return true;
  }
  return false;
}

// Catalogue pieces keep a template's source escapes; a needle is cooked.
const cook = s =>
  s.replace(
    /\\([nrt`$\\'"])/g,
    (_m, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c
  );

const neverCatalogued = body =>
  ex.isBareToken(cook(body)) || ex.isHardExcluded(body);

function quietly(fn) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

// The scan proper. `catalogue` is the prompts array of a prompts JSON; `cache`
// the classification cache object.
export function scanSiblingArms(cliPath, { catalogue, cache, version } = {}) {
  const code = fs.readFileSync(cliPath, 'utf8');
  ex.setCcVersionForCacheLookups(version || detectVersion(cliPath, code));
  const { groups, unparsed } = armGroups(code);
  const required = new Set();
  const pending = groups.flatMap(g => g.arms);
  while (pending.length) {
    const arm = pending.pop();
    required.add(`${arm.start}:${arm.end}`);
    if (arm.parts) pending.push(...arm.parts);
  }
  const records = quietly(() =>
    ex.collectLiteralSites(cliPath, { composites: true })
  );
  // A string folded into a composite element keeps only its fragment entry
  // (buildEntries), so every kind but the joined composite text is a literal
  // site; where a range has more than one, string/template wins.
  const literals = new Map();
  const composites = new Map();
  const templates = [];
  const rank = e => (e.kind === 'string' || e.kind === 'template' ? 0 : 1);
  const sitesByBody = new Map();
  for (const e of buildEntries(records)) {
    const k = `${e.start}:${e.end}`;
    if (typeof e.cacheBody === 'string') {
      if (!sitesByBody.has(e.cacheBody)) sitesByBody.set(e.cacheBody, []);
      sitesByBody.get(e.cacheBody).push(e);
    }
    if (e.kind === 'composite') {
      if (!composites.has(k)) composites.set(k, e);
      continue;
    }
    if (e.kind === 'template') templates.push(e);
    if (!required.has(k)) continue;
    if (!literals.has(k)) literals.set(k, []);
    literals.get(k).push(e);
  }
  for (const list of literals.values()) list.sort((a, b) => rank(a) - rank(b));

  const catalogued = new Map();
  const hosts = [];
  for (const p of catalogue || []) {
    const body = (p.pieces || []).filter(x => typeof x === 'string').join('');
    for (const v of keyVariants(body))
      if (!catalogued.has(v.key)) catalogued.set(v.key, p.id);
    if (p.id) hosts.push({ id: p.id, text: cook(body) });
  }
  // The catalogued prompts whose text holds a respelling needle: the host the
  // replacement renders into. A needle that is a bare key token ("teammate",
  // "ECONNRESET", "claude-3-5-sonnet") makes the table a key-to-label lookup
  // whose key merely turns up in unrelated prompts; a reworded phrase carries
  // a space or punctuation ("upload_asset:", "clearer than terminal text").
  const hostsOf = needle =>
    needle.trim() && !/^[$\w.-]+$/.test(needle.trim())
      ? hosts.filter(h => h.text.includes(needle)).map(h => h.id)
      : [];
  const ruling = e => {
    const keys = entryKeys(e);
    const verdict = keys.map(k => cache?.[k.key]).find(Boolean) || null;
    const catId = keys.map(k => catalogued.get(k.key)).find(Boolean) || null;
    return {
      start: e.start,
      end: e.end,
      kind: e.kind,
      body: e.cacheBody,
      key: keys[0]?.key,
      verdict: verdict
        ? { facing: verdict.facing, ...(verdict.id && { id: verdict.id }) }
        : null,
      // A bare word or a template with no prose outside its slots is never
      // catalogued (the extractor hard-excludes both), so a `model` verdict on
      // one anchors nothing; it still counts as ruled.
      modelId: neverCatalogued(e.cacheBody ?? '')
        ? null
        : verdict?.facing === 'model'
          ? verdict.id || catId || '(unnamed)'
          : catId,
    };
  };
  const memo = new Map();
  const lookup = (map, start, end) => {
    const k = `${map === composites ? 'c' : 'l'}:${start}:${end}`;
    if (memo.has(k)) return memo.get(k);
    let r = null;
    const hit = map.get(`${start}:${end}`);
    if (map === composites) r = hit ? ruling(hit) : null;
    else if (hit) {
      const rulings = hit.map(ruling);
      r = rulings.find(x => x.modelId || x.verdict) || rulings[0];
    }
    memo.set(k, r);
    return r;
  };
  // An array or `+` chain whose joined text is ruled is one arm, covering its
  // unruled parts; a part with a verdict or catalogue entry of its own stays an
  // arm beside it, since that is the text the catalogue splices and a verdict
  // contradicting the whole's is what the mixed gate exists to show. Unruled,
  // its parts are the arms. A flowed part keeps the `via` it was reached by:
  // the whole's, unless a variable inside it was followed.
  const resolve = arm => {
    if (!arm.parts) {
      const r = lookup(literals, arm.start, arm.end);
      return r ? [{ ...r, text: arm.text, via: arm.via }] : [];
    }
    const parts = arm.parts.flatMap(resolve);
    const c = lookup(composites, arm.start, arm.end);
    if (!c || !(c.verdict || c.modelId)) return parts;
    return [
      { ...c, via: arm.via },
      ...parts.filter(p => p.verdict || p.modelId),
    ];
  };

  const modelSpans = [];
  for (const entry of templates)
    if (ruling(entry).modelId) modelSpans.push([entry.start, entry.end]);
  for (const entry of composites.values())
    if (ruling(entry).modelId) modelSpans.push([entry.start, entry.end]);
  modelSpans.sort((a, b) => a[0] - b[0]);
  const coveringSpan = (start, end) => {
    let lo = 0;
    let hi = modelSpans.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (modelSpans[mid][0] <= start) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo - 1; i >= 0 && i > lo - 400; i--) {
      const [s, e] = modelSpans[i];
      if (s <= start && e >= end && e - s > end - start) return true;
    }
    return false;
  };
  const findings = [];
  const seen = new Map();
  let anchored = 0;
  let trivial = 0;
  let unearnedCallGroups = 0;
  // A call group spans every call of one callee in a module, so a model arm
  // proves the callee emits model text only when that text is model-facing
  // because of these calls: the literal is written in a call's argument, by
  // itself or in an array or `+` chain written there (not reached through a
  // variable that may have other uses), and every site carrying the same body
  // (for a composite, every occurrence of its joined text) sits inside one of
  // the group's calls (a telemetry copy in the next argument is fine).
  // Otherwise its verdict, keyed on content, may have been earned at the other
  // use (CC 2.1.296: `let s=\`…\`;t(s,{level:"warn"});return {message:s}`
  // logged tool results through the imported debug logger, whose group would
  // have raised 1,510 log lines).
  const earnedIn = (a, g) =>
    a.via === 'direct' &&
    (sitesByBody.get(a.body) || [{ start: a.start, end: a.end }]).every(e =>
      g.callSites.some(c => c.start <= e.start && e.end <= c.end)
    );
  const mixed = [];
  // Groups that would be mixed if a model arm written as a literal in a call's
  // argument counted even where its text has other uses. Not gated: the other
  // use may be where the verdict was earned. Arms reached through a variable
  // stay out, as they are the debug-logger noise the earned rule exists for.
  const unearnedMixed = [];
  const outside = (body, g) =>
    (sitesByBody.get(body) || [])
      .filter(e => !g.callSites.some(c => c.start <= e.start && e.end <= c.end))
      .map(e => e.start);
  for (const g of groups) {
    const arms = g.arms.flatMap(resolve);
    const flowGroup = FLOW_KINDS.has(g.kind);
    if (g.kind === 'calls') {
      const split = mixedRulings(arms, g.position, a => earnedIn(a, g));
      if (split) mixed.push({ at: g.at, ...split });
      else {
        const loose = mixedRulings(arms, g.position, a => a.via === 'direct');
        if (loose)
          unearnedMixed.push({
            at: g.at,
            callee: g.callee,
            ...loose,
            model: loose.model.map(a => ({
              ...a,
              elsewhere: [...new Set(outside(a.body, g))].sort((x, y) => x - y),
            })),
          });
      }
    }
    const anchorSites = arms.filter(
      a => a.modelId && (g.kind !== 'calls' || earnedIn(a, g))
    );
    const anchors =
      g.kind === 'respelling'
        ? hostsOf(g.needle)
        : anchorSites.map(a => a.modelId);
    if (!anchors.length) {
      if (g.kind === 'calls' && arms.some(a => a.modelId)) unearnedCallGroups++;
      continue;
    }
    anchored++;
    for (const a of arms) {
      if (a.modelId || a.verdict) continue;
      if (flowGroup && coveringSpan(a.start, a.end)) continue;
      const siteKey = `${a.start}:${a.end}`;
      if (
        !seen.has(siteKey) &&
        (ex.isBareToken(cook(a.body)) ||
          !(flowGroup
            ? /\p{L}/u.test(cook(a.body))
            : readsAsWords(a.text ?? a.body)))
      ) {
        trivial++;
        continue;
      }
      const relations = [...new Set(anchors)].map(anchor => ({
        kind: g.kind,
        anchor,
        anchorAt: anchorSites.find(s => s.modelId === anchor)?.start ?? g.at,
        start: g.at,
        end: g.end ?? g.at,
        site: { start: a.start, end: a.end },
        via: a.via ?? 'direct',
        anchors: [anchor],
      }));
      const previous = seen.get(siteKey);
      if (previous) {
        previous.anchors = [...new Set([...previous.anchors, ...anchors])];
        previous.siblingRelations.push(...relations);
        continue;
      }
      const finding = {
        start: a.start,
        end: a.end,
        kind: g.kind === 'returns' ? 'returns' : a.kind,
        key: a.key,
        body: a.body,
        group: g.kind,
        groupAt: g.at,
        anchors: [...new Set(anchors)],
        siblingRelations: relations,
      };
      seen.set(siteKey, finding);
      findings.push(finding);
    }
  }
  return {
    groups: groups.length,
    anchored,
    trivial,
    unearnedCallGroups,
    unparsed,
    findings,
    mixed,
    unearnedMixed,
  };
}

// One callee usually sends every argument at a position down the same route,
// so a call group whose arms are ruled both `model` and `ui`/`internal` holds a
// wrong verdict unless the call sites themselves route differently. On CC
// 2.1.296, 23 of 40 such groups held 51 wrong verdicts between them.
//
// An arm's facing is its cache verdict; catalogue membership stands in only
// where there is none, since a catalogued body ruled `internal` is not model
// text. A model arm counts only where its verdict is earned at these calls (the
// anchoring rule above): one earned at another use of the same text says
// nothing about this callee's other arms. Unlike an anchor it needs no
// catalogue id, so a body the extractor never catalogues still counts.
//
// The fingerprint names the group across releases, so it cannot use the
// callee's minified name or chunk, which change every build. It is the
// argument position plus the earned model-arm keys. Every site of an earned
// body lies inside this group's calls, so another group at that position can
// share a key only by nesting its calls inside these, and would have to share
// all of them. The callee's arity is left out: an imported callee has no
// visible declaration, and a parameter added to it would re-key every review.
// checkMixedCallVerdicts fails when two current groups share a fingerprint.
function mixedRulings(arms, position, isEarned) {
  const model = new Map();
  const other = new Map();
  for (const a of arms) {
    if (!a.key) continue;
    const facing = a.verdict?.facing || (a.modelId ? 'model' : null);
    if (facing === 'model') {
      if (isEarned(a)) model.set(a.key, a.body);
    } else if (facing) other.set(a.key, { facing, body: a.body });
  }
  if (!model.size || !other.size) return null;
  const modelKeys = [...model.keys()].sort();
  return {
    position,
    fingerprint: createHash('sha1')
      .update([position, ...modelKeys].join('\n'))
      .digest('hex')
      .slice(0, 16),
    model: modelKeys.map(key => ({ key, body: model.get(key) })),
    other: [...other].map(([key, r]) => ({ key, ...r })),
  };
}

let scannerSourceHash = null;
export function scannerVersion() {
  if (scannerSourceHash) return scannerSourceHash;
  const h = createHash('sha256');
  for (const dir of [HERE, path.join(HERE, 'lib')])
    for (const name of fs.readdirSync(dir).sort())
      if (/\.(?:[cm]?js|mts)$/.test(name) && !/\.test\.[cm]?[jt]s$/.test(name))
        h.update(`${path.relative(HERE, path.join(dir, name))}\0`).update(
          fs.readFileSync(path.join(dir, name))
        );
  for (const pkg of ['acorn', '@babel/parser'])
    h.update(`${pkg}@${require(`${pkg}/package.json`).version}\0`);
  scannerSourceHash = h.digest('hex');
  return scannerSourceHash;
}

export function scanKey(code, { catalogue, cache, version }) {
  return createHash('sha256')
    .update(scannerVersion())
    .update('\0')
    .update(createHash('sha256').update(code).digest('hex'))
    .update('\0')
    .update(String(version))
    .update('\0')
    .update(JSON.stringify(catalogue ?? null))
    .update('\0')
    .update(JSON.stringify(cache ?? null))
    .digest('hex');
}

export function scanSiblingArmsShared(
  cliPath,
  { catalogue, cache, version } = {},
  { dir = process.env.SHOWTIME_TMP } = {}
) {
  const code = fs.readFileSync(cliPath, 'utf8');
  const resolved = version || detectVersion(cliPath, code);
  const inputs = { catalogue, cache, version: resolved };
  if (!dir) return scanSiblingArms(cliPath, inputs);
  const key = scanKey(code, inputs);
  const file = path.join(dir, `sibling-scan-${key}.json`);
  let entry = null;
  try {
    entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    entry = null;
  }
  if (entry && entry.key === key && entry.result) return entry.result;
  const result = scanSiblingArms(cliPath, inputs);
  const text = JSON.stringify({ key, result });
  if (isDeepStrictEqual(JSON.parse(text).result, result)) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }
  return result;
}

// A provisional anchor proves nothing about a call group: one new string passed
// to the debug logger would make every other log line through that callee a
// sibling (CC 2.1.310: 2,760 of them). Flow groups keep their provisional
// anchors.
export function dropProvisionalCallAnchors(result, provisionalId) {
  result.findings = result.findings.filter(f => {
    f.siblingRelations = (f.siblingRelations || []).filter(
      r => !(r.kind === 'calls' && r.anchor === provisionalId)
    );
    f.anchors = [...new Set(f.siblingRelations.map(r => r.anchor))];
    return f.siblingRelations.length > 0;
  });
  return result;
}

export function appendSiblingCandidates(candidates, result) {
  const byHash = new Map(candidates.map(c => [c.hash, c]));
  let appended = 0;
  const appendUnique = (target, values) => {
    const seen = new Set(target.map(v => JSON.stringify(v)));
    for (const value of values) {
      const key = JSON.stringify(value);
      if (seen.has(key)) continue;
      seen.add(key);
      target.push(value);
    }
  };
  for (const f of result.findings) {
    let candidate = byHash.get(f.key);
    if (!candidate) {
      candidate = {
        hash: f.key,
        body: f.body,
        len: f.body.length,
        lead: '',
        hint: null,
        source: 'sibling-arm',
      };
      byHash.set(f.key, candidate);
      candidates.push(candidate);
      appended++;
    }
    candidate.sourceSites ??= [];
    candidate.siblingRelations ??= [];
    appendUnique(candidate.sourceSites, [{ start: f.start, end: f.end }]);
    appendUnique(
      candidate.siblingRelations,
      f.siblingRelations ||
        (f.anchors || []).map(anchor => ({
          kind: f.group,
          anchor,
          anchorAt: f.groupAt,
        }))
    );
  }
  return appended;
}

function parseArgs(argv) {
  const opt = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z]+)(?:=(.*))?$/);
    if (!m) opt.positional.push(argv[i]);
    else if (m[1] === 'json') opt.json = true;
    else if (m[1] === 'cache')
      opt.cache = m[2] !== undefined ? m[2] : argv[++i];
    else throw new Error(`unknown option --${m[1]}`);
  }
  if (opt.positional.length !== 2)
    throw new Error('need <cli.js> and <prompts.json>');
  return opt;
}

function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`checkSiblingArms: ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  const [cli, json] = opt.positional.map(p => path.resolve(p));
  for (const f of [cli, json]) {
    if (!fs.existsSync(f)) {
      console.error(`checkSiblingArms: no such file ${f}\n${USAGE}`);
      process.exit(2);
    }
  }
  const catalogue = JSON.parse(fs.readFileSync(json, 'utf8')).prompts || [];
  const cache = JSON.parse(
    fs.readFileSync(opt.cache ? path.resolve(opt.cache) : DEFAULT_CACHE, 'utf8')
  );
  const r = scanSiblingArmsShared(cli, { catalogue, cache });
  if (opt.json) console.log(JSON.stringify(r, null, 1));
  else
    for (const f of r.findings)
      console.log(
        `SIBLING ${f.start}-${f.end} ${f.kind} raw=${f.key} ${f.group}@${f.groupAt} beside ${f.anchors.join(',')} ${JSON.stringify(f.body.length > 120 ? f.body.slice(0, 120) + '…' : f.body)}`
      );
  const say = opt.json ? console.error : console.log;
  for (const u of r.unparsed)
    say(`UNPARSED segment ${u.name || '(bundle)'}@${u.start}: ${u.error}`);
  say(
    `sibling arms: ${r.findings.length} uncatalogued unclassified arm(s) in ${r.anchored} group(s) with a catalogued arm (${r.groups} switch/ternary groups scanned, ${r.trivial} non-prose arm(s) skipped, ${r.unearnedCallGroups} call group(s) with no model arm earned at their own calls skipped, ${r.unparsed.length} unparseable segment(s))`
  );
  process.exitCode = r.unparsed.length ? 2 : r.findings.length ? 1 : 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
