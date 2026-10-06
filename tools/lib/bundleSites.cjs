// The bundle-only half of the prompt extractor: every string, template and
// multi-node composite literal in cli.js, with the facts the capture decision
// reads from the AST, in traversal order.
//
// Nothing here may depend on the classification cache, the allowlists, the
// seed or upstream JSON, or the curated tables in promptExtractor.js. That is
// what makes the product a pure function of the bundle and this code, so it can
// be cached on disk and replayed by a later run on the same bundle. Offsets are
// absolute into the bundle; text the decision needs around a site (its lead,
// its raw source) is re-sliced from the bundle at replay time.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const v8 = require('v8');
const parser = require('@babel/parser');
const { splitModuleBundle, parseModuleSegment } = require('./moduleBundle.cjs');
const { buildSettingsIndex } = require('./settingsSchema.cjs');

// Bump when the shape of a cached product changes without a source change in
// the files hashed below (never needed in practice: they are hashed whole).
const SITES_FORMAT = 1;

const PARSE_OPTIONS = { sourceType: 'module', plugins: ['jsx', 'typescript'] };

// Decode JS unicode/hex escape sequences in template-literal raw source.
// Surgical: only handles \uHHHH, \u{X+}, \xHH. Preserves `\\` so literal
// `\\uHHHH` source (= backslash + u + four hex chars at runtime) isn't
// accidentally interpreted as an escape. Other escapes (\n, \t, \", \`)
// are kept raw to match the storage format Piebald's published JSONs use.
function decodeUnicodeEscapesInPiece(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      // Double-backslash: copy both literally so the next char isn't read as an escape.
      if (s[i + 1] === '\\') {
        out += '\\\\';
        i += 2;
        continue;
      }
      if (s[i + 1] === 'u') {
        if (s[i + 2] === '{') {
          const close = s.indexOf('}', i + 3);
          if (close > -1) {
            const hex = s.substring(i + 3, close);
            if (/^[0-9a-fA-F]+$/.test(hex)) {
              out += String.fromCodePoint(parseInt(hex, 16));
              i = close + 1;
              continue;
            }
          }
        } else if (i + 6 <= s.length) {
          const hex = s.substring(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
        }
      }
      if (s[i + 1] === 'x' && i + 4 <= s.length) {
        const hex = s.substring(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          continue;
        }
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Multi-node composites
//
// A prompt can be ONE string semantically but N nodes syntactically:
//   ttp = ["Do not call the AgentTool…","Do not use workflows…"].join("\n")
//   .describe("Invokes an MCP tool " + "via the subprocess MCP client.")
// Gating each node alone can never see it — every fragment is short and its
// lead (`["`, `,"`, `+`) carries no model-facing signal, so it falls under the
// floor and is not even offered to the classification phase. That is how the
// Opus 5 anti-delegation pair and chunks of the bundled keybindings skill
// stayed uncaptured through 2.1.218/219/220.
//
// The assembled text is EVIDENCE ONLY, never a stored prompt: the joined form
// exists at runtime, not in cli.js, so a regex built from it could never match
// and every apply would report "Could not find" (the same reasoning
// isHardExcluded already applies to unspliceable model-facing text). Each
// FRAGMENT is a real literal, so the fragments are what get captured.
// ---------------------------------------------------------------------------

const literalOf = node => {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
};

// Leaf NODES of a `"a" + "b" + "c"` chain, or null if any leaf is not a literal.
const concatLeafNodes = node => {
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = concatLeafNodes(node.left);
    const r = concatLeafNodes(node.right);
    return l !== null && r !== null ? [...l, ...r] : null;
  }
  return literalOf(node) === null ? null : [node];
};

// { text, nodes } for a composite node, else null.
function assembleComposite(node) {
  const fromArray = (elements, sep) => {
    const nodes = elements || [];
    const parts = nodes.map(literalOf);
    if (parts.length < 2 || !parts.every(p => typeof p === 'string'))
      return null;
    return { text: parts.join(sep), nodes };
  };

  // `[...].join(sep)` — the separator is known, so the text is exact.
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.property?.name === 'join' &&
    node.callee.object?.type === 'ArrayExpression'
  ) {
    const sepArg = node.arguments.length ? literalOf(node.arguments[0]) : ',';
    return fromArray(
      node.callee.object.elements,
      typeof sepArg === 'string' ? sepArg : ','
    );
  }

  // A bare array of string literals. The separator is unknown (joined
  // elsewhere, or spread into a builder), so assume a newline — every observed
  // case in cli.js is line-oriented markdown or instruction text.
  if (node.type === 'ArrayExpression') return fromArray(node.elements, '\n');

  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const nodes = concatLeafNodes(node);
    if (nodes === null || nodes.length < 2) return null;
    const parts = nodes.map(literalOf);
    if (!parts.every(p => typeof p === 'string')) return null;
    return { text: parts.join(''), nodes };
  }

  return null;
}

