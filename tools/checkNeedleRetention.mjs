#!/usr/bin/env node
// Refuse an override that drops text the binary SEARCHES that prompt's output for.
//
// CC 2.1.281 builds the auto-mode denial tool_result from
// `system-prompt-tool-execution-denied-auto-mode-classifier`
// (`${PREFIX}${reason}. If you have other tasks that don't depend on this
// action, …`), and the TUI cuts the reason back out of that same text:
//
//   var J4o=". If you have other tasks";
//   function Pcr(e){ … r=n.indexOf(J4o); if(r<=0)return null; return n.slice(0,r) }
//
// An override trimmed the sentence, `Pcr` returned null, and the denial reason
// vanished from the UI while every gate stayed green. checkScannedLiterals only
// sees a catalogued literal blanked outright, and externalRefs only saw needles
// passed inline to startsWith/includes/endsWith — this one was const-bound and
// went through indexOf.
//
// Rule: a string literal the bundle searches with (see lib/searchNeedles.mjs)
// that sits inside a catalogued prompt's pristine prose, where that search
// looks, and is searched for near that prompt's own site, must still sit inside
// every non-empty override of that prompt. An empty override emits nothing, so
// there is nothing left to parse; a missing one is pristine. The placement and
// proximity rules took the live set from 48 findings to the 3 real ones.
//
// Deliberate drops go in data/needle-retention-allowlist.json as
// `{ "<id>": { "<needle>": "<reason>" } }`; a row that no longer silences
// anything is reported as stale.
//
// Usage:
//   node tools/checkNeedleRetention.mjs <cli.js> <prompts.json> [--sets=a,b]
//     sets default to TWEAKCC_OVERRIDE_SETS, then the applied set.
//     --allowlist=<path>  override the allowlist location (tests).
//     --json <path>       write findings for a downstream packet.
//     --verbose           list the distant leads the gate ignores.
//
// Exit 0 = PASS, 1 = findings, 2 = could not run.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { containsNeedle, needleCarriers } from './lib/searchNeedles.mjs';

const require = createRequire(import.meta.url);
const {
  parseOverrideArgs,
  resolveOverrideSets,
  printAuditedSets,
  remindersDirsFor,
} = require('./lib/overrideSets.cjs');

export const bodyOf = text =>
  text.replace(/^<!--[\s\S]*?-->\s*\n?/, '').replace(/\s+$/, '');

export const shadowSet = dirs => {
  const shadowed = new Set();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const head = fs.readFileSync(path.join(dir, f), 'utf8').split('-->')[0];
      const m = head.match(/^shadows:\s*\n((?:\s*-\s*\S+\n)+)/m);
      if (m) for (const q of m[1].matchAll(/-\s*(\S+)/g)) shadowed.add(q[1]);
    }
  }
  return shadowed;
};

const dropped = (rows, sets, shadowed) => {
  const out = [];
  for (const c of rows) {
    if (shadowed.has(c.id)) continue;
    for (const set of sets) {
      const file = path.join(set.dir, `${c.id}.md`);
      if (!fs.existsSync(file)) continue;
      const body = bodyOf(fs.readFileSync(file, 'utf8'));
      if (!body.trim()) continue;
      if (containsNeedle(body, c.needle)) continue;
      out.push({ ...c, set: set.name });
    }
  }
  return out;
};

export const auditNeedles = ({ src, prompts, sets, shadowed, allow }) => {
  const { rows: carriers, crossModule } = needleCarriers(src, prompts);
  const findings = [];
  const silenced = new Set();
  for (const f of dropped(carriers, sets, shadowed)) {
    if (allow[f.id] && f.needle in allow[f.id]) {
      silenced.add(`${f.id}\u0000${f.needle}`);
      continue;
    }
    findings.push(f);
  }
  const stale = [];
  for (const [id, rows] of Object.entries(allow)) {
    for (const needle of Object.keys(rows || {})) {
      if (!silenced.has(`${id}\u0000${needle}`)) stale.push({ id, needle });
    }
  }
  return {
    carriers,
    findings,
    leads: dropped(crossModule, sets, shadowed),
    stale,
    promptCount: new Set(carriers.map(c => c.id)).size,
  };
};

