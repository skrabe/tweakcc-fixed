const parser = require('@babel/parser');

const MODULE_SENTINEL_RE = /\n\/\*@@TWEAKCC_MODULE:(\d+):([^@]*)@@\*\/\n/g;

/**
 * Shift every `start`/`end` in a freshly-parsed AST by `delta`.
 *
 * CC 2.1.246 code-split the bundle, so the extractor is now handed a VIRTUAL
 * bundle: every JS module concatenated behind a sentinel comment. Babel cannot
 * parse that as one program (1,400 ESM modules redeclare each other's
 * top-level names), so each module is parsed on its own and its node positions
 * are rebased onto the bundle. Everything downstream — lead-context slicing,
 * subset filtering, offset reporting — then behaves exactly as it did when the
 * bundle really was one file.
 */
function shiftAstPositions(node, delta, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) shiftAstPositions(child, delta, seen);
    return;
  }
  if (typeof node.start === 'number') node.start += delta;
  if (typeof node.end === 'number') node.end += delta;
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const child = node[key];
    if (child && typeof child === 'object') {
      shiftAstPositions(child, delta, seen);
    }
  }
}

/**
 * Split a virtual bundle into `{ name, start, source }` segments.
 * Returns null when the file is a single pre-2.1.246 bundle.
 */
function splitModuleBundle(code) {
  MODULE_SENTINEL_RE.lastIndex = 0;
  const marks = [...code.matchAll(MODULE_SENTINEL_RE)];
  if (marks.length === 0) return null;
  const segments = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : code.length;
    segments.push({ name: marks[i][2], start, source: code.slice(start, end) });
  }
  return segments;
}

function parseModuleSegment(seg, parseOptions, skipLabel, warn) {
  try {
    const ast = parser.parse(
      seg.source,
      parseOptions || {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'],
      }
    );
    shiftAstPositions(ast, seg.start);
    return ast;
  } catch (err) {
    // A handful of vendored minified libraries (mermaid, hljs) are not valid
    // ESM on their own. Skipping them loses nothing — they carry no prompts —
    // but a silent skip would look like coverage, so say which and why.
    (warn || console.warn)(
      `${skipLabel || 'extractStrings'}: skipping unparseable module ${seg.name}: ${err.message.split('\n')[0]}`
    );
    return null;
  }
}

module.exports = {
  MODULE_SENTINEL_RE,
  shiftAstPositions,
  splitModuleBundle,
  parseModuleSegment,
};
