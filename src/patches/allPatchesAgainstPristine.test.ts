// Structural regression gate: run EVERY registered patch's write function
// against a real pristine cli.js, ignoring its config toggle, and require that
// it either applies (and emits parseable JS) or legitimately no-ops.
//
// This exists because two whole bug classes were invisible to the per-patch
// unit tests: (a) a default-off patch (context-limit) returned null for a full
// CC version and nothing exercised it; (b) a patch (swapRipgrepForFff) spliced
// a SyntaxError because its fixtures were synthetic/pre-flattened rather than
// the real bundle. Both stayed green under `pnpm test`.
//
// Gated behind TWEAKCC_PRISTINE_PATCHES=1 (see `pnpm test:pristine`) because it
// needs a ~21 MB pristine cli.js on disk and spawns Bun to parse each output.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { getAllPatchDefinitions, PatchId } from './index';
import { REMINDER_REGISTRY } from './systemReminderOverrides';
import { substitutePlaceholders } from '../systemReminderSync';
import { DEFAULT_SETTINGS } from '../defaultSettings';

import { writeVerboseProperty } from './verboseProperty';
import { writeReadDefaultLines } from './readDefaultLines';
import { writeContextLimit } from './contextLimit';
import { writeOpusplan1m } from './opusplan1m';
import { writeThinkingBlockStyling } from './thinkingBlockStyling';
import { writeFixLspSupport } from './fixLspSupport';
import { writeFixSummarizeFromHere } from './fixSummarizeFromHere';
import { writeFixRewindSummaryHeader } from './fixRewindSummaryHeader';
import { writeStatuslineUpdateThrottle } from './statuslineUpdateThrottle';
import { writeClearScreen } from './clearScreen';
import { writePatchesAppliedIndication } from './patchesAppliedIndication';
import { writeModelCustomizations } from './modelSelector';
import { writeShowMoreItemsInSelectMenus } from './showMoreItemsInSelectMenus';
import { writeTableFormat } from './tableFormat';
import { writeThemes } from './themes';
import { writeThinkingVerbs } from './thinkingVerbs';
import { writeThinkerFormat } from './thinkerFormat';
import { writeThinkerSymbolChars } from './thinkerSymbolChars';
import { writeThinkerSymbolSpeed } from './thinkerSymbolSpeed';
import { writeThinkerSymbolWidthLocation } from './thinkerSymbolWidth';
import { writeThinkerSymbolMirrorOption } from './thinkerMirrorOption';
import { writeInputBoxBorder } from './inputBorderBox';
import { writeSubagentModels } from './subagentModels';
import { writeThinkingVisibility } from './thinkingVisibility';
import { writeHideStartupBanner } from './hideStartupBanner';
import { writeHideCtrlGToEdit } from './hideCtrlGToEdit';
import { writeHideStartupClawd } from './hideStartupClawd';
import { writeIncreaseFileReadLimit } from './increaseFileReadLimit';
import { writeSuppressLineNumbers } from './suppressLineNumbers';
import { writeSuppressRateLimitOptions } from './suppressRateLimitOptions';
import { writeTokenCountRounding } from './tokenCountRounding';
import { writeRememberSkill } from './rememberSkill';
import { writeAgentsMd } from './agentsMd';
import { writeAutoAcceptPlanMode } from './autoAcceptPlanMode';
import { writeAllowBypassPermsInSudo } from './allowBypassPermsInSudo';
import { writeSuppressNativeInstallerWarning } from './suppressNativeInstallerWarning';
import { writeScrollEscapeSequenceFilter } from './scrollEscapeSequenceFilter';
import { writeMaxEffortDefault } from './maxEffortDefault';
import { writeAutonomousOperationAllModels } from './autonomousOperationAllModels';
import { writeOutputStyleTurnReminder } from './outputStyleTurnReminder';
import { writeAutoModeClassifierModel } from './autoModeClassifierModel';
import { writeComplexityRouter } from './complexityRouter';
import { writeFablePlan } from './fablePlan';
import { writeAllowCustomAgentModels } from './allowCustomAgentModels';
import { writeWorktreeMode } from './worktreeMode';
import { writeSessionMemory } from './sessionMemory';
import { writeSwapRipgrepForFff } from './swapRipgrepForFff';
import { writeDreamMode } from './dreamMode';
import { writeLeanMemoryTypes } from './leanMemoryTypes';
import { writeToolsets } from './toolsets';
import { writeMcpNonBlocking, writeMcpBatchSize } from './mcpStartup';
import { writeUserMessageDisplay } from './userMessageDisplay';
import { writeInputPatternHighlighters } from './inputPatternHighlighters';
import { writeConversationTitle } from './conversationTitle';
import { writeVoiceMode } from './voiceMode';
import { writeChannelsMode } from './channelsMode';
import {
  writeSuppressDeferredTools,
  writeStripEmptySystemReminders,
  writeClaudemdContextOncePerConversation,
} from './systemReminders';

