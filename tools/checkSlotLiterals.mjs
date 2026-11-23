/**
 * Slot-literal gate — model-facing prose hiding inside a catalogued prompt's
 * substitution slots.
 *
 * A catalogued prompt stores its `pieces` (the literal text around each
 * substitution) and an `identifierMap` naming each slot. Nothing checks what a
 * slot's EXPRESSION evaluates to. When that expression is a conditional whose
 * branches are literal prose, the prose renders into a prompt the model reads,
 * yet it has no id of its own — so no override can reach it and no audit ever
 * sees it.
 *
 * Found on 2.1.233 in `system-reminder-team-coordination`:
 *
 *   let r = e.hasTaskListTools ?? Eee(),
 *       n = r ? `\n- Task list: ${e.taskListPath}` : "",
 *       o = r ? " Check the task list periodically. Create new tasks when work
 *               should be divided. Mark tasks resolved when complete." : "";
 *
 * Slot 2 (`o`) WAS catalogued, as `system-reminder-team-coordination-task-list-
 * upkeep`. Slot 1 (`n`) was not: the extractor gates each string node in
 * isolation and "\n- Task list: " is three words, far under any prose bar. The
 * sibling pair is the tell — two branches of one feature flag, one catalogued
 * and one invisible.
 *
 * This covers the same blind spot as `detectionCoverage`, from the other end.
 * detectionCoverage assembles prose that is never presented to the gate as a
 * unit; this walks the slots of a prompt already known to be model-facing, so
 * facing is not in question. The emission site is a catalogued prompt by
 * construction, and anything a slot can render is text the model receives.
 *
 * Resolution is deliberately shallow. A slot expression is inspected directly,
 * and a bare identifier is resolved once against declarators in the enclosing
 * function. Deeper dataflow would trade findings for false positives; a slot
 * whose value comes from further away yields nothing rather than a guess.
 *
 * It still produces some. When a declarator's init is a CALL —
 * `let o = await iNl(e, "claude attach <id>", "Open the background session…")`
 * — the slot holds the call's RETURN value, but every literal in the init is
 * collected, so the arguments come along. Three verdicts exist for that reason:
 *
 *   catalogue    carries an instruction; mint an id (see the warning below)
 *   glue         reaches the model but only labels an interpolated value
 *   not-a-slot   a resolution artifact — this text is not in the slot at all
 *
 * `not-a-slot` is not a judgement about the text. It records that the finding
 * was chased to its emission site and is a limitation of the resolver, so the
 * next reader does not re-derive it.
 *
 * Verdicts are stored by content hash in an allowlist, so a reviewed-and-benign
 * slot stays quiet across versions (same design as the detection-coverage
 * allowlist and the classification cache: content-keyed, version-independent).
 *
 * ⚠ `data/slot-literal-allowlist.json` is LOAD-BEARING, not just a silencer.
 * `tools/promptExtractor.js` reads every `catalogue` entry twice: once to
 * bypass the prose gate so the literal is captured at all, and once to give the
 * capture its `id`/`name`/`desc`. **Never prune an entry merely because this
 * tool stopped reporting it** — a `catalogue` entry stops being reported the
 * moment it succeeds, because the literal is then in the catalogue and the
 * already-catalogued check suppresses it. Deleting it would un-name the prompt
 * on the next extraction and orphan every override bound to that id. Prune only
 * a `glue` entry whose literal is genuinely gone from the binary.
 *
 * Usage:
 *   node tools/checkSlotLiterals.mjs <cli.js> <prompts-X.Y.Z.json> [--update-allowlist]
 * Exit code 1 when unreviewed slot literals remain.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { walk, resolveIdentifier } from './lib/slotScope.mjs';

const require = createRequire(import.meta.url);
const parser = require('@babel/parser');
const ex = require('./promptExtractor.js');
const {
  EARLIER_SHAPES,
  decodeUnicodeEscapesInPiece,
  splitAroundIdentifiers,
  templateIdentifierNodes,
} = require('./lib/bundleSites.cjs');
const {
  splitModuleBundle,
  parseModuleSegment,
} = require('./lib/moduleBundle.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWLIST = path.join(
  __dirname,
  '..',
  'data',
  'slot-literal-allowlist.json'
);

const SPACE = String.fromCharCode(32);
const norm = s => s.replace(/\s+/g, SPACE).trim();
const hash = s =>
  crypto.createHash('sha256').update(norm(s)).digest('hex').slice(0, 16);

/**
 * Is this slot literal worth a human verdict?
 *
 * The bar sits below the extractor's prose gate on purpose: facing is already
 * settled by the enclosing prompt, so the only question is whether the text
 * carries meaning a reader could act on. A separator, a punctuation join, or a
 * lone identifier does not.
 */
