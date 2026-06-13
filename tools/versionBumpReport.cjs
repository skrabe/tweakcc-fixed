#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const matter = require('gray-matter');

const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (
      key === 'help' ||
      key === 'json' ||
      key === 'strict' ||
      key === 'no-extract'
    ) {
      out[key] = true;
    } else {
      out[key] = argv[++i];
    }
  }
  return out;
}

function compareVersions(a, b) {
  const ap = String(a).split('.').map(Number);
  const bp = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i] || 0;
    const bv = bp[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function promptFile(promptsDir, version) {
  return path.join(promptsDir, `prompts-${version}.json`);
}

function listPromptVersions(promptsDir) {
  if (!fs.existsSync(promptsDir)) return [];
  return fs
    .readdirSync(promptsDir)
    .map(name => name.match(/^prompts-(\d+\.\d+\.\d+)\.json$/)?.[1])
    .filter(Boolean)
    .sort(compareVersions);
}

function detectVersionFromCli(cliPath) {
  const content = fs.readFileSync(cliPath, 'utf8');
  return (
    content.match(/VERSION:"(\d+\.\d+\.\d+)"/)?.[1] ||
    content.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ||
    null
  );
}

function reconstruct(prompt) {
  return (prompt.pieces || []).join('');
}

function metrics(data) {
  const prompts = data?.prompts || [];
  return {
    total: prompts.length,
    named: prompts.filter(p => p.id).length,
    anonymous: prompts.filter(p => !p.id).length,
    identifierSlots: prompts.reduce(
      (sum, p) => sum + (p.identifiers || []).length,
      0
    ),
    emptyIdentifierMapPrompts: prompts.filter(p =>
      Object.values(p.identifierMap || {}).some(v => v === '')
    ).length,
  };
}

function idSet(data) {
  return new Set((data?.prompts || []).map(p => p.id).filter(Boolean));
}

function sortedDiff(a, b) {
  return [...a].filter(x => !b.has(x)).sort();
}

function tokenize(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 3)
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function likelyRenames(oldData, newData, added, removed) {
  const oldById = new Map((oldData?.prompts || []).map(p => [p.id, p]));
  const newById = new Map((newData?.prompts || []).map(p => [p.id, p]));
  const out = [];
  for (const removedId of removed) {
    const oldPrompt = oldById.get(removedId);
    if (!oldPrompt) continue;
    const oldTokens = tokenize(reconstruct(oldPrompt));
    let best = null;
    for (const addedId of added) {
      const newPrompt = newById.get(addedId);
      if (!newPrompt) continue;
      const score = jaccard(oldTokens, tokenize(reconstruct(newPrompt)));
      if (!best || score > best.score) {
        best = { oldId: removedId, newId: addedId, score };
      }
    }
    if (best && best.score >= 0.35) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score);
}

function runExtraction({ cliPath, oldJsonPath, newVersion }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-report-'));
  const tempCli = path.join(tempDir, 'cli.js');
  const tempOutput = path.join(tempDir, `prompts-${newVersion}.json`);
  fs.copyFileSync(cliPath, tempCli);
  fs.writeFileSync(
    path.join(tempDir, 'package.json'),
    JSON.stringify({
      name: '@anthropic-ai/claude-code',
      version: newVersion,
    })
  );
  if (oldJsonPath && fs.existsSync(oldJsonPath)) {
    fs.copyFileSync(oldJsonPath, tempOutput);
  }
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'promptExtractor.js'), tempCli, tempOutput],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(
      `promptExtractor failed:\n${result.stdout || ''}\n${result.stderr || ''}`
    );
  }
  const log = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    tempDir,
    outputPath: tempOutput,
    data: readJson(tempOutput),
    log,
    noMatchCount: (log.match(/^No match for item/gm) || []).length,
    assignedCount: (log.match(/^Assigned new prompt item/gm) || []).length,
    fuzzyCount: (log.match(/^Fuzzy-matched item/gm) || []).length,
  };
}

function scanOverrideCoverage(systemPromptsDir, systemRemindersDir, data) {
  const ids = idSet(data);
  const promptFiles = fs.existsSync(systemPromptsDir)
    ? fs
        .readdirSync(systemPromptsDir)
        .filter(name => name.endsWith('.md') && !name.startsWith('inline-'))
        .map(name => name.replace(/\.md$/, ''))
    : [];
  const reminderFiles = fs.existsSync(systemRemindersDir)
    ? fs
        .readdirSync(systemRemindersDir)
        .filter(name => name.endsWith('.md') && !name.startsWith('mcp-'))
        .map(name => name.replace(/\.md$/, ''))
    : [];
  return {
    promptOverrides: promptFiles.length,
    promptOverridesNotInJson: promptFiles.filter(id => !ids.has(id)).sort(),
    jsonIdsWithoutPromptOverride: [...ids]
      .filter(id => !promptFiles.includes(id))
      .sort(),
    reminderOverrides: reminderFiles.length,
  };
}

