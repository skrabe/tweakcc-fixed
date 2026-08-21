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
import { writeAdhdOutputStyle } from './adhdOutputStyle';
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
import { writeIgnoreWhitespaceEdit } from './ignoreWhitespaceEdit';
import { applyThinkingTextTransition } from './thinkingTextTransition';
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

const ORACLE_SCRIPT = `
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
new Bun.Transpiler({ loader: 'js' }).transformSync(src);
`;

interface ParseOracle {
  /** Returns null when the source parses, or the parse error text. */
  check(source: string, label: string): string | null;
}

const makeOracle = (bun: string, scratch: string): ParseOracle => {
  const scriptPath = path.join(scratch, 'parse-oracle.js');
  fs.writeFileSync(scriptPath, ORACLE_SCRIPT, 'utf8');
  return {
    check(source, label) {
      const srcPath = path.join(scratch, `${label}.js`);
      fs.writeFileSync(srcPath, source, 'utf8');
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
  'adhd-output-style': c => writeAdhdOutputStyle(c),
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
      Math.max(...DEFAULT_SETTINGS.thinkingStyle.phases.map(p => p.length)) + 1
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
  'ignore-whitespace-edit': c => writeIgnoreWhitespaceEdit(c),
  'thinking-text-transition': c => applyThinkingTextTransition(c),
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
  'mcp-batch-size': c => writeMcpBatchSize(c, 3),
  'user-message-display': c =>
    writeUserMessageDisplay(c, {
      ...DEFAULT_SETTINGS.userMessageDisplay,
      borderStyle: 'round',
      styling: ['bold'],
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

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-pristine-'));
    oracle = makeOracle(bun!, scratch);

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
                : ''
          }`
      )
      .join('\n');
    console.log(
      `\npristine: ${pristine!.path}\noracle:   ${bun!} (Bun.Transpiler)\n${rows}\n`
    );
  }, 600000);

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

      if (expectedNull) {
        expect(
          outcome.outcome,
          `${id} is recorded in EXPECTED_NULL (${expectedNull}) but now ` +
            'matches again — drop the entry and re-check its version gate'
        ).toBe('null');
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
        outcome.parseError,
        `${id} spliced JS that Bun cannot parse — this would brick Claude ` +
          `Code on --apply:\n${outcome.parseError}`
      ).toBeNull();
    },
    600000
  );
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
