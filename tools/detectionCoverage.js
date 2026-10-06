/**
 * Detection-coverage gate — the REVERSE direction of the classify phase.
 *
 * `classify-candidates` asks "of the strings we CAPTURED, which are still
 * unnamed?" It cannot see a prompt the extractor never detected: zero captures
 * produce zero candidates, so the bar reads green while the prompt is invisible.
 * That is exactly how the Opus 5 anti-delegation pair, a live MCP tool
 * description and three chunks of the keybindings skill shipped uncaptured
 * through 2.1.218/219/220 (memory
 * `reference_extractor_blind_to_array_join_prompts`).
 *
 * Root cause: `extractStrings` gates each StringLiteral / TemplateLiteral node
 * IN ISOLATION. Prose assembled from several nodes — `["a","b"].join("\n")`, an
 * array joined elsewhere, a `"a" + "b"` chain — is never presented to the gate
 * as a unit. Each fragment is short, and its lead (`["`, `,"`, `+`) carries no
 * model-facing signal, so it falls under the floor.
 *
 * This tool walks the same AST, assembles multi-node composites, and reports any
 * whose text is absent from the prompts JSON. Verdicts are stored by content
 * hash in an allowlist so a reviewed-and-benign site stays quiet across versions
 * (same design as the classification cache: content-keyed, version-independent).
 *
 * Usage:
 *   node tools/detectionCoverage.js <cli.js> <prompts-X.Y.Z.json> [--update-allowlist]
 * Exit code 1 when unreviewed composites remain.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const parser = require('@babel/parser');
const {
  splitModuleBundle,
  parseModuleSegment,
} = require('./lib/moduleBundle.cjs');
const {
  classifyByCache,
  setCcVersionForCacheLookups,
} = require('./promptExtractor.js');

const ALLOWLIST = path.join(
  __dirname,
  '..',
  'data',
  'detection-coverage-allowlist.json'
);

const norm = s => s.replace(/\s+/g, ' ').trim();
const hash = s =>
  crypto.createHash('sha256').update(norm(s)).digest('hex').slice(0, 16);

// --------------------------------------------------------------------------
// Is the assembled text English prose a model could be reading?
// --------------------------------------------------------------------------

// Function words are what separates English sentences from identifier soup:
// keyword tables, DTD catalogues and contributor lists are full of real words
// but contain almost no grammar.
const FUNCTION_WORDS =
  /\b(the|a|an|to|of|is|are|was|be|you|your|and|or|not|for|with|that|this|it|in|on|when|if|but|from|as|by|do|does|can|will|should|must)\b/gi;

function looksLikeProse(text) {
  const s = norm(text);
  if (s.length < 60) return false;
  if (!/[a-z]/.test(s)) return false;
  const words = s.split(/\s+/);
  const wordy = words.filter(w => /^[A-Za-z][a-z]{2,}$/.test(w)).length;
  if (wordy < 8) return false;
  if (wordy / words.length < 0.35) return false;
  // Needs structure, not a bare token list — but test the RAW text: a composite
  // is often several lines with no terminal punctuation at all (the Opus 5 pair
  // is exactly that), and norm() has already collapsed the newlines that prove
  // it is structured.
  const structured =
    /\n/.test(text) || /[.:!?]\s|[.:!?]$/.test(s) || /^#{1,4}\s/.test(s);
  if (!structured) return false;
  // grammar check: distinct function words, scaled to length
  const distinct = new Set(
    (s.match(FUNCTION_WORDS) || []).map(w => w.toLowerCase())
  );
  if (distinct.size < 4) return false;
  // contributor / author blocks
  if ((s.match(/<[^@\s>]+@[^@\s>]+>/g) || []).length >= 3) return false;
  return true;
}

/**
 * Shapes that are definitively NOT sent to the model. Anchored on JS keywords,
 * JSON-schema keys and Anthropic-controlled names — never minified identifiers —
 * so they survive version bumps, matching the extractor's own drop-rule policy.
 */