function scanUnknownPlaceholders(dirs) {
  const out = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(dir, name);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/UNKNOWN_\d+/.test(lines[i])) {
          out.push({
            file,
            line: i + 1,
            text: lines[i].trim().slice(0, 180),
          });
        }
      }
    }
  }
  return out;
}

function emptyIdentifierMapEntries(data) {
  return (data?.prompts || [])
    .map(prompt => ({
      id: prompt.id,
      name: prompt.name,
      emptyKeys: Object.entries(prompt.identifierMap || {})
        .filter(([, value]) => value === '')
        .map(([key]) => key),
    }))
    .filter(item => item.emptyKeys.length > 0);
}

function scanInlineAnchors(systemPromptsDir, cliPath) {
  const out = [];
  if (!fs.existsSync(systemPromptsDir) || !fs.existsSync(cliPath)) return out;
  const cli = fs.readFileSync(cliPath, 'utf8');
  for (const name of fs.readdirSync(systemPromptsDir).sort()) {
    if (!name.startsWith('inline-') || !name.endsWith('.md')) continue;
    const file = path.join(systemPromptsDir, name);
    const parsed = matter(fs.readFileSync(file, 'utf8'), {
      delimiters: ['<!--', '-->'],
    });
    const anchor = parsed.data?.inlineBlobAnchor;
    if (!anchor) continue;
    try {
      if (!new RegExp(anchor, 's').test(cli)) {
        out.push({ file, status: 'stale' });
      }
    } catch (error) {
      out.push({ file, status: `invalid: ${error.message}` });
    }
  }
  return out;
}

function readReminderInjectionIds() {
  const file = path.join(repoRoot, 'src/patches/systemReminderOverrides.ts');
  if (!fs.existsSync(file)) return [];
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/\bid:\s*'([^']+)'/g)]
    .map(match => match[1])
    .filter((id, index, all) => all.indexOf(id) === index)
    .sort();
}

function scanReminderCoverage(systemRemindersDir) {
  const known = new Set(readReminderInjectionIds());
  const files = fs.existsSync(systemRemindersDir)
    ? fs
        .readdirSync(systemRemindersDir)
        .filter(name => name.endsWith('.md') && !name.startsWith('mcp-'))
        .map(name => name.replace(/\.md$/, ''))
    : [];
  return {
    knownReminderIds: known.size,
    reminderOverridesNotInPatcher: files.filter(id => !known.has(id)).sort(),
    patcherReminderIdsWithoutOverride: [...known]
      .filter(id => !files.includes(id))
      .sort(),
  };
}