const ENABLED = process.env.TWEAKCC_PRISTINE_PATCHES === '1';

// ---------------------------------------------------------------------------
// Pristine cli.js discovery
// ---------------------------------------------------------------------------

// tweakcc stamps its own marker into everything it splices, so a file carrying
// one is a PATCHED binary's JS, not pristine — patching it again proves nothing.
const isPristine = (src: string): boolean => !src.includes('__tweakcc');

const findPristineCliJs = (): { path: string; source: string } | null => {
  const candidates: string[] = [
    path.join(os.homedir(), '.tweakcc', 'native-claudejs-orig.js'),
  ];
  try {
    const tmpMatches = fs
      .readdirSync('/tmp')
      .filter(f => /^cli-.*\.js$/.test(f))
      .map(f => path.join('/tmp', f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    candidates.push(...tmpMatches);
  } catch {
    // no /tmp listing available; the home candidate still stands
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const source = fs.readFileSync(candidate, 'utf8');
    if (!isPristine(source)) continue;
    return { path: candidate, source };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Parse oracle
// ---------------------------------------------------------------------------
//
// `new Function(src)` is NOT a usable oracle: it throws on the pristine bundle
// itself. Bun's transpiler is the same parser that actually loads cli.js at
// runtime, so it is the authoritative answer to "would CC boot?", and it chews
// through 21 MB in ~350 ms. The suite runs under node, so shell out to bun.

const findBun = (): string | null => {
  const candidates = [
    process.env.TWEAKCC_BUN_PATH,
    path.join(os.homedir(), '.bun', 'bin', 'bun'),
  ].filter((c): c is string => !!c);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const resolved = execFileSync('command', ['-v', 'bun'], {
      encoding: 'utf8',
      shell: '/bin/sh',
    }).trim();
    return resolved || null;
  } catch {
    return null;
  }
};

// CC 2.1.246 code-split the bundle, so what the patch layer now sees is a
// VIRTUAL bundle: every JS module concatenated behind a
// `/*@@TWEAKCC_MODULE:index:name@@*/` sentinel. That concatenation is NOT a
// valid single program — 1,412 ESM modules redeclare each other's top-level
// names — so transpiling it whole is not just wrong, it wedges: the first run
// against 2.1.246 sat for 32 minutes at 0% CPU. Parse each module on its own,
// which is also what actually ships, since Bun loads them individually.
const MODULE_MARK = '/*@@TWEAKCC_MODULE:';
const MODULE_END = '@@*/';

interface ModuleSpan {
  name: string;
  bodyStart: number;
  bodyEnd: number;
}

const splitModuleSpans = (src: string): ModuleSpan[] => {
  const mods: ModuleSpan[] = [];
  let i = src.indexOf(MODULE_MARK);
  while (i !== -1) {
    const close = src.indexOf(MODULE_END, i);
    const name = src.slice(i + MODULE_MARK.length, close);
    const bodyStart = close + MODULE_END.length;
    const next = src.indexOf(MODULE_MARK, close);
    mods.push({
      name,
      bodyStart,
      bodyEnd: next === -1 ? src.length : next,
    });
    i = next;
  }
  return mods;
};

const collectChangedBodies = (
  original: string,
  origSpans: ModuleSpan[],
  source: string
): string => {
  const srcSpans = splitModuleSpans(source);
  const origByName = new Map(origSpans.map(s => [s.name, s]));
  const chunks: string[] = [];
  for (const span of srcSpans) {
    const orig = origByName.get(span.name);
    // Compare CONTENT, not length. A same-length substitution — which is a
    // perfectly ordinary patch shape — is invisible to a length test, so the
    // oracle would silently skip the one module the patch actually touched
    // and report a pass having parsed nothing.
    const body = source.slice(span.bodyStart, span.bodyEnd);
    const origBody = orig ? original.slice(orig.bodyStart, orig.bodyEnd) : null;
    if (origBody !== body) {
      chunks.push(`${MODULE_MARK}${span.name}${MODULE_END}\n` + body);
    }
  }
  return chunks.join('');
};

const ORACLE_SCRIPT = `
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const t = new Bun.Transpiler({ loader: 'js' });
const MARK = '/*@@TWEAKCC_MODULE:';
const END = '@@*' + '/';
if (src.indexOf(MARK) === -1) {
  t.transformSync(src);
} else {
  const bounds = [];
  let i = src.indexOf(MARK);
  while (i !== -1) {
    const close = src.indexOf(END, i);
    bounds.push({
      start: i,
      bodyStart: close + END.length,
      name: src.slice(i + MARK.length, close),
    });
    i = src.indexOf(MARK, close);
  }
  for (let k = 0; k < bounds.length; k++) {
    const from = bounds[k].bodyStart;
    const to = k + 1 < bounds.length ? bounds[k + 1].start : src.length;
    try {
      t.transformSync(src.slice(from, to));
    } catch (err) {
      throw new Error('module ' + bounds[k].name + ': ' + err.message);
    }
  }
}
`;

interface ParseOracle {
  /** Returns null when the source parses, or the parse error text. */
  check(source: string, label: string): string | null;
}

const makeOracle = (
  bun: string,
  scratch: string,
  original: string
): ParseOracle => {
  const scriptPath = path.join(scratch, 'parse-oracle.js');
  fs.writeFileSync(scriptPath, ORACLE_SCRIPT, 'utf8');
  const origSpans = splitModuleSpans(original);
  return {
    check(source, label) {
      const srcPath = path.join(scratch, `${label}.js`);
      let toWrite = source;
      if (source !== original && source.includes(MODULE_MARK)) {
        toWrite = collectChangedBodies(original, origSpans, source);
        if (toWrite.length === 0) {
          toWrite = source;
        }
      }
      fs.writeFileSync(srcPath, toWrite, 'utf8');
      try {
        execFileSync(bun, [scriptPath, srcPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 8 * 1024 * 1024,
        });
        return null;
      } catch (error) {
        const e = error as { stderr?: string; message?: string };
        return (e.stderr || e.message || 'unknown parse failure')
          .split('\n')
          .slice(0, 12)
          .join('\n');
      } finally {
        fs.rmSync(srcPath, { force: true });
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Fixtures — realistic, non-default config so every patch has real work to do
// ---------------------------------------------------------------------------

const FFF_WRAPPER_PATH = path.join(os.homedir(), '.tweakcc', 'fff', 'rg-fff');
const TEST_TOOLSETS = [
  { name: 'minimal', allowedTools: ['Read', 'Bash', 'Grep'] },
  { name: 'everything', allowedTools: '*' as const },
];
const TEST_HIGHLIGHTERS = [
  {
    name: 'At-mentions',
    regex: '@[\\w./-]+',
    regexFlags: 'g',
    format: '{MATCH}',
    styling: ['bold'],
    foregroundColor: 'rgb(177,185,249)',
    backgroundColor: null,
    enabled: true,
  },
];

/**
 * Every patch id → an invocation with realistic arguments. Typed as a total
 * Record<PatchId, …>, so adding a patch to PATCH_DEFINITIONS without wiring it
 * here is a `tsc --noEmit` failure — the coverage is enforced, not aspirational.
 */
const INVOCATIONS: Record<PatchId, (src: string) => string | null> = {
  'output-style-turn-reminder': c => writeOutputStyleTurnReminder(c),
  'verbose-property': c => writeVerboseProperty(c),
  'read-default-lines': c => writeReadDefaultLines(c),
  opusplan1m: c => writeOpusplan1m(c),
  'thinking-block-styling': c => writeThinkingBlockStyling(c),
  'fix-lsp-support': c => writeFixLspSupport(c),
  'fix-summarize-from-here': c => writeFixSummarizeFromHere(c),
  'fix-rewind-summary-header': c => writeFixRewindSummaryHeader(c),
  'statusline-update-throttle': c =>
    writeStatuslineUpdateThrottle(c, 300, false),
  'clear-screen': c => writeClearScreen(c),
  'strip-empty-system-reminders': c => writeStripEmptySystemReminders(c),
  'model-customizations': c => writeModelCustomizations(c),
  'show-more-items-in-select-menus': c =>
    writeShowMoreItemsInSelectMenus(c, 25),
  'context-limit': c => writeContextLimit(c),
  'patches-applied-indication': c =>
    writePatchesAppliedIndication(
      c,
      '0.0.0-test',
      ['test: applied'],
      true,
      true
    ),
  'table-format': c => writeTableFormat(c, 'clean'),
  themes: c => writeThemes(c, DEFAULT_SETTINGS.themes),
  'thinking-verbs': c =>
    writeThinkingVerbs(c, ['Ruminating', 'Percolating', 'Noodling']),
  'thinker-format': c => writeThinkerFormat(c, '[{}] '),
  'thinker-symbol-chars': c =>
    writeThinkerSymbolChars(c, DEFAULT_SETTINGS.thinkingStyle.phases),
  'thinker-symbol-speed': c => writeThinkerSymbolSpeed(c, 60),
  'thinker-symbol-width': c =>
    writeThinkerSymbolWidthLocation(
      c,
      // Native spinner cell is width:2. Passing 2 is a same-length no-op that
      // the sweep would score as "applied, 0 bytes" even if the rewrite is a
      // no-op of the native default — use a value that must mutate.
      Math.max(
        4,
        Math.max(...DEFAULT_SETTINGS.thinkingStyle.phases.map(p => p.length)) +
          1
      )
    ),
  'thinker-symbol-mirror': c => writeThinkerSymbolMirrorOption(c, false),
  'input-box-border': c => writeInputBoxBorder(c, true),
  'subagent-models': c =>
    writeSubagentModels(c, {
      plan: 'claude-opus-4-5-20251101',
      explore: 'claude-haiku-4-5-20251001',
      generalPurpose: 'claude-sonnet-4-5-20250929',
    }),
  'thinking-visibility': c => writeThinkingVisibility(c),
  'hide-startup-banner': c => writeHideStartupBanner(c),
  'hide-ctrl-g-to-edit': c => writeHideCtrlGToEdit(c),
  'hide-startup-clawd': c => writeHideStartupClawd(c),
  'increase-file-read-limit': c => writeIncreaseFileReadLimit(c),
  'suppress-line-numbers': c => writeSuppressLineNumbers(c),
  'suppress-rate-limit-options': c => writeSuppressRateLimitOptions(c),
  'token-count-rounding': c => writeTokenCountRounding(c, 100),
  'remember-skill': c => writeRememberSkill(c),
  'agents-md': c => writeAgentsMd(c, DEFAULT_SETTINGS.claudeMdAltNames ?? []),
  'auto-accept-plan-mode': c => writeAutoAcceptPlanMode(c),
  'allow-sudo-bypass-permissions': c => writeAllowBypassPermsInSudo(c),
  'suppress-native-installer-warning': c =>
    writeSuppressNativeInstallerWarning(c),
  'filter-scroll-escape-sequences': c => writeScrollEscapeSequenceFilter(c),
  'max-effort-default': c => writeMaxEffortDefault(c),
  'autonomous-operation-all-models': c => writeAutonomousOperationAllModels(c),
  'auto-mode-classifier-model': c => writeAutoModeClassifierModel(c, 'sonnet'),
  'complexity-router': c =>
    writeComplexityRouter(c, {
      ...DEFAULT_SETTINGS.complexityRouter,
      enabled: true,
    }),
  'fable-plan': c =>
    writeFablePlan(c, { ...DEFAULT_SETTINGS.fablePlan, enabled: true }),
  'allow-custom-agent-models': c => writeAllowCustomAgentModels(c),
  'worktree-mode': c => writeWorktreeMode(c),
  'session-memory': c => writeSessionMemory(c),
  'swap-ripgrep-for-fff': c => writeSwapRipgrepForFff(c, FFF_WRAPPER_PATH),
  'dream-mode': c => writeDreamMode(c),
  'lean-memory-types': c => writeLeanMemoryTypes(c),
  toolsets: c => writeToolsets(c, TEST_TOOLSETS, 'minimal', 'minimal'),
  'mcp-non-blocking': c => writeMcpNonBlocking(c),
  // Native default is 3; passing 3 is a same-token no-op the sweep would
  // score as applied/unchanged. Use a value that must rewrite the digit.
  'mcp-batch-size': c => writeMcpBatchSize(c, 5),
  'user-message-display': c =>
    writeUserMessageDisplay(c, {
      format: ' > {} ',
      styling: [],
      foregroundColor: 'default',
      backgroundColor: 'rgb(28,32,48)',
      borderStyle: 'topBottomBold',
      borderColor: 'rgb(255,32,134)',
      paddingX: 1,
      paddingY: 0,
      fitBoxToContent: false,
    }),
  'input-pattern-highlighters': c =>
    writeInputPatternHighlighters(c, TEST_HIGHLIGHTERS),
  'conversation-title': c => writeConversationTitle(c),
  'voice-mode': c => writeVoiceMode(c, true),
  'channels-mode': c => writeChannelsMode(c),
  'suppress-deferred-tools': c => writeSuppressDeferredTools(c),
  'claudemd-context-once-per-conversation': c =>
    writeClaudemdContextOncePerConversation(c),
};

/**
 * Patches that legitimately return null on a current CC build, with the reason.
 * These are version-gated in `applyCustomization` (their `condition` is false
 * for any modern CC), so the anchor they hunt for genuinely no longer exists —
 * a null here is correct behavior, not drift. Kept as explicit expectations
 * rather than a silent allow-list: if one of these starts matching again, the
 * test flags it so the gate can be revisited.
 */
const EXPECTED_NULL: Partial<Record<PatchId, string>> = {
  'thinking-block-styling':
    'gated to CC < 2.1.26 (CC restyled thinking blocks natively)',
  'thinker-symbol-speed': 'gated to CC < 2.1.27 (spinner interval moved)',
};

/**
 * Patches that legitimately return the file unchanged on a current CC build.
 * A no-op is only acceptable for an id listed here — an undeclared no-op is
 * the silent-dead-anchor class (userMessageDisplay used to return oldFile on
 * match failure, and the sweep scored it "applied, 0 bytes").
 */
const EXPECTED_NOOP: Partial<Record<PatchId, string>> = {
  opusplan1m: 'CC >= 2.1.87 ships "opusplan[1m]" natively',
  'fix-lsp-support':
    'CC ships textDocument/didOpen natively; unimplemented throws are gone',
  'worktree-mode':
    'CC ships EnterWorktree natively; tengu_worktree_mode gate is gone',
  'allow-custom-agent-models':
    'CC >= 2.1.83 accepts any agent model string (no enum/includes gate)',
  'conversation-title':
    'CC ships /rename natively (name:"rename",aliases:["name"])',
};

type Outcome = 'applied' | 'no-op' | 'null';

interface PatchOutcome {
  id: PatchId;
  outcome: Outcome;
  bytesDelta: number;
  parseError: string | null;
}

// ---------------------------------------------------------------------------

const pristine = ENABLED ? findPristineCliJs() : null;
const bun = ENABLED ? findBun() : null;

const skipReason = !ENABLED
  ? 'TWEAKCC_PRISTINE_PATCHES=1 not set — run `pnpm test:pristine`'
  : !pristine
    ? 'no pristine cli.js found (looked for ~/.tweakcc/native-claudejs-orig.js ' +
      'and /tmp/cli-*.js) — run tweakcc --apply once against a local Claude ' +
      'Code install, or drop an extracted cli.js at /tmp/cli-<version>.js'
    : !bun
      ? 'bun not found (needed as the JS parse oracle) — install bun, or set ' +
        'TWEAKCC_BUN_PATH to its binary'
      : null;

describe.skipIf(skipReason !== null)('every patch vs. pristine cli.js', () => {
  const outcomes = new Map<PatchId, PatchOutcome>();
  let scratch = '';
  let oracle: ParseOracle;

  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-pristine-'));
    oracle = makeOracle(bun!, scratch, pristine!.source);

    const source = pristine!.source;
    for (const def of getAllPatchDefinitions()) {
      const id = def.id;
      let result: string | null;
      try {
        result = INVOCATIONS[id](source);
      } catch (error) {
        result = null;
        outcomes.set(id, {
          id,
          outcome: 'null',
          bytesDelta: 0,
          parseError: `threw: ${(error as Error).message}`,
        });
        continue;
      }
      const outcome: Outcome =
        result === null ? 'null' : result === source ? 'no-op' : 'applied';
      outcomes.set(id, {
        id,
        outcome,
        bytesDelta: result === null ? 0 : result.length - source.length,
        parseError:
          outcome === 'applied' ? oracle.check(result!, `patched-${id}`) : null,
      });
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    const pad = (s: string, n: number) => s.padEnd(n);
    const rows = [...outcomes.values()]
      .map(
        o =>
          `  ${pad(o.id, 42)} ${pad(o.outcome, 8)} ${
            o.outcome === 'applied'
              ? `${o.bytesDelta >= 0 ? '+' : ''}${o.bytesDelta} bytes` +
                (o.parseError ? '  PARSE FAILED' : '')
              : o.outcome === 'null'
                ? EXPECTED_NULL[o.id]
                  ? '(expected: ' + EXPECTED_NULL[o.id] + ')'
                  : 'FAILED TO FIND'
                : o.outcome === 'no-op'
                  ? EXPECTED_NOOP[o.id]
                    ? '(expected: ' + EXPECTED_NOOP[o.id] + ')'
                    : 'UNDECLARED NO-OP'
                  : ''
          }`
      )
      .join('\n');
    console.log(
      `\npristine: ${pristine!.path}\noracle:   ${bun!} (Bun.Transpiler)\n${rows}\n`
    );
  }, 1200000);

  it('the parse oracle rejects broken JS', () => {
    expect(
      oracle.check('var a = `unterminated', 'oracle-negative')
    ).not.toBeNull();
  });

  it('the pristine bundle itself parses (oracle control)', () => {
    expect(oracle.check(pristine!.source, 'oracle-control')).toBeNull();
  });

  it('every registered patch has an invocation', () => {
    const registered = getAllPatchDefinitions().map(d => d.id);
    expect([...registered].sort()).toEqual(
      (Object.keys(INVOCATIONS) as PatchId[]).sort()
    );
  });

  it.each(getAllPatchDefinitions().map(d => d.id))(
    '%s finds its anchor and emits parseable JS',
    id => {
      const outcome = outcomes.get(id)!;
      const expectedNull = EXPECTED_NULL[id];
      const expectedNoop = EXPECTED_NOOP[id];

      if (expectedNull) {
        expect(
          outcome.outcome,
          `${id} is recorded in EXPECTED_NULL (${expectedNull}) but now ` +
            'matches again — drop the entry and re-check its version gate'
        ).toBe('null');
        return;
      }

      if (expectedNoop) {
        expect(
          outcome.outcome,
          `${id} is recorded in EXPECTED_NOOP (${expectedNoop}) but now ` +
            'applies or returns null — drop the entry if the feature is ' +
            'gated again, or fix the patch if it should apply'
        ).toBe('no-op');
        return;
      }

      expect(
        outcome.outcome,
        `${id} returned null against the pristine bundle: its regex anchor no ` +
          'longer matches this Claude Code build. Either add a match method ' +
          'for the new shape, or make it a documented no-op if the feature ' +
          'was promoted (see CLAUDE.md, "failed to find")'
      ).not.toBe('null');

      expect(
        outcome.outcome,
        `${id} returned the file unchanged against the pristine bundle, but ` +
          'is not in EXPECTED_NOOP. That is a silent dead-anchor: either ' +
          're-anchor it, or declare the no-op with a reason.'
      ).not.toBe('no-op');

      expect(
        outcome.parseError,
        `${id} spliced JS that Bun cannot parse — this would brick Claude ` +
          `Code on --apply:\n${outcome.parseError}`
      ).toBeNull();
    },
    600000
  );

  it('user-message-display also applies the round+bold sweep fixture', () => {
    const result = writeUserMessageDisplay(pristine!.source, {
      ...DEFAULT_SETTINGS.userMessageDisplay,
      borderStyle: 'round',
      styling: ['bold'],
    });
    expect(result).not.toBeNull();
    expect(result).not.toBe(pristine!.source);
    expect(
      oracle.check(result!, 'patched-user-message-display-sweep')
    ).toBeNull();
  });
});

// The 35-entry system-reminder registry is a SECOND patch surface that
// `getAllPatchDefinitions()` does not enumerate, so the sweep above never
// touched it. CC 2.1.234 routed every reminder filename through a new escaper
// and reworded two bodies, breaking six of these at once — and the first report
// came from a user (skrabe/lobotomized-claude-code#25), because `--apply` only
// runs a reminder whose `.md` exists locally and nothing else exercised them.
// Each entry is driven twice: with its own defaultBody (the vanilla path) and
// suppressed (the empty-body path), against the real pristine bundle.
describe.skipIf(skipReason !== null)(
  'every system-reminder injection vs. pristine cli.js',
  () => {
    const results = new Map<
      string,
      { body: string | null; suppressed: string | null }
    >();

    beforeAll(() => {
      const source = pristine!.source;
      for (const entry of REMINDER_REGISTRY) {
        const { result: body } = substitutePlaceholders(
          entry.defaultBody,
          entry.placeholders
        );
        let applied: string | null;
        let suppressed: string | null;
        try {
          applied = entry.apply(source, body, false);
        } catch (error) {
          applied = null;
          console.error(
            `reminder ${entry.id} threw: ${(error as Error).message}`
          );
        }
        try {
          suppressed = entry.apply(source, body, true);
        } catch (error) {
          suppressed = null;
          console.error(
            `reminder ${entry.id} threw (suppressed): ${(error as Error).message}`
          );
        }
        results.set(entry.id, { body: applied, suppressed });
      }
      const rows = REMINDER_REGISTRY.map(e => {
        const r = results.get(e.id)!;
        const label = (v: string | null) =>
          v === null ? 'NULL' : v === pristine!.source ? 'no-op' : 'applied';
        return `  ${e.id.padEnd(40)} default=${label(r.body).padEnd(8)} suppressed=${label(r.suppressed)}`;
      }).join('\n');
      console.log(
        `reminder registry (${REMINDER_REGISTRY.length} entries) vs ${pristine!.path}:\n${rows}`
      );
    });

    it.each(REMINDER_REGISTRY.map(e => e.id))(
      '%s finds its anchor with its default body and when suppressed',
      id => {
        const r = results.get(id)!;
        expect(
          r.body,
          `reminder ${id} returned null against the pristine bundle with its ` +
            'own defaultBody: its anchor no longer matches this Claude Code ' +
            'build. Re-derive the registry entry from cli.js — and prefer ' +
            'anchoring on the registry KEY and code shape over the English ' +
            'prose, which Anthropic rewords freely.'
        ).not.toBeNull();
        expect(
          r.suppressed,
          `reminder ${id} returned null on the SUPPRESS path (empty body) ` +
            'while the default path matched — the two take different branches ' +
            'and both must find the site.'
        ).not.toBeNull();
      },
      600000
    );
  }
);