export function isCandidateText(text) {
  const s = norm(text);
  if (s.length < 10) return false;
  if (!/[a-z]/.test(s)) return false;
  // At least two real words: "\n- Task list: " qualifies, ", " does not. Strip
  // surrounding punctuation first — the founding case ends in a colon, and a
  // word test that counts "list:" as a non-word rejects it.
  const words = s
    .split(/\s+/)
    .map(w => w.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z]+$/, ''))
    .filter(w => /^[A-Za-z][A-Za-z'-]*$/.test(w));
  if (words.length < 2) return false;
  // Pure markup or format scaffolding with no prose payload.
  if (/^[\s\p{P}\p{S}]+$/u.test(s)) return false;
  return true;
}

/**
 * Every string-bearing node in a subtree, as {text, raw, start}.
 *
 * Both forms are needed. `text` is the cooked value — what the model actually
 * receives, and what the allowlist hashes. `raw` is the source text, which is
 * the form a catalogued prompt's `pieces` store, so the "is this already
 * catalogued?" test has to compare against it. Testing only the cooked form
 * reported five already-catalogued prompts as uncatalogued findings, every one
 * of them a string containing an escape: `\\` in the JSON-retry hint, an
 * escaped backtick in the MCP remote-auth suffix.
 */
function collectLiterals(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) collectLiterals(n, acc);
    return acc;
  }
  if (node.type === 'StringLiteral') {
    acc.push({
      text: node.value,
      raw:
        node.extra && node.extra.raw ? node.extra.raw.slice(1, -1) : node.value,
      start: node.start,
    });
  } else if (node.type === 'TemplateLiteral') {
    for (const q of node.quasis) {
      acc.push({
        text: q.value.cooked ?? q.value.raw,
        raw: q.value.raw,
        start: q.start,
      });
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments') continue;
    const v = node[key];
    if (v && typeof v === 'object') collectLiterals(v, acc);
  }
  return acc;
}

const decodeUnicodeEscapes = s =>
  s
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_m, h) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) =>
      String.fromCharCode(parseInt(h, 16))
    );

/**
 * The shapes a catalogued `pieces` entry can be compared against: cooked, raw,
 * fully \u-decoded, and the extractor's own piece form, which decodes printable
 * escapes but keeps control and line-terminator escapes raw. A literal holding
 * one of each matches only the last.
 */
export const literalForms = lit => [
  lit.text,
  lit.raw,
  decodeUnicodeEscapes(lit.raw),
  decodeUnicodeEscapesInPiece(lit.raw),
];

// The extractor's own decompositions of a template, current shape first, then
// the shapes earlier extractors cut it into (a catalogue may hold either), each
// with the source offset of every slot identifier.
const shapesOf = (node, source) => {
  const contentStart = node.start + 1;
  const content = source.substring(contentStart, node.end - 1);
  const seen = new Set();
  const out = [];
  for (const kind of ['current', ...EARLIER_SHAPES]) {
    const ids = templateIdentifierNodes(node, { shape: kind }).map(
      ({ node: n }) => ({
        name: n.name,
        start: n.start - contentStart,
        end: n.end - contentStart,
      })
    );
    const key = ids.map(id => id.start).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      pieces: splitAroundIdentifiers(content, ids).pieces,
      starts: ids.map(id => id.start + contentStart),
    });
  }
  return out;
};