function printList(label, items, limit = 25) {
  console.log(`${label}: ${items.length}`);
  for (const item of items.slice(0, limit)) {
    if (typeof item === 'string') console.log(`  - ${item}`);
    else console.log(`  - ${JSON.stringify(item)}`);
  }
  if (items.length > limit) console.log(`  ... ${items.length - limit} more`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node tools/versionBumpReport.cjs [oldVersion] [newVersion] [--cli path] [--json] [--strict] [--no-extract]'
    );
    process.exit(0);
  }

  const promptsDir =
    args['prompts-dir'] || path.join(repoRoot, 'data', 'prompts');
  const cliPath =
    args.cli || path.join(os.homedir(), '.tweakcc', 'native-claudejs-orig.js');
  const versions = listPromptVersions(promptsDir);
  const newVersion =
    args.new ||
    args._[1] ||
    (fs.existsSync(cliPath) && detectVersionFromCli(cliPath));
  if (!newVersion) throw new Error('Could not infer new version');
  const oldVersion =
    args.old ||
    args._[0] ||
    [...versions]
      .reverse()
      .find(version => compareVersions(version, newVersion) < 0);
  if (!oldVersion) throw new Error('Could not infer old version');

  const oldJsonPath = promptFile(promptsDir, oldVersion);
  const newJsonPath = promptFile(promptsDir, newVersion);
  const oldData = fs.existsSync(oldJsonPath) ? readJson(oldJsonPath) : null;
  const committedNewData = fs.existsSync(newJsonPath)
    ? readJson(newJsonPath)
    : null;
  const extraction = args['no-extract']
    ? null
    : runExtraction({ cliPath, oldJsonPath, newVersion });
  const targetData = committedNewData || extraction?.data;
  if (!targetData) throw new Error(`No prompts data for ${newVersion}`);

  const oldIds = oldData ? idSet(oldData) : new Set();
  const newIds = idSet(targetData);
  const added = sortedDiff(newIds, oldIds);
  const removed = sortedDiff(oldIds, newIds);
  const coverage = scanOverrideCoverage(
    args['system-prompts-dir'] ||
      path.join(os.homedir(), '.tweakcc', 'system-prompts'),
    args['system-reminders-dir'] ||
      path.join(os.homedir(), '.tweakcc', 'system-reminders'),
    targetData
  );
  const unknowns = scanUnknownPlaceholders([
    args['system-prompts-dir'] ||
      path.join(os.homedir(), '.tweakcc', 'system-prompts'),
    args['system-reminders-dir'] ||
      path.join(os.homedir(), '.tweakcc', 'system-reminders'),
  ]);
  const inlineAnchors = scanInlineAnchors(
    args['system-prompts-dir'] ||
      path.join(os.homedir(), '.tweakcc', 'system-prompts'),
    cliPath
  );
  const reminderCoverage = scanReminderCoverage(
    args['system-reminders-dir'] ||
      path.join(os.homedir(), '.tweakcc', 'system-reminders')
  );
  const emptyMaps = emptyIdentifierMapEntries(targetData);
  const blockingIssues = [];
  const extractedMetrics = extraction ? metrics(extraction.data) : null;
  const committedMatchesExtraction =
    committedNewData && extraction
      ? JSON.stringify(committedNewData) === JSON.stringify(extraction.data)
      : null;
  if (extractedMetrics?.anonymous) {
    blockingIssues.push(
      `${extractedMetrics.anonymous} anonymous extracted prompt(s)`
    );
  }
  if (extraction?.noMatchCount) {
    blockingIssues.push(
      `${extraction.noMatchCount} extractor no-match item(s)`
    );
  }
  if (committedMatchesExtraction === false) {
    blockingIssues.push('fresh extraction differs from committed prompts JSON');
  }
  if (inlineAnchors.length > 0) {
    blockingIssues.push(
      `${inlineAnchors.length} stale/invalid inline anchor(s)`
    );
  }
  if (unknowns.length > 0) {
    blockingIssues.push(
      `${unknowns.length} UNKNOWN_* placeholder occurrence(s)`
    );
  }

  const report = {
    oldVersion,
    newVersion,
    cliPath,
    oldMetrics: oldData ? metrics(oldData) : null,
    committedNewMetrics: committedNewData ? metrics(committedNewData) : null,
    extractedMetrics,
    blockingIssues,
    extraction: extraction
      ? {
          outputPath: extraction.outputPath,
          noMatchCount: extraction.noMatchCount,
          assignedCount: extraction.assignedCount,
          fuzzyCount: extraction.fuzzyCount,
          matchesCommittedJson: committedMatchesExtraction,
        }
      : null,
    addedIds: added,
    removedIds: removed,
    likelyRenames: oldData
      ? likelyRenames(oldData, targetData, added, removed)
      : [],
    emptyIdentifierMapEntries: emptyMaps,
    unknownPlaceholders: unknowns,
    inlineAnchorIssues: inlineAnchors,
    overrideCoverage: coverage,
    reminderCoverage,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    if (args.strict && blockingIssues.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  console.log(`Version bump report: ${oldVersion} → ${newVersion}`);
  console.log(`cli.js: ${cliPath}`);
  console.log('old metrics:', report.oldMetrics);
  console.log('committed new metrics:', report.committedNewMetrics);
  console.log('extracted metrics:', report.extractedMetrics);
  if (report.extraction) console.log('extraction:', report.extraction);
  printList('added ids', added);
  printList('removed ids', removed);
  printList('likely renames', report.likelyRenames);
  printList('empty identifierMap entries', emptyMaps);
  printList('UNKNOWN placeholders', unknowns);
  printList('inline anchor issues', inlineAnchors);
  printList('blocking issues', blockingIssues);
  printList('prompt overrides not in JSON', coverage.promptOverridesNotInJson);
  printList(
    'JSON ids without prompt override',
    coverage.jsonIdsWithoutPromptOverride
  );
  printList(
    'reminder overrides not in patcher',
    reminderCoverage.reminderOverridesNotInPatcher
  );
  printList(
    'patcher reminder ids without override',
    reminderCoverage.patcherReminderIdsWithoutOverride
  );

  if (args.strict && blockingIssues.length > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
