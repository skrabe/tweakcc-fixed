#!/usr/bin/env node
// Guard for the class that broke auto mode on CC 2.1.246/2.1.247: an override that
// deletes an OUTPUT-FORMAT sentinel the binary parses the model's reply with.
//
// This is the mirror image of checkSubstitutionTags. That gate covers the INBOUND
// direction — a tag CC substitutes generated content INTO, where a missing tag makes
// `String.replace` a silent no-op. This one covers the OUTBOUND direction — a tag CC
// expects the model to EMIT, where a missing instruction makes the parser return null
// and the caller fail closed.
//
// The concrete failure: CC's auto-mode permission classifier is parsed by
//   function OGt(e){ … e.matchAll(/<block>(yes|no)\b/gi) … return null }
// and a null verdict is reported to the user as "Auto mode could not evaluate this
// action and is blocking it for safety". Two overrides had trimmed away every
// `<block>yes</block>` / `<block>no</block>` example and the "your ENTIRE response
// MUST begin with <block>" directive, so the classifier never emitted the tag and
// every auto-mode action was refused. Nothing else could see it: the apply is clean,
// four zeros are green, the harness passes, the binary boots and `--print` smokes
// READY, because the classifier is a separate side-call that no main-loop check
// exercises. Only the user hitting it in a real session surfaced it.
//
// Rule: a tag that appears inside a REGEX LITERAL in the binary is a tag the binary
// parses out of text. If a prompt's pristine body mentions such a tag, every override
// of that prompt must mention it too — otherwise the override has removed the model's
// only instruction to produce what the parser is looking for.
//
// Only pristine-carries-it cases are checked, so a prompt that never mentioned the tag
// is never flagged; that is what keeps pointer-style overrides out of the results.
//
// Usage: node tools/checkOutputContracts.mjs [--cli <cli.js>] [--json <prompts.json>] [--lcc <dir>]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? d : process.argv[i + 1];
};
const HOME = os.homedir();
const LCC = arg('--lcc', path.join(HOME, '.tweakcc/lobotomized-claude-code'));
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const newestPromptsJson = () =>
  fs
    .readdirSync(path.join(REPO, 'data/prompts'))
    .filter(f => /^prompts-\d+\.\d+\.\d+\.json$/.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop();

const jsonArg = arg('--json') ?? newestPromptsJson();
const jsonPath = path.isAbsolute(jsonArg)
  ? jsonArg
  : fs.existsSync(jsonArg)
    ? path.resolve(jsonArg)
    : path.join(REPO, 'data/prompts', jsonArg);
const version = path.basename(jsonPath).replace(/^prompts-|\.json$/g, '');

// The stale-backup rule deletes native-claudejs-orig.js before a bump's first apply,
// so fall back to the extracted bundle the way the other gates do rather than
// skipping silently. A gate that could not run is a gate that did not run.
const cliCandidates = [
  arg('--cli'),
  path.join(HOME, '.tweakcc/native-claudejs-orig.js'),
  `/tmp/cli-${version}.js`,
].filter(Boolean);
const cliPath = cliCandidates.find(p => {
  if (!fs.existsSync(p)) return false;
  const head = fs.readFileSync(p, 'utf8');
  return head.includes(version);
});
if (!cliPath) {
  console.error(
    `output contracts: SKIPPED — no pristine bundle at ${version} (tried ${cliCandidates.join(', ')})`
  );
  process.exit(2);
}

const cli = fs.readFileSync(cliPath, 'utf8');

// ---- 1. discover the tags the binary PARSES ------------------------------------
// A regex literal in minified JS is /.../flags, but a naive scan for that shape also
// matches ordinary prose inside template literals — `<out_dir>`, `<name>` and
// `<script>` all showed up that way and were pure noise, 14 of 22 findings. The tell
// that a match is a REAL regex extracting between tags is the ESCAPED close tag
// `<\/tag>`: a regex has to escape that slash, and prose never does. Require the
// escaped close (or an immediate capture group) and the noise disappears while every
// genuine parser — <block>, <summary>, <analysis>, <thinking> — is still found.
// Measured on CC 2.1.247: 22 findings before this rule, 8 after, 0 false positives.
const parsedTags = new Set();
for (const m of cli.matchAll(/\/((?:[^/\\\n[]|\\.|\[[^\]\n]*\])+)\/[gimsuy]*/g)) {
  const src = m[1];
  for (const t of src.matchAll(/<([a-z][a-z0-9_]{2,40})>/gi)) {
    const tag = t[1].toLowerCase();
    const extractsBetween = src.includes(`<\\/${tag}>`);
    const capturesAfter = /^[([]/.test(src.slice(t.index + t[0].length));
    if (extractsBetween || capturesAfter) parsedTags.add(`<${tag}>`);
  }
}
if (!parsedTags.size) {
  console.error('output contracts: SKIPPED — no parsed tags found in the bundle');
  process.exit(2);
}

// ---- 2. which prompts does pristine instruct those tags in? ---------------------
const reconstruct = p => {
  const pieces = p.pieces || [];
  const ids = p.identifiers || [];
  const map = p.identifierMap || {};
  if (!pieces.length) return p.content || '';
  let out = '';
  pieces.forEach((piece, i) => {
    out += typeof piece === 'string' ? piece : '';
    if (i < pieces.length - 1) {
      const k = String(ids[i] ?? i);
      out += map[k] ?? map[String(i)] ?? `UNKNOWN_${i}`;
    }
  });
  return out;
};

const prompts = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).prompts;
const required = new Map(); // id -> Set(tag)
for (const p of prompts) {
  if (!p.id) continue;
  const body = reconstruct(p).toLowerCase();
  for (const tag of parsedTags) {
    if (body.includes(tag)) {
      if (!required.has(p.id)) required.set(p.id, new Set());
      required.get(p.id).add(tag);
    }
  }
}

// ---- 3. every override of such a prompt must keep the tag -----------------------
const allowPath = path.join(REPO, 'data/output-contract-allowlist.json');
const allow = fs.existsSync(allowPath)
  ? JSON.parse(fs.readFileSync(allowPath, 'utf8'))
  : {};

const sets = fs
  .readdirSync(LCC)
  .filter(d => /^system-prompts-/.test(d))
  .filter(d => fs.statSync(path.join(LCC, d)).isDirectory());

const stripFrontMatter = t => {
  const m = /^<!--[\s\S]*?-->\n?/.exec(t);
  return m ? t.slice(m[0].length) : t;
};

const findings = [];
let checked = 0;
for (const set of sets) {
  for (const [id, tags] of required) {
    const file = path.join(LCC, set, `${id}.md`);
    if (!fs.existsSync(file)) continue; // no override -> pristine applies, tag intact
    const body = stripFrontMatter(fs.readFileSync(file, 'utf8')).toLowerCase();
    if (!body.trim()) continue; // deliberate suppression: the prompt is gone entirely
    checked++;
    for (const tag of tags) {
      if (body.includes(tag)) continue;
      const key = `${set}/${id}::${tag}`;
      if (allow[key]?.verdict === 'reviewed') continue;
      findings.push({ set, id, tag, key });
    }
  }
}

console.log(
  `output contracts: ${parsedTags.size} parsed tag(s), ${required.size} prompt(s) instruct one, ${checked} override(s) checked`
);
if (!findings.length) {
  console.log('output contracts: PASS — every override keeps the tag its parser needs');
  process.exit(0);
}
for (const f of findings) {
  console.log(`  ${f.set.padEnd(24)} ${f.id}`);
  console.log(
    `      pristine instructs ${f.tag} and the binary parses it, but this override drops it`
  );
  console.log(`      allowlist key: ${f.key}`);
}
console.log(
  `output contracts: ${findings.length} override(s) dropped a tag the binary parses.\n` +
    'Restore the format instruction, or record the drop in data/output-contract-allowlist.json with a reason.'
);
process.exit(1);