const describe = f =>
  f.uses
    .slice(0, 3)
    .map(
      u =>
        `   search : ${u.via} in ${u.module}\n` +
        `   site   : ${JSON.stringify(u.site)}\n`
    )
    .join('');

const main = () => {
  const die = msg => {
    console.error(`checkNeedleRetention: ${msg}`);
    process.exit(2);
  };
  const parsed = parseOverrideArgs(process.argv.slice(2));
  parsed.requireSets = true;
  const args = parsed.rest;
  const opt = name => {
    const eq = args.find(a => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  const jsonOut = opt('json');
  const verbose = args.includes('--verbose');
  const positional = args.filter(
    (a, i) => !a.startsWith('--') && args[i - 1] !== '--json'
  );
  const [cliPath, promptsPath] = positional;
  if (!cliPath || !promptsPath)
    die('usage: <cli.js> <prompts.json> [--sets=<dir>,<dir>]');
  for (const p of [cliPath, promptsPath])
    if (!fs.existsSync(p)) die(`missing ${p}`);

  const sets = resolveOverrideSets(parsed, {
    fallback: 'applied',
    exit: () => die('no override set to audit'),
  });
  if (!sets.length) die('no override set to audit');
  printAuditedSets(sets);

  const allowPath =
    opt('allowlist') ||
    path.join(
      path.dirname(url.fileURLToPath(import.meta.url)),
      '..',
      'data',
      'needle-retention-allowlist.json'
    );
  let allow = {};
  if (fs.existsSync(allowPath)) {
    try {
      allow = JSON.parse(fs.readFileSync(allowPath, 'utf8'));
    } catch (e) {
      die(`unreadable allowlist ${allowPath}: ${e.message}`);
    }
  }

  const src = fs.readFileSync(cliPath, 'utf8');
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf8')).prompts;
  if (!Array.isArray(prompts) || !prompts.length)
    die(`no prompts in ${promptsPath}`);

  const shadowed = shadowSet([
    ...sets.map(s => s.dir),
    ...remindersDirsFor(sets),
  ]);
  const { carriers, findings, leads, stale, promptCount } = auditNeedles({
    src,
    prompts,
    sets,
    shadowed,
    allow,
  });

  for (const f of findings) {
    console.error(
      `DROPPED NEEDLE  ${f.set}/${f.id}\n` +
        `   needle : ${JSON.stringify(f.needle)}\n` +
        describe(f) +
        `   effect : the binary searches this prompt's text for the needle; ` +
        `the override no longer contains it, so that search fails`
    );
  }
  for (const s of stale) {
    console.log(
      `stale allowlist row: ${s.id} ${JSON.stringify(s.needle)} — ` +
        `silences nothing; delete it`
    );
  }
  // A search far from the prompt's site (another module, or 96 KB+ away in
  // the same one) is almost always reading an error message or a command
  // line, not this prompt's output; listed for a reader, never gated.
  if (leads.length) {
    console.log(
      `note: ${leads.length} dropped needle(s) searched only far from ` +
        `the prompt's site — not gated${verbose ? '' : ' (--verbose lists them)'}`
    );
    if (verbose) {
      for (const l of leads) {
        console.log(
          `  lead ${l.set}/${l.id} ${JSON.stringify(l.needle)}\n${describe(l)}`
        );
      }
    }
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(findings, null, 2));

  console.log(
    `needle retention: ${carriers.length} needle(s) in ${promptCount} prompt(s), ` +
      `${findings.length} finding(s) — ${findings.length ? 'FAIL' : 'PASS'}`
  );
  process.exit(findings.length ? 1 : 0);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main();
}
