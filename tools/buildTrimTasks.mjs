#!/usr/bin/env node
// Builds the task files the stage-2 trim-and-verify and wipe-verify fan-outs
// take, from the final stage-1 result (after the cut hunt).
//
//   node tools/buildTrimTasks.mjs <prompts.json> <stage1-result.json> <auditPacketDir> \
//     --set=<abs active set dir> --reminders=<abs reminders dir> \
//     --out-trim=<dir> --out-verify=<dir>
//
// One `trim-verify` task per `trim` verdict: <out-trim>/tasks.json, plus the
// packet <out-trim>/<id>.json the trimmer and its verifier both read. One
// `verify` task covering every `wipe-merge` verdict: <out-verify>/tasks.json
// and <out-verify>/packets.json ({ids, packets}), plus a <id>.json per id. Run
// it after the wipe bodies are written, because each packet carries the
// deployed body of the override and of every carrier it cites.
//
// A packet is: id, verdict (the stage-1 verdict with coveredBy and trimPlan),
// catalogueEntries (every site of the id), auditEntry (the id's entry from
// the stage-1 packets), overrideFile, deployedOverride ({file, ccVersion,
// body}, or a note when no file exists) and carriers (one per coveredBy
// quote: carrierId, quote, catalogueEntries, catalogueVersion, deployed,
// looked up in the active set, or in the reminders dir for a
// `system-reminders/<name>` carrier). The carriers checkAuditVerdicts accepts
// beyond catalogue ids have no catalogue entry: `inline-*` (deployed file in
// the active set), `system-reminders/<name>` (file required) and
// MODEL_DEFAULT (no file). Exits 2 on an id missing from the catalogue or the
// audit packets, a carrier that resolves to nothing, a missing reminder file,
// a stage-1 result that is not complete and post-cut-hunt, or catalogue,
// result and audit-manifest versions that disagree.
//
// The result is checked with `driver tasks-check`; the printed hints are the
// `driver tasks-args` calls that launch the fan-outs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REMINDER_PREFIX = 'system-reminders/';
const INLINE_PREFIX = 'inline-';
const MODEL_DEFAULT = 'MODEL_DEFAULT';
const FRONTMATTER = /^<!--[\s\S]*?-->\n?/;

const readIfExists = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