const piecesKey = pieces => pieces.join('\u0000');

// Tests a template's pieces against one prompt's. Version and build-time
// placeholders stand for the text the extractor normalised away.
function piecesMatcher(pieces, version) {
  const key = piecesKey(pieces);
  if (!/<<(?:CCVERSION|BUILD_TIME)>>/.test(key)) return k => k === key;
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = key
    .split(/(<<CCVERSION>>|<<BUILD_TIME>>)/)
    .map(part => {
      if (part === '<<CCVERSION>>' && version) return esc(version);
      if (part === '<<CCVERSION>>' || part === '<<BUILD_TIME>>')
        return '[^\\u0000]+?';
      return esc(part);
    })
    .join('');
  const re = new RegExp('^' + body + '$');
  return k => re.test(k);
}

export function findSlotLiterals(source, catalogue) {
  // A template is a prompt's site only when the extractor's decomposition of it
  // reproduces the prompt's `pieces`. Pieces split on the IDENTIFIER inside a
  // substitution, not on the substitution, so they can never be compared with
  // quasis directly; and matching on the leading text alone attributed every
  // `Warning: ${…}` template in the bundle to the one prompt starting so.
  // Index on the first piece, then confirm on the whole shape.
  const byLead = new Map();
  for (const p of catalogue.prompts) {
    if (!p.pieces || p.pieces.length < 2) continue;
    const lead = p.pieces[0];
    if (!byLead.has(lead)) byLead.set(lead, []);
    byLead
      .get(lead)
      .push({ prompt: p, matches: piecesMatcher(p.pieces, catalogue.version) });
  }
  const placeheld = [...byLead.values()]
    .flat()
    .filter(c => /<<(?:CCVERSION|BUILD_TIME)>>/.test(c.prompt.pieces[0]));
  const matchPrompt = node => {
    for (const shape of shapesOf(node, source)) {
      const key = piecesKey(shape.pieces);
      const cands = [...(byLead.get(shape.pieces[0]) || []), ...placeheld];
      const hit = cands.find(c => c.matches(key));
      if (hit) return { prompt: hit.prompt, shape };
    }
    return null;
  };

  // A slot's label lives at identifierMap[identifiers[occurrence]], where the
  // occurrence is the identifier's position among the template's slot
  // identifiers — not the substitution's index, which differs as soon as one
  // substitution holds two identifiers. Reading identifierMap by the raw index
  // is the mis-binding bug `auditMisbinds` exists to catch.
  const labelFor = (p, occurrence) => {
    if (!p.identifierMap || occurrence < 0) return null;
    const idx = Array.isArray(p.identifiers)
      ? p.identifiers[occurrence]
      : occurrence;
    if (idx === undefined) return null;
    return p.identifierMap[String(idx)] ?? null;
  };

  const catalogued = new Set();
  for (const p of catalogue.prompts) {
    for (const piece of p.pieces || []) catalogued.add(norm(piece));
  }
  const cataloguedBlob = catalogue.prompts
    .flatMap(p => p.pieces || [])
    .join('\n');

  const parseOptions = {
    sourceType: 'unambiguous',
    errorRecovery: true,
  };

  const findings = [];
  const visitProgram = program => {
    walk(program, [], (node, fnStack) => {
      if (node.type !== 'TemplateLiteral' || !node.expressions.length) return;
      const matched = matchPrompt(node);
      if (!matched) return;
      const { prompt, shape } = matched;
      // The slot identifier a substitution is labelled by: itself when it is a
      // bare identifier, else the first slot identifier inside it.
      const occurrenceOf = expr =>
        shape.starts.findIndex(at => at >= expr.start && at < expr.end);

      node.expressions.forEach((expr, slot) => {
        let subtrees;
        let resolvedVia;
        if (expr.type === 'Identifier') {
          const decls = resolveIdentifier(expr.name, fnStack, expr.start);
          if (!decls) return;
          subtrees = decls;
          resolvedVia = 'identifier ' + expr.name;
        } else {
          subtrees = [expr];
          resolvedVia = 'inline';
        }
        for (const sub of subtrees) {
          for (const lit of collectLiterals(sub)) {
            if (!isCandidateText(lit.text)) continue;
            // Already catalogued in any of its forms. `pieces` are not raw and
            // not cooked but a MIX: raw source with unicode escapes decoded
            // (decodeUnicodeEscapesInPiece in the extractor). A string carrying
            // both an escaped backtick and a `—` em dash therefore matches
            // neither pure form — the cooked one differs at the backtick, the raw
            // one at the dash — which is how the MCP remote-auth suffix and the
            // SendMessage cross-session guidance read as uncatalogued.
            const forms = literalForms(lit);
            if (forms.some(f => catalogued.has(norm(f)))) continue;
            if (forms.some(f => cataloguedBlob.includes(f.trim()))) continue;
            findings.push({
              promptId: prompt.id,
              slot,
              label: labelFor(prompt, occurrenceOf(expr)),
              resolvedVia,
              offset: lit.start,
              hash: hash(lit.text),
              // `text` is a display preview; `fullText` (cooked) and `raw` are
              // what any comparison against other bodies must use.
              text:
                lit.text.length > 300
                  ? lit.text.slice(0, 300) + '...'
                  : lit.text,
              fullText: lit.text,
              raw: lit.raw,
            });
          }
        }
      });
    });
  };

  const segments = splitModuleBundle(source);
  if (segments) {
    for (const seg of segments) {
      const ast = parseModuleSegment(seg, parseOptions, 'slot-literals');
      if (!ast) continue;
      visitProgram(ast.program);
    }
  } else {
    visitProgram(parser.parse(source, parseOptions).program);
  }

  // One finding per (prompt, hash): a prompt emitted from several sites would
  // otherwise report the same slot repeatedly.
  const seen = new Set();
  return findings.filter(f => {
    const k = f.promptId + '|' + f.hash;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function loadAllowlist() {
  try {
    return JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8'));
  } catch {
    return {};
  }
}

// `off-route` and `not-a-slot` are rulings on one emission site, not on the
// text, yet rows are keyed by content. A literal ruled off-route at one host is
// not reviewed at another host that does reach the model, so those verdicts
// cover only the host(s) they name. `catalogue` and `glue` are about the text
// and cover every host.
export const SITE_VERDICTS = new Set(['off-route', 'not-a-slot']);
export const rowHosts = row =>
  [row.promptId, ...(Array.isArray(row.promptIds) ? row.promptIds : [])].filter(
    Boolean
  );
export function rowCovers(row, finding) {
  if (!row?.verdict) return false;
  if (!SITE_VERDICTS.has(row.verdict)) return true;
  return rowHosts(row).includes(finding.promptId);
}
export const isReviewed = (allowlist, finding) =>
  Boolean(allowlist[finding.hash]) &&
  rowCovers(allowlist[finding.hash], finding);

// The cooked value of raw template/string source: what a StringLiteral site
// hashes, where a template site hashes the raw piece.
const cook = s =>
  s.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g,
    (_m, c) => {
      if (c[0] === 'u' && c.length > 1)
        return String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ''), 16));
      if (c[0] === 'x' && c.length === 3)
        return String.fromCharCode(parseInt(c.slice(1), 16));
      const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
      if (c in simple) return simple[c];
      if (c === '0') return '\0';
      if (c === '\n' || c === '\r\n' || c === '\r') return '';
      return c;
    }
  );