// A template literal's pieces, split around each top-level identifier inside
// its interpolations, and the label-encoded identifier order (0,1,1,2 = first
// var, second var, second var again, third).
function templateShape(node, code) {
  const { expressions } = node;
  const contentStart = node.start + 1;
  const fullContent = code.substring(contentStart, node.end - 1);

  const allIdentifiers = [];
  const traverseExpr = (exprNode, isTopLevel = true) => {
    if (!exprNode || typeof exprNode !== 'object') return;

    if (exprNode.type === 'Identifier' && isTopLevel) {
      allIdentifiers.push({
        name: exprNode.name,
        start: exprNode.start - contentStart,
        end: exprNode.end - contentStart,
      });
    }

    if (exprNode.type === 'CallExpression') {
      traverseExpr(exprNode.callee, true);
      if (exprNode.arguments) {
        exprNode.arguments.forEach(arg => traverseExpr(arg, true));
      }
      return;
    }

    if (exprNode.type === 'MemberExpression') {
      traverseExpr(exprNode.object, true);
      return;
    }

    if (exprNode.type === 'TemplateLiteral') {
      if (exprNode.expressions) {
        exprNode.expressions.forEach(nestedExpr =>
          traverseExpr(nestedExpr, true)
        );
      }
      return;
    }

    if (exprNode.type === 'ObjectExpression') {
      if (exprNode.properties) {
        exprNode.properties.forEach(prop => {
          if (prop.value) {
            traverseExpr(prop.value, false);
          }
        });
      }
      return;
    }

    for (const key in exprNode) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      const value = exprNode[key];
      if (Array.isArray(value)) {
        value.forEach(v => traverseExpr(v, true));
      } else if (value && typeof value === 'object') {
        traverseExpr(value, true);
      }
    }
  };
  for (const expr of expressions) traverseExpr(expr, true);

  allIdentifiers.sort((a, b) => a.start - b.start);

  const pieces = [];
  const identifierList = [];
  let lastPos = 0;
  for (const id of allIdentifiers) {
    pieces.push(fullContent.substring(lastPos, id.start));
    identifierList.push(id.name);
    lastPos = id.end;
  }
  pieces.push(fullContent.substring(lastPos));

  // Template-literal raw source stores `—` as 6 literal chars; the cooked
  // runtime value is the em-dash. Decoding keeps pieces[] byte-aligned with the
  // pristine prompt content, the format Piebald's pipeline produces, so merge
  // name-carryover works across versions.
  for (let pi = 0; pi < pieces.length; pi++) {
    pieces[pi] = decodeUnicodeEscapesInPiece(pieces[pi]);
  }

  const varToLabel = new Map();
  for (const name of identifierList) {
    if (!varToLabel.has(name)) varToLabel.set(name, varToLabel.size);
  }
  return {
    pieces,
    identifiers: identifierList.map(name => varToLabel.get(name)),
    labels: varToLabel.size,
  };
}

// One site record per literal-bearing node, in the order the extractor's
// traversal reaches them:
//   { kind: 'composite', start, end, text, fragments: [{ start, end, value }] }
//   { kind: 'string', start, end, value }
//   { kind: 'template', start, end, pieces, identifiers, labels, quasis,
//     expressions: [start, end, start, end, …] }
// `quasis` holds each quasi's cooked value (raw when cooking failed), which is
// what the slot-literal lookup hashes; `expressions` holds each interpolation's
// source range, which the identical-site backfill compares across sites.
function collectNodeSites(ast, code, sites) {
  const visit = node => {
    if (!node || typeof node !== 'object') return;

    const composite = assembleComposite(node);
    if (composite !== null) {
      sites.push({
        kind: 'composite',
        start: node.start,
        end: node.end,
        text: composite.text,
        fragments: composite.nodes.map(n => ({
          start: n.start,
          end: n.end,
          value: literalOf(n),
        })),
      });
    }

    if (node.type === 'StringLiteral') {
      sites.push({
        kind: 'string',
        start: node.start,
        end: node.end,
        value: node.value,
      });
    }

    if (node.type === 'TemplateLiteral') {
      const shape = templateShape(node, code);
      const expressions = [];
      for (const e of node.expressions) expressions.push(e.start, e.end);
      sites.push({
        kind: 'template',
        start: node.start,
        end: node.end,
        pieces: shape.pieces,
        identifiers: shape.identifiers,
        labels: shape.labels,
        quasis: (node.quasis || []).map(q => q.value.cooked ?? q.value.raw),
        expressions,
      });
    }

    for (const key in node) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === 'object') {
        visit(value);
      }
    }
  };
  visit(ast);
}