// The override's body is everything after the frontmatter, byte for byte: a
// trim keeps its trailing newline and a wipe's (whitespace-only) body is empty.
const deployedFrom = (file, text) => {
  if (text === null) {
    return { file, ccVersion: null, body: null, note: 'no override file: pristine applies' };
  }
  const fm = FRONTMATTER.exec(text);
  const version = fm && /^ccVersion:\s*['"]?([^'"\s]+)/m.exec(fm[0]);
  const body = fm ? text.slice(fm[0].length) : text;
  return {
    file,
    ccVersion: version ? version[1] : null,
    body: body.trim() ? body : '',
  };
};

export function buildTrimTasks({ catalogue, result, auditPackets, setDir, remindersDir, manifestVersion }) {
  const problems = [];
  if (result.complete !== true) {
    problems.push('the stage-1 result is not complete (missing verdicts or checker errors): finish stage 1 first');
  }
  if (!result.cutHunt || result.cutHunt.complete !== true) {
    problems.push('the stage-1 result is not the post-cut-hunt result (no cutHunt.complete): run harvestCutHunt.mjs first, not --allow-partial');
  }
  const versions = { catalogue: catalogue.version, 'stage-1 result': result.version, 'audit manifest': manifestVersion };
  if (new Set(Object.values(versions)).size !== 1) {
    problems.push(`versions disagree: ${Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  const byId = new Map();
  for (const p of catalogue.prompts || []) {
    if (!p.id) continue;
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id).push(p);
  }
  const auditById = new Map();
  for (const packet of auditPackets) {
    for (const p of packet.prompts || []) auditById.set(p.id, p);
  }
  const overrideFor = id =>
    id.startsWith(REMINDER_PREFIX)
      ? path.join(remindersDir, `${id.slice(REMINDER_PREFIX.length)}.md`)
      : path.join(setDir, `${id}.md`);

  const packetFor = verdict => {
    const id = verdict.id;
    const entries = byId.get(id);
    if (!entries) problems.push(`${id}: not in the catalogue`);
    const auditEntry = auditById.get(id);
    if (!auditEntry) problems.push(`${id}: not in the audit packets`);
    const overrideFile = overrideFor(id);
    const carriers = [];
    for (const c of verdict.coveredBy || []) {
      const cid = c.carrierId;
      if (cid === MODEL_DEFAULT) {
        carriers.push({
          carrierId: cid,
          quote: c.quote,
          catalogueEntries: [],
          catalogueVersion: null,
          deployed: null,
          note: 'model default: verify against both system-card digests',
        });
        continue;
      }
      const isReminder = cid.startsWith(REMINDER_PREFIX);
      const isInline = cid.startsWith(INLINE_PREFIX);
      const cEntries = byId.get(cid) || (isReminder || isInline ? [] : null);
      if (!cEntries) {
        problems.push(`${id}: carrier ${cid} is not in the catalogue`);
        continue;
      }
      const file = overrideFor(cid);
      const text = readIfExists(file);
      if ((isReminder || isInline) && text === null) {
        problems.push(`${id}: carrier ${cid} has no file at ${file}`);
        continue;
      }
      carriers.push({
        carrierId: cid,
        quote: c.quote,
        catalogueEntries: cEntries,
        catalogueVersion: cEntries.length ? cEntries[0].version || null : null,
        deployed: deployedFrom(file, text),
        ...(isInline
          ? { note: 'inline override: no catalogue entry, deployed file only' }
          : {}),
      });
    }
    return {
      id,
      verdict,
      catalogueEntries: entries || [],
      auditEntry: auditEntry || null,
      overrideFile,
      deployedOverride: deployedFrom(overrideFile, readIfExists(overrideFile)),
      carriers,
    };
  };

  const trims = result.verdicts.filter(v => v.verdict === 'trim').map(packetFor);
  const wipes = result.verdicts.filter(v => v.verdict === 'wipe-merge').map(packetFor);
  return { problems, trims, wipes };
}

const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 1) + '\n');

function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  const pos = [];
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (m) flags[m[1]] = m[2];
    else pos.push(a);
  }
  const [jsonPath, resultPath, packetDirArg] = pos;
  const missingFlags = ['set', 'reminders', 'out-trim', 'out-verify'].filter(k => !flags[k]);
  if (!jsonPath || !resultPath || !packetDirArg || pos.length > 3 || missingFlags.length) {
    console.error(
      'usage: buildTrimTasks.mjs <prompts.json> <stage1-result.json> <auditPacketDir> --set=<abs dir> --reminders=<abs dir> --out-trim=<dir> --out-verify=<dir>' +
        (missingFlags.length ? `\nmissing: ${missingFlags.map(k => `--${k}`).join(', ')}` : '')
    );
    process.exit(2);
  }
  const setDir = path.resolve(flags.set);
  const remindersDir = path.resolve(flags.reminders);
  const outTrim = path.resolve(flags['out-trim']);
  const outVerify = path.resolve(flags['out-verify']);
  const packetDir = path.resolve(packetDirArg);
  for (const [what, dir] of [['--set', setDir], ['--reminders', remindersDir], ['audit packet dir', packetDir]]) {
    if (!fs.existsSync(dir)) {
      console.error(`buildTrimTasks: ${what} not found: ${dir}`);
      process.exit(2);
    }
  }
  const auditFiles = fs.readdirSync(packetDir).filter(f => /^audit-packet-\d+\.json$/.test(f)).sort();
  if (!auditFiles.length) {
    console.error(`buildTrimTasks: no audit-packet-NN.json in ${packetDir}`);
    process.exit(2);
  }
  const catalogue = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const manifestFile = path.join(packetDir, 'audit-manifest.json');
  const manifestVersion = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')).version
    : undefined;
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const auditPackets = auditFiles.map(f => JSON.parse(fs.readFileSync(path.join(packetDir, f), 'utf8')));
  const { problems, trims, wipes } = buildTrimTasks({ catalogue, result, auditPackets, setDir, remindersDir, manifestVersion });
  if (problems.length) {
    console.error(`buildTrimTasks: ${problems.length} problem(s), nothing written:\n${problems.map(p => `  ${p}`).join('\n')}`);
    process.exit(2);
  }

  const trimTasksPath = path.join(outTrim, 'tasks.json');
  const verifyTasksPath = path.join(outVerify, 'tasks.json');
  if (trims.length) {
    fs.mkdirSync(outTrim, { recursive: true });
    for (const p of trims) writeJson(path.join(outTrim, `${p.id}.json`), p);
    writeJson(
      trimTasksPath,
      trims.map(p => ({ id: p.id, packet: path.join(outTrim, `${p.id}.json`), paths: [p.overrideFile], verdict: p.verdict }))
    );
  }
  if (wipes.length) {
    fs.mkdirSync(outVerify, { recursive: true });
    for (const p of wipes) writeJson(path.join(outVerify, `${p.id}.json`), p);
    const packetsPath = path.join(outVerify, 'packets.json');
    writeJson(packetsPath, { ids: wipes.map(p => p.id), packets: wipes });
    writeJson(verifyTasksPath, [{ name: 'w00', packet: packetsPath, ids: wipes.map(p => p.id) }]);
  }

  const driver = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.claude/skills/showtime-skrabe/driver.mjs');
  const version = catalogue.version;
  console.log(
    `trim tasks ${version}: ${trims.length} trim-verify task(s) -> ${trims.length ? trimTasksPath : 'none'}; ${wipes.length} wipe-merge id(s) in 1 verify task -> ${wipes.length ? verifyTasksPath : 'none'}`
  );
  if (trims.length) console.log(`  node ${driver} tasks-args trim-verify ${trimTasksPath} --version ${version} --model <model> --trim-effort <E> --verify-effort <E>`);
  if (wipes.length) console.log(`  node ${driver} tasks-args verify ${verifyTasksPath} --version ${version} --model <model> --effort <E>`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