// The verdict the extractor binds a body to: the FIRST hit in classifyByCache's
// order (each body's cacheLookupForms, the current body before its legacy
// ones). Comparing every alias instead let one `model` alias hide the `ui`
// verdict the extractor actually reads. `mixed` flags a body whose aliases
// disagree on model vs dropped: whichever binds, one ruling is wrong.
function boundVerdict(cache, bodies) {
  let first = null;
  const facings = new Set();
  for (const b of bodies)
    for (const form of ex.cacheLookupForms(b)) {
      const hit = cache[ex.sha1Hex(form)];
      if (!hit) continue;
      first ??= hit;
      facings.add(hit.facing === 'model' ? 'model' : 'dropped');
    }
  return { first, mixed: facings.size > 1 };
}

// A `catalogue` verdict here lands the literal no matter what the
// classification cache says, and both stores are keyed on content, so a literal
// ruled `ui` or `internal` in the cache while catalogued here is two
// contradicting verdicts, one of them wrong. On CC 2.1.296 nine had drifted
// apart, and the catalogue silently followed this file.
//
// Hosts are found by CONTENT, the way the extractor finds them
// (applySlotLiteralNames): every catalogued entry whose pieces probe to a
// `catalogue` row through slotLiteralCandidates. Looking hosts up by the row's
// id missed every `-N` sibling disambiguateIdCollisions minted, every carried-
// over id the naming pass skipped, and every row without an id. The literal
// itself is checked too: a template host's body is not the literal, and a ruling
// keyed on the literal alone never reached a host lookup.
//
// Kinds: `host` (a catalogued body the cache drops), `literal` (the literal's
// own text the cache drops), `alias` (a body whose cache aliases disagree).
export function verdictConflicts(allowlist, catalogue, cache) {
  const rows = new Map();
  for (const [h, row] of Object.entries(allowlist))
    if (row?.verdict === 'catalogue') rows.set(h, row);
  if (!rows.size) return [];
  ex.setCcVersionForCacheLookups(catalogue.version || null);
  // The capture-time body is the raw binary text, so its version-stamped form
  // goes first, as it does when the extractor meets it.
  const raw = body =>
    catalogue.version
      ? body.split('<<CCVERSION>>').join(catalogue.version)
      : body;

  const out = [];
  const seen = new Set();
  const push = c => {
    const k = [c.kind, c.hash, c.host ?? '', c.text].join('\u0000');
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  const litForms = new Map();
  const addForm = (h, s) => {
    if (!litForms.has(h)) litForms.set(h, new Set());
    litForms.get(h).add(s);
  };
  for (const [h, row] of rows)
    if (typeof row.text === 'string' && hash(row.text) === h)
      addForm(h, row.text);

  for (const p of catalogue.prompts || []) {
    const pieces = (p.pieces || []).filter(x => typeof x === 'string');
    const legacy = (p.legacyShapes || []).map(l =>
      l.pieces.filter(x => typeof x === 'string')
    );
    const probes = [pieces.join(''), ...pieces, ...legacy.flat()];
    const hits = new Set();
    for (const probe of probes)
      for (const cand of ex.slotLiteralCandidates(probe)) {
        // Rows hash the cooked literal and pieces hold raw source, so a quasi
        // with an escape (the founding "\n- Task list: ") matches only cooked.
        const cooked = cook(cand);
        const h = [cand, cooked].map(hash).find(x => rows.has(x));
        if (!h) continue;
        hits.add(h);
        addForm(h, cand);
        addForm(h, cooked);
      }
    if (!hits.size) continue;
    const body = pieces.join('');
    const v = boundVerdict(cache, [
      raw(body),
      ...legacy.map(l => raw(l.join(''))),
    ]);
    for (const h of hits) {
      const id = rows.get(h).id;
      if (v.first && v.first.facing !== 'model')
        push({
          kind: 'host',
          hash: h,
          id,
          host: p.id,
          text: body,
          cacheFacing: v.first.facing,
        });
      if (v.mixed) push({ kind: 'alias', hash: h, id, host: p.id, text: body });
    }
  }

  for (const [h, forms] of litForms)
    for (const form of forms) {
      const v = boundVerdict(cache, [raw(form)]);
      const id = rows.get(h).id;
      if (v.first && v.first.facing !== 'model')
        push({
          kind: 'literal',
          hash: h,
          id,
          text: form,
          cacheFacing: v.first.facing,
        });
      if (v.mixed) push({ kind: 'alias', hash: h, id, text: form });
    }
  return out;
}

const CACHE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'prompt-classification.json'
);

