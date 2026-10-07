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
      raw: node.extra && node.extra.raw ? node.extra.raw.slice(1, -1) : node.value,
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

/** The three shapes a catalogued `pieces` entry can be compared against. */
const forms = lit => [lit.text, lit.raw, decodeUnicodeEscapes(lit.raw)];

export function findSlotLiterals(source, catalogue) {
  // A prompt's `pieces` do NOT split on the substitution expression — they
  // split on the IDENTIFIER inside it, so `${e.agentName}` leaves `${` at the
  // end of one piece and `.agentName}` at the start of the next. Quasi text is
  // therefore a strict subset of piece text, and the two can never be compared
  // by equality (the first cut of this gate did, and reported 0 on a bundle
  // that has a real finding). Index on the leading quasi — the first piece
  // minus its trailing `${` — and disambiguate collisions by containment.
  const byLead = new Map();
  for (const p of catalogue.prompts) {
    if (!p.pieces || p.pieces.length < 2) continue;
    const lead = p.pieces[0].replace(/\$\{$/, '');
    if (lead.length < 8) continue;
    if (!byLead.has(lead)) byLead.set(lead, []);
    byLead.get(lead).push({ prompt: p, blob: p.pieces.join('') });
  }
  const matchPrompt = quasiRaws => {
    const cands = byLead.get(quasiRaws[0]);
    if (!cands) return null;
    if (cands.length === 1) return cands[0].prompt;
    const hit = cands.find(c =>
      quasiRaws.every(q => q.length < 12 || c.blob.includes(q))
    );
    return hit ? hit.prompt : null;
  };

  // A slot's label lives at identifierMap[identifiers[slotIndex]] — the
  // `identifiers` array is the positional binding, and reading identifierMap by
  // the raw slot index is the mis-binding bug `auditMisbinds` exists to catch.
  const labelFor = (p, slot) => {
    if (!p.identifierMap) return null;
    const idx = Array.isArray(p.identifiers) ? p.identifiers[slot] : slot;
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
      const prompt = matchPrompt(node.quasis.map(q => q.value.raw));
      if (!prompt) return;

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
            // Already catalogued in any of three forms. `pieces` are not raw and
            // not cooked but a MIX: raw source with unicode escapes decoded
            // (decodeUnicodeEscapesInPiece in the extractor). A string carrying
            // both an escaped backtick and a `—` em dash therefore matches
            // neither pure form — the cooked one differs at the backtick, the raw
            // one at the dash — which is how the MCP remote-auth suffix and the
            // SendMessage cross-session guidance read as uncatalogued.
            if (forms(lit).some(f => catalogued.has(norm(f)))) continue;
            if (forms(lit).some(f => cataloguedBlob.includes(f.trim()))) continue;
            findings.push({
              promptId: prompt.id,
              slot,
              label: labelFor(prompt, slot),
              resolvedVia,
              offset: lit.start,
              hash: hash(lit.text),
              text:
                lit.text.length > 300 ? lit.text.slice(0, 300) + '...' : lit.text,
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
  const unreviewed = findings.filter(f => !allowlist[f.hash]);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ findings, unreviewed }, null, 1));
    process.exit(unreviewed.length ? 1 : 0);
  }

  console.log(
    'slot-literals: ' +
      findings.length +
      ' candidate(s), ' +
      (findings.length - unreviewed.length) +
      ' allowlisted, ' +
      unreviewed.length +
      ' unreviewed'
  );

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

  process.exit(unreviewed.length ? 1 : 0);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
