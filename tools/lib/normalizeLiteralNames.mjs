// Blank the minified names in a JS literal's source (a string, template or
// array expression) so two builds compare equal when only the names differ.
// Prose, string and template text, property names and numbers stay exact:
// only Identifier nodes in binding or reference position become `_`.
// Source that does not parse as an expression is returned unchanged.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseExpression } = require('@babel/parser');

const isNameOnly = (node, parent, key) =>
  (parent &&
    (parent.type === 'MemberExpression' ||
      parent.type === 'OptionalMemberExpression') &&
    key === 'property' &&
    !parent.computed) ||
  (parent &&
    (parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod') &&
    key === 'key' &&
    !parent.computed);

export function normalizeLiteralNames(source) {
  let ast;
  try {
    ast = parseExpression(source, { plugins: ['jsx'] });
  } catch {
    return source;
  }
  const ranges = [];
  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier' && !isNameOnly(node, parent, key))
      ranges.push([node.start, node.end]);
    for (const [k, v] of Object.entries(node)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments')
        continue;
      if (Array.isArray(v)) for (const c of v) visit(c, node, k);
      else if (v && typeof v === 'object') visit(v, node, k);
    }
  };
  visit(ast, null, null);
  ranges.sort((a, b) => b[0] - a[0]);
  let out = source;
  for (const [s, e] of ranges) out = out.slice(0, s) + '_' + out.slice(e);
  return out;
}