function isDroppedByContext(text, lead) {
  const s = norm(text);
  const tail = norm(lead);
  // Exception sites (`throw …(`, `new XError(`, `super(`) are deliberately NOT
  // here. An error thrown inside a tool's call path is the tool_result the
  // model reads, so the extractor no longer drops them: it hands them to the
  // classifier, and this gate defers to that same verdict (see main).
  if (/\bconsole\.[$\w]+\(\s*$/.test(tail)) return true;
  if (/\bprocess\.(stdout|stderr)\.write\(\s*$/.test(tail)) return true;
  if (/\.(createElement|option|command)\(\s*$/.test(tail)) return true;
  if (/^#!/.test(s)) return true; // generated shell shims
  if (/^\s*[;(]\s*(allow|deny|version)\b/.test(s)) return true; // seatbelt sandbox profiles
  if (/2>\/dev\/null|\bunalias\b|\blocal -a\b/.test(s)) return true; // shell bodies
  if (/@(azure|aws-sdk|google-cloud)\//.test(s)) return true; // vendored SDK errors
  if (/\[(suggestion|success|warning):/.test(s)) return true; // TUI demo frames
  if (/^@internal\b/.test(s)) return true; // internal config-schema descriptions
  return false;
}

// A classification-cache verdict of ui/internal for the assembled text.
function isJudgedNotModelFacing(text) {
  const facing = classifyByCache(text)?.facing;
  return facing === 'ui' || facing === 'internal';
}

// --------------------------------------------------------------------------
// AST composite collection
// --------------------------------------------------------------------------

const literalValue = node => {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
};

// Leaf VALUES of a `"a" + "b" + "c"` chain, or null if any leaf is not literal.
const concatLeaves = node => {
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = concatLeaves(node.left);
    const right = concatLeaves(node.right);
    return left !== null && right !== null ? [...left, ...right] : null;
  }
  const v = literalValue(node);
  return v === null ? null : [v];
};

function collectComposites(code) {
  const parseOptions = {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  };
  const out = [];
  const seenStart = new Set();

  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);

    if (node.type === 'ArrayExpression') {
      const values = (node.elements || []).map(literalValue);
      if (values.length >= 2 && values.every(v => typeof v === 'string')) {
        out.push({
          shape: 'array',
          node,
          parts: values,
          text: values.join('\n'),
        });
      }
    }

    if (node.type === 'BinaryExpression' && node.operator === '+') {
      if (!seenStart.has(node.start)) {
        const leaves = concatLeaves(node);
        if (leaves !== null) {
          seenStart.add(node.start);
          // parts must be the LEAVES, not the joined text: coverage is judged
          // per fragment (the joined form is never stored), so a single-element
          // parts array of the joined string could never be satisfied.
          out.push({
            shape: 'concat',
            node,
            parts: leaves,
            text: leaves.join(''),
          });
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (
        key === 'loc' ||
        key === 'leadingComments' ||
        key === 'trailingComments'
      )
        continue;
      visit(node[key]);
    }
  };

  const segments = splitModuleBundle(code);
  if (segments) {
    for (const seg of segments) {
      const ast = parseModuleSegment(seg, parseOptions, 'detection-coverage');
      if (!ast) continue;
      visit(ast.program);
    }
  } else {
    const ast = parser.parse(code, parseOptions);
    visit(ast.program);
  }
  return out;
}

// --------------------------------------------------------------------------
// Capture test against the prompts JSON
// --------------------------------------------------------------------------

function buildCorpus(promptsJsonPath) {
  const data = JSON.parse(fs.readFileSync(promptsJsonPath, 'utf8'));
  const pieces = (data.prompts || []).flatMap(p => p.pieces || []).map(norm);
  return ' ' + pieces.join(' || ') + ' ';
}

/**
 * Captured when a long interpolation-free run of the assembled text appears in
 * the corpus. Probing several runs (not just the head) tolerates the extractor
 * splitting a prompt into pieces at interpolation boundaries.
 */
function isCaptured(corpus, text) {
  const s = norm(text);
  const runs = s
    .split(/\$\{[^}]*\}/)
    .map(x => x.trim())
    .filter(x => x.length >= 45);
  const probes = [];
  for (const run of (runs.length ? runs : [s]).slice(0, 8)) {
    // Sample WINDOWS across each run, not just its head: the extractor stores a
    // prompt split into pieces, and the stored piece often starts partway into
    // the text (an interpolation, or a differently-cut fragment), so a
    // head-only probe reports a captured prompt as missing.
    for (const frac of [0, 0.25, 0.5, 0.75]) {
      const at = Math.floor(run.length * frac);
      if (at + 45 <= run.length) probes.push(run.slice(at, at + 45));
    }
    probes.push(run.slice(0, 45));
  }
  return probes.some(p => corpus.includes(p));
}

// --------------------------------------------------------------------------

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST)) return {};
  return JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8'));
}

function main() {
  const [cliPath, jsonPath] = process.argv
    .slice(2)
    .filter(a => !a.startsWith('--'));
  const update = process.argv.includes('--update-allowlist');
  if (!cliPath || !jsonPath) {
    console.error(
      'Usage: node tools/detectionCoverage.js <cli.js> <prompts-X.Y.Z.json> [--update-allowlist]'
    );
    process.exit(2);
  }

  const code = fs.readFileSync(cliPath, 'utf8');
  const corpus = buildCorpus(jsonPath);
  const version = path.basename(jsonPath).match(/prompts-(.+)\.json$/)?.[1];
  setCcVersionForCacheLookups(version);
  const allowlist = loadAllowlist();

  const findings = [];
  const seenHash = new Set();

  for (const c of collectComposites(code)) {
    const lead = code.slice(Math.max(0, c.node.start - 120), c.node.start);
    if (!looksLikeProse(c.text)) continue;
    if (isDroppedByContext(c.text, lead)) continue;
    if (isCaptured(corpus, c.text)) continue;
    // The extractor hands every composite it cannot place to the classifier,
    // keyed by the same assembled text, and obeys the verdict. A ui/internal
    // verdict is a reviewed emission site, the same thing an allowlist row
    // records, so it stays silent here too.
    if (isJudgedNotModelFacing(c.text)) continue;
    // Coverage is judged per FRAGMENT, not on the joined text. The joined form
    // exists only at runtime, so the extractor never stores it — cataloguing it
    // would guarantee a "Could not find" at every apply, since no regex built
    // from it can match the bundle. A composite counts as covered once its
    // substantive fragments are each captured, which is what the extractor
    // actually emits.
    if (
      c.parts.length > 1 &&
      c.parts.every(p => norm(p).length < 45 || isCaptured(corpus, p))
    ) {
      continue;
    }
    const h = hash(c.text);
    if (seenHash.has(h)) continue;
    seenHash.add(h);
    findings.push({
      hash: h,
      shape: c.shape,
      start: c.node.start,
      text: norm(c.text),
      lead: norm(lead).slice(-90),
    });
  }

  // A ratchet, not a wall. Three tiers, because a gate that stays red over a
  // known backlog just teaches everyone to ignore it:
  //   ui | internal -> decided not model-facing; silent forever.
  //   REVIEW        -> known backlog; reported every run, does NOT fail.
  //   unknown hash  -> NEW assembled prose since the baseline; FAILS.
  // 'model' is the one verdict that keeps failing: someone read the emission
  // site, said the model sees it, and the extractor still cannot capture it.
  const verdictOf = h => allowlist[h]?.verdict;
  const isNew = f => !allowlist[f.hash];
  const silent = f => ['ui', 'internal'].includes(verdictOf(f.hash));

  const fresh = findings.filter(isNew);
  const backlog = findings.filter(f => verdictOf(f.hash) === 'REVIEW');
  const stillModel = findings.filter(f => verdictOf(f.hash) === 'model');
  const unreviewed = findings.filter(f => !silent(f));

  if (update) {
    const next = { ...allowlist };
    for (const f of findings) {
      if (!next[f.hash]) {
        next[f.hash] = {
          verdict: 'REVIEW',
          shape: f.shape,
          excerpt: f.text.slice(0, 140),
        };
      }
    }
    fs.writeFileSync(ALLOWLIST, JSON.stringify(next, null, 2) + '\n');
    console.log(
      `detection-coverage: allowlist written with ${Object.keys(next).length} entries`
    );
    console.log(
      'Set each "verdict" to model | ui | internal, then re-run without the flag.'
    );
    return;
  }

  console.log(
    `detection-coverage: ${findings.length} multi-node prose composites absent from ${path.basename(jsonPath)}` +
      ` (${fresh.length} new, ${backlog.length} known backlog, ${stillModel.length} model-facing-uncaptured)`
  );

  if (stillModel.length) {
    console.log(
      `detection-coverage: ${stillModel.length} composite(s) judged MODEL-FACING but still uncaptured` +
        ' — extractStrings must learn the shape:'
    );
    for (const f of stillModel)
      console.log(`    ${f.hash}  ${f.text.slice(0, 110)}`);
  }
  if (backlog.length) {
    console.log(
      `detection-coverage: ${backlog.length} in the review backlog (not blocking) —` +
        ' work these down during the bump, they are unjudged prose.'
    );
  }

  if (!fresh.length && !stillModel.length) {
    console.log(
      `detection-coverage: 0 new, 0 model-facing-uncaptured — PASS (${backlog.length} backlog)`
    );
    return;
  }

  for (const f of (fresh.length ? fresh : stillModel).sort(
    (a, b) => b.text.length - a.text.length
  )) {
    console.log(
      `\n  [${f.shape}] @${f.start}  ${f.text.length} ch  hash=${f.hash}`
    );
    console.log(`    lead: …${f.lead}`);
    console.log(
      `    text: ${f.text.slice(0, 200)}${f.text.length > 200 ? ' …' : ''}`
    );
  }
  const why = fresh.length
    ? `${fresh.length} NEW composite(s) since the baseline`
    : `${stillModel.length} composite(s) judged model-facing but still uncaptured`;
  console.log(
    `\ndetection-coverage: FAIL — ${why}.\n` +
      'Read each emission site in cli.js. Model-facing => teach extractStrings the shape\n' +
      '(assemble the composite before shouldCapture). UI/internal => record the verdict via\n' +
      '  node tools/detectionCoverage.js <cli.js> <json> --update-allowlist'
  );
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  collectComposites,
  looksLikeProse,
  isDroppedByContext,
  isJudgedNotModelFacing,
  isCaptured,
  buildCorpus,
};