function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update-allowlist');
  const [cliPath, jsonPath] = args.filter(a => !a.startsWith('--'));
  if (!cliPath || !jsonPath) {
    console.error(
      'usage: node tools/checkSlotLiterals.mjs <cli.js> <prompts-X.Y.Z.json> [--update-allowlist]'
    );
    process.exit(2);
  }

  const source = fs.readFileSync(cliPath, 'utf8');
  const catalogue = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const findings = findSlotLiterals(source, catalogue);
  const allowlist = loadAllowlist();
  const unreviewed = findings.filter(f => !isReviewed(allowlist, f));
  const conflicts = verdictConflicts(
    allowlist,
    catalogue,
    JSON.parse(
      fs.readFileSync(process.env.TWEAKCC_CLASSIFICATION_CACHE || CACHE, 'utf8')
    )
  );

  if (args.includes('--json')) {
    console.log(JSON.stringify({ findings, unreviewed, conflicts }, null, 1));
    process.exitCode = unreviewed.length || conflicts.length ? 1 : 0;
    return;
  }

  const kinds = k => conflicts.filter(c => c.kind === k).length;
  console.log(
    'slot-literals: ' +
      findings.length +
      ' candidate(s), ' +
      (findings.length - unreviewed.length) +
      ' allowlisted, ' +
      unreviewed.length +
      ' unreviewed, ' +
      conflicts.length +
      ' catalogued against a ui/internal cache verdict (' +
      kinds('host') +
      ' host, ' +
      kinds('literal') +
      ' literal, ' +
      kinds('alias') +
      ' contradictory-alias)'
  );
  for (const f of conflicts) {
    const where =
      '\n  ' +
      (f.kind === 'alias' ? 'ALIAS' : 'CONFLICT') +
      ' [' +
      f.hash +
      '] ' +
      (f.id || '(no id)') +
      (f.host && f.host !== f.id ? ' hosted by ' + (f.host || '(no id)') : '') +
      (f.kind === 'literal' ? ' (the literal itself)' : '');
    console.log(
      where +
        (f.kind === 'alias'
          ? ': the cache rules this body both model and ui/internal under different keys: '
          : ' catalogued here, cache says ' + f.cacheFacing + ': ') +
        JSON.stringify(
          f.text.length > 300 ? f.text.slice(0, 300) + '...' : f.text
        ) +
        ' — rule it once and make both stores agree'
    );
  }

  for (const f of unreviewed) {
    console.log(
      '\n  ' +
        f.promptId +
        ' slot ' +
        f.slot +
        (f.label ? ' (' + f.label + ')' : '') +
        ' via ' +
        f.resolvedVia +
        ' @' +
        f.offset +
        ' [' +
        f.hash +
        ']\n    ' +
        JSON.stringify(f.text)
    );
  }

  if (update) {
    const next = { ...allowlist };
    for (const f of unreviewed) {
      // A site-specific verdict ruled at another host stays; overwriting it
      // would erase that host's review. Rule this host by adding it to the
      // row's `promptIds`, or replace the row with a verdict on the text.
      if (next[f.hash]) {
        console.log(
          '\n  kept [' +
            f.hash +
            '] ' +
            next[f.hash].verdict +
            ' at ' +
            rowHosts(next[f.hash]).join(', ') +
            '; rule it for ' +
            f.promptId +
            ' by hand'
        );
        continue;
      }
      next[f.hash] = {
        promptId: f.promptId,
        label: f.label,
        note: 'REVIEW ME - replace with the verdict and its reason',
        text: f.text.slice(0, 160),
      };
    }
    fs.writeFileSync(ALLOWLIST, JSON.stringify(next, null, 2) + '\n');
    console.log('\nwrote ' + ALLOWLIST);
    return;
  }

  process.exitCode = unreviewed.length || conflicts.length ? 1 : 0;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