// Parse every module once and collect its sites. `settings` is the
// settings-schema description index (start offset -> entry), which is also a
// pure function of the bundle.
function collectBundleSites(code) {
  const settings = [...buildSettingsIndex(code).entries()];
  const sites = [];
  const segments = splitModuleBundle(code);
  if (!segments) {
    collectNodeSites(parser.parse(code, PARSE_OPTIONS), code, sites);
    return { settings, sites, modules: null };
  }
  let parsed = 0;
  for (const seg of segments) {
    const ast = parseModuleSegment(seg);
    if (!ast) continue;
    parsed++;
    collectNodeSites(ast, code, sites);
  }
  return {
    settings,
    sites,
    modules: { parsed, total: segments.length },
  };
}

// ---------------------------------------------------------------------------
// On-disk cache
//
// A version bump re-runs the extractor several times on one unchanged bundle
// while the classification cache, allowlists, curated tables and seed change
// between runs. Those inputs are all consumed AFTER this stage, so the product
// above is keyed only on what it is computed from: the bundle bytes, the source
// of the files that compute it, the parser version, and the parse options.
// ---------------------------------------------------------------------------

const SOURCE_FILES = [
  __filename,
  path.join(__dirname, 'moduleBundle.cjs'),
  path.join(__dirname, 'settingsSchema.cjs'),
];

function parserVersion() {
  try {
    return require('@babel/parser/package.json').version;
  } catch {
    return 'unknown';
  }
}

function sourceHash(files = SOURCE_FILES) {
  const h = crypto.createHash('sha256');
  for (const file of files) {
    h.update(path.basename(file));
    h.update('\0');
    h.update(fs.readFileSync(file));
    h.update('\0');
  }
  return h.digest('hex');
}

function defaultOptions() {
  return {
    format: SITES_FORMAT,
    parser: parserVersion(),
    parse: PARSE_OPTIONS,
    // v8.serialize output is only guaranteed readable by the same engine.
    v8: process.versions.v8,
  };
}

function bundleCacheKey({ code, source = sourceHash(), options }) {
  const h = crypto.createHash('sha256');
  h.update(crypto.createHash('sha256').update(code).digest('hex'));
  h.update('\0');
  h.update(source);
  h.update('\0');
  h.update(JSON.stringify(options || defaultOptions()));
  return h.digest('hex');
}

function cacheDir() {
  return (
    process.env.TWEAKCC_EXTRACT_CACHE_DIR ||
    path.join(os.tmpdir(), 'tweakcc-extract-cache')
  );
}

function cacheDisabled() {
  const v = process.env.TWEAKCC_EXTRACT_NO_CACHE;
  return Boolean(v) && v !== '0';
}

function readCache(file) {
  try {
    return v8.deserialize(fs.readFileSync(file));
  } catch {
    return null;
  }
}

// Write to a temp name and rename, so a concurrent or interrupted run never
// leaves a truncated entry behind under the real key.
function writeCache(file, product) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, v8.serialize(product));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.warn(`extractStrings: could not write site cache: ${err.message}`);
    return false;
  }
}

// The bundle's sites, from the cache when an entry for this exact key exists.
// `useCache: false` (or TWEAKCC_EXTRACT_NO_CACHE=1) always collects cold and
// leaves the cache untouched.
function loadBundleSites(code, { useCache = true } = {}) {
  if (!useCache || cacheDisabled()) {
    const product = collectBundleSites(code);
    return { ...product, cache: 'off' };
  }
  const key = bundleCacheKey({ code });
  const file = path.join(cacheDir(), `sites-${key}.v8`);
  const hit = readCache(file);
  if (hit && hit.key === key) return { ...hit, cache: 'hit', file };
  const product = collectBundleSites(code);
  writeCache(file, { key, ...product });
  return { ...product, cache: 'miss', file };
}

module.exports = {
  SITES_FORMAT,
  SOURCE_FILES,
  PARSE_OPTIONS,
  decodeUnicodeEscapesInPiece,
  literalOf,
  assembleComposite,
  templateShape,
  collectBundleSites,
  sourceHash,
  defaultOptions,
  bundleCacheKey,
  cacheDir,
  loadBundleSites,
};
