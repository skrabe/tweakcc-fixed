import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// package.json sits two levels up from src/patches/ but one level up from the
// bundled dist/*.mjs chunks, so try both — keeps the reported version pinned
// to the published one instead of a hardcoded literal that drifts.
const _require = createRequire(import.meta.url);
export const TWEAKCC_VERSION: string = (() => {
  try {
    return (_require('../package.json') as { version: string }).version;
  } catch {
    return (_require('../../package.json') as { version: string }).version;
  }
})();

import {
  CONFIG_DIR,
  NATIVE_BINARY_BACKUP_FILE,
  updateConfigFile,
} from '../config';
import { ClaudeCodeInstallationInfo, TweakccConfig } from '../types';
import { debug, replaceFileBreakingHardLinks } from '../utils';
import {
  extractClaudeJsFromNativeInstallation,
  repackNativeInstallation,
} from '../nativeInstallationLoader';
import { DEFAULT_SETTINGS } from '../defaultSettings';

// Notes to patch-writers:
//
// - Always use [$\w]+ instead of \w+ to match identifiers (variable/function names), because at
//   least in Node.js's regex engine, \w+ does not include $, so ABC$, which is a perfectly valid
//   identifier, would not be matched.  The way cli.js is minified, $ frequently appears in global
//   identifiers.
//
// - When starting a regular expression with an identifier name, for example if you're matching a
//   string of the form "someVarName = ...", make sure to put some kind of word boundary at the
//   beginning, e.g. `,` `;` `}` or `{`.  This can **SIGNIFICANTLY** speed up matching, easily
//   bringing a 1.5s search down to 30ms.  **DO NOT** use `\b`, because it doesn't properly treat
//   `$`, which appears in identifiers often, as a word character, so `\b[$\w]+` will NOT match `,$=`.
//

import { writeShowMoreItemsInSelectMenus } from './showMoreItemsInSelectMenus';
import { writeThemes } from './themes';
import { writeContextLimit } from './contextLimit';
import { writeInputBoxBorder } from './inputBorderBox';
import { writeThinkerFormat } from './thinkerFormat';
import { writeThinkerSymbolMirrorOption } from './thinkerMirrorOption';
import { writeThinkerSymbolChars } from './thinkerSymbolChars';
import { writeThinkerSymbolSpeed } from './thinkerSymbolSpeed';
import { writeThinkerSymbolWidthLocation } from './thinkerSymbolWidth';
import { writeThinkingVerbs } from './thinkingVerbs';
import { writeUserMessageDisplay } from './userMessageDisplay';
import { writeInputPatternHighlighters } from './inputPatternHighlighters';
import { writeVerboseProperty } from './verboseProperty';
import { writeModelCustomizations } from './modelSelector';
import { writeOpusplan1m } from './opusplan1m';
import { writeThinkingVisibility } from './thinkingVisibility';
import { writeSubagentModels } from './subagentModels';
import { writePatchesAppliedIndication } from './patchesAppliedIndication';
import { applySystemPrompts } from './systemPrompts';
import { applyInlineBlobOverrides } from './inlineBlobOverrides';
import { writeFixLspSupport } from './fixLspSupport';
import { writeFixSummarizeFromHere } from './fixSummarizeFromHere';
import { writeFixRewindSummaryHeader } from './fixRewindSummaryHeader';
import { writeToolsets } from './toolsets';
import { writeTableFormat } from './tableFormat';
import { writeConversationTitle } from './conversationTitle';
import { writeHideStartupBanner } from './hideStartupBanner';
import { writeHideCtrlGToEdit } from './hideCtrlGToEdit';
import { writeHideStartupClawd } from './hideStartupClawd';
import { writeIncreaseFileReadLimit } from './increaseFileReadLimit';
import { writeSuppressLineNumbers } from './suppressLineNumbers';
import { writeSuppressRateLimitOptions } from './suppressRateLimitOptions';
import { writeSessionMemory } from './sessionMemory';
import { writeDreamMode } from './dreamMode';
import { writeLeanMemoryTypes } from './leanMemoryTypes';
import { writeRememberSkill } from './rememberSkill';
import { writeThinkingBlockStyling } from './thinkingBlockStyling';
import { writeMcpNonBlocking, writeMcpBatchSize } from './mcpStartup';
import { writeStatuslineUpdateThrottle } from './statuslineUpdateThrottle';
import { writeTokenCountRounding } from './tokenCountRounding';
import { writeAgentsMd } from './agentsMd';
import { writeAutoAcceptPlanMode } from './autoAcceptPlanMode';
import { writeAllowBypassPermsInSudo } from './allowBypassPermsInSudo';
import { writeSuppressNativeInstallerWarning } from './suppressNativeInstallerWarning';
import { writeScrollEscapeSequenceFilter } from './scrollEscapeSequenceFilter';
import { writeWorktreeMode } from './worktreeMode';
import { writeAllowCustomAgentModels } from './allowCustomAgentModels';
import { writeMaxEffortDefault } from './maxEffortDefault';
import { writeAutonomousOperationAllModels } from './autonomousOperationAllModels';
import { writeAutoModeClassifierModel } from './autoModeClassifierModel';
import { writeVoiceMode } from './voiceMode';
import { writeChannelsMode } from './channelsMode';
import { writeClearScreen } from './clearScreen';
import { writeReadDefaultLines } from './readDefaultLines';
import { writeSwapRipgrepForFff } from './swapRipgrepForFff';
import { ensureRgFffWrapper } from '../ripgrepFff';
import {
  writeSuppressDeferredTools,
  writeStripEmptySystemReminders,
  writeClaudemdContextOncePerConversation,
} from './systemReminders';
import { applySystemReminderOverrides } from './systemReminderOverrides';
import {
  restoreNativeBinaryFromBackup,
  restoreClijsFromBackup,
} from '../installationBackup';
import { compareVersions } from '../systemPromptSync';

export { showDiff, showPositionalDiff, globalReplace } from './patchDiffing';
export {
  findChalkVar,
  getModuleLoaderFunction,
  getReactModuleNameNonBun,
  getReactModuleFunctionBun,
  getReactVar,
  clearReactVarCache,
  findRequireFunc,
  getRequireFuncName,
  clearRequireFuncNameCache,
  findTextComponent,
  findBoxComponent,
} from './helpers';

export interface LocationResult {
  startIndex: number;
  endIndex: number;
  identifiers?: string[];
}

export interface ModificationEdit {
  startIndex: number;
  endIndex: number;
  newContent: string;
}

// =============================================================================
// Patch Group and Result Types
// =============================================================================

export enum PatchGroup {
  SYSTEM_PROMPTS = 'System Prompts',
  ALWAYS_APPLIED = 'Always Applied',
  MISC_CONFIGURABLE = 'Misc Configurable',
  FEATURES = 'Features',
  SYSTEM_REMINDERS = 'System Reminders',
}

export interface PatchResult {
  id: string;
  name: string;
  group: PatchGroup;
  applied: boolean;
  failed?: boolean;
  skipped?: boolean;
  details?: string;
  description?: string;
}

export interface ApplyCustomizationResult {
  config: TweakccConfig;
  results: PatchResult[];
}

// =============================================================================
// Patch Definitions (Single Source of Truth)
// =============================================================================

/**
 * All patch definitions with their metadata.
 * This is the single source of truth for patch IDs, names, groups, and descriptions.
 */
const PATCH_DEFINITIONS = [
  // Always Applied
  {
    id: 'verbose-property',
    name: 'Verbose property',
    group: PatchGroup.ALWAYS_APPLIED,
    description: 'Token counter will show (2s · ↓ 169 tokens · thinking)',
  },
  {
    id: 'read-default-lines',
    name: 'Read default lines (env-gated)',
    group: PatchGroup.ALWAYS_APPLIED,
    description:
      'Read tool default line cap becomes CLAUDE_CODE_READ_DEFAULT_LINES env var (falls back to 2000 if unset)',
  },
  {
    id: 'opusplan1m',
    name: 'Opusplan[1m] support',
    group: PatchGroup.ALWAYS_APPLIED,
    description:
      'Use the "Opus Plan 1M" model: Opus for planning, Sonnet 1M context for building',
  },
  {
    id: 'thinking-block-styling',
    name: 'Thinking block styling',
    group: PatchGroup.ALWAYS_APPLIED,
    description: 'Restore dim/gray + italic styling for thinking blocks',
  },
  {
    id: 'fix-lsp-support',
    name: 'Fix LSP support',
    group: PatchGroup.ALWAYS_APPLIED,
    description: 'Enable/fix nascent LSP support',
  },
  {
    id: 'fix-summarize-from-here',
    name: 'Fix "Summarize from here"',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Make "Summarize from here" summarize only the messages after the rewind point (feed the slice, not the whole conversation)',
  },
  {
    id: 'fix-rewind-summary-header',
    name: 'Honest rewind summary header',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Label a rewind summary as a deliberate rewind instead of the misleading "ran out of context" header',
  },
  {
    id: 'statusline-update-throttle',
    name: `Statusline update throttling correction`,
    group: PatchGroup.ALWAYS_APPLIED,
    description: `Statusline updates will be properly throttled instead of queued (or debounced)`,
  },
  {
    id: 'clear-screen',
    name: 'Clear screen command',
    group: PatchGroup.ALWAYS_APPLIED,
    description:
      'Register a /clear-screen command that clears the terminal scrollback and redraws without resetting conversation context',
  },
  {
    id: 'strip-empty-system-reminders',
    name: 'Strip empty <system-reminder> wrappers',
    group: PatchGroup.ALWAYS_APPLIED,
    description:
      'Short-circuits CC\'s universal system-reminder wrapper so empty / "(no content)" inputs produce no reminder. Kills the drift-inducing "<system-reminder>(no content)</system-reminder>" blocks that get appended to roughly every other tool call.',
  },
  // Misc Configurable
  {
    id: 'model-customizations',
    name: 'Model customizations',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'Access all Claude models with /model, not just latest 3',
  },
  {
    id: 'show-more-items-in-select-menus',
    name: 'Show more items in select menus',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'Show 25 items in select menus instead of default 5',
  },
  {
    id: 'context-limit',
    name: 'Context limit',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Override the 200K context limit via CLAUDE_CODE_CONTEXT_LIMIT env var (set before launching CC)',
  },
  {
    id: 'patches-applied-indication',
    name: 'Patches applied indication',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'Show "tweakcc patches applied" and tweakcc version inside CC',
  },
  {
    id: 'table-format',
    name: 'Table format',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'Tables generated by Claude will be rendered more compactly',
  },
  {
    id: 'themes',
    name: 'Themes',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'Your custom themes will be available via /theme',
  },
  {
    id: 'thinking-verbs',
    name: 'Thinking verbs',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'Your custom list of thinking verbs will be cycled through',
  },
  {
    id: 'thinker-format',
    name: 'Thinker format',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Your custom format string that thinking verbs are wrapped in will be applied',
  },
  {
    id: 'thinker-symbol-chars',
    name: 'Thinker symbol chars',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'Your custom thinking spinner will be rendered',
  },
  {
    id: 'thinker-symbol-speed',
    name: 'Thinker symbol speed',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'The thinking spinner will play at a custom FPS',
  },
  {
    id: 'thinker-symbol-width',
    name: 'Thinker symbol width',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'The thinking spinner will be in a box of custom width',
  },
  {
    id: 'thinker-symbol-mirror',
    name: 'Thinker symbol mirror',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'The thinking spinner will reverse or restart when it finishes',
  },
  {
    id: 'input-box-border',
    name: 'Input box border',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      "Your custom styles to the main input box's border will be applied",
  },
  {
    id: 'subagent-models',
    name: 'Subagent models',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'Use custom models for Plan, Explore, and General subagents',
  },
  {
    id: 'thinking-visibility',
    name: 'Thinking block visibility',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Thinking blocks outputted by the model will show without Ctrl+O',
  },
  {
    id: 'hide-startup-banner',
    name: 'Hide startup banner',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'CC\'s startup banner with "Clawd" and release notes will be hidden',
  },
  {
    id: 'hide-ctrl-g-to-edit',
    name: 'Hide Ctrl+G to edit',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'Note about using Ctrl+G to edit prompt will be hidden',
  },
  {
    id: 'hide-startup-clawd',
    name: 'Hide startup Clawd',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'The "Clawd" icon on startup will be hidden for a cleaner look',
  },
  {
    id: 'increase-file-read-limit',
    name: 'Increase file read limit',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Max tokens Claude can read from a file at once will be increased',
  },
  {
    id: 'suppress-line-numbers',
    name: 'Suppress line numbers',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      '"1→" "2→" etc. prefixes for each line of Read output will be omitted',
  },
  {
    id: 'suppress-rate-limit-options',
    name: 'Suppress rate limit options',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      "/rate-limit-options won't be injected when limits are reached",
  },
  {
    id: 'token-count-rounding',
    name: 'Token count rounding',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Round displayed token counts to the nearest multiple of chosen value',
  },
  {
    id: 'remember-skill',
    name: 'Remember skill',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Register the built-in "/remember" skill to review session memories and update CLAUDE.local.md',
  },
  {
    id: 'agents-md',
    name: 'AGENTS.md (and others)',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'Support AGENTS.md and others in addition to CLAUDE.md',
  },
  {
    id: 'auto-accept-plan-mode',
    name: 'Auto-accept plan mode',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Automatically accept plans without the "Ready to code?" confirmation prompt',
  },
  {
    id: 'allow-sudo-bypass-permissions',
    name: 'Allow bypassing permissions with --dangerously-skip-permissions in sudo',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Allow bypassing permissions with --dangerously-skip-permissions even when running with root/sudo privileges',
  },
  {
    id: 'suppress-native-installer-warning',
    name: 'Suppress native installer warning',
    group: PatchGroup.MISC_CONFIGURABLE,
    description: 'Suppress the native installer warning message at startup',
  },
  {
    id: 'filter-scroll-escape-sequences',
    name: 'Filter scroll escape sequences',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Filter out terminal escape sequences that cause unwanted scrolling',
  },
  {
    id: 'max-effort-default',
    name: 'Default Opus 4.7 to max effort',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Opus 4.7 sessions default to "max" reasoning effort instead of "xhigh" (override with /effort or CLAUDE_CODE_EFFORT_LEVEL)',
  },
  {
    id: 'autonomous-operation-all-models',
    name: 'Fable/Mythos prompt set (all models)',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Treats your selected model as Fable/Mythos everywhere CC branches on model family (flips the zQ gate): you get the autonomous-operation prompt (proceed without asking for reversible in-scope work; finish the job before ending the turn), the "# Communicating with the user" comms block in place of "# Text output", /loop dynamic-pacing behavior, and brief-mode comms shaping. Per-model feature-flag routing also follows fable but is inert on a local install',
  },
  {
    id: 'auto-mode-classifier-model',
    name: 'Auto-mode classifier model',
    group: PatchGroup.MISC_CONFIGURABLE,
    description:
      'Pin auto-mode bash safety classifier to Sonnet 4.6 or Haiku 4.5 instead of the user main-loop model (avoids Opus 4.7 congestion denying tool calls)',
  },
  // Features
  {
    id: 'allow-custom-agent-models',
    name: 'Allow custom agent models',
    group: PatchGroup.FEATURES,
    description:
      'Allow arbitrary model names in custom agent frontmatter (e.g. gemini-2.5-flash)',
  },
  {
    id: 'worktree-mode',
    name: 'Worktree mode',
    group: PatchGroup.FEATURES,
    description:
      'Enable the EnterWorktree tool for isolated git worktree sessions',
  },
  {
    id: 'session-memory',
    name: 'Session memory',
    group: PatchGroup.FEATURES,
    description:
      'Enable session memory (auto-extraction + past session search)',
  },
  {
    id: 'swap-ripgrep-for-fff',
    name: '[EXPERIMENTAL] fff for Bash search (grep/find/rg → fff)',
    group: PatchGroup.FEATURES,
    description:
      "[EXPERIMENTAL] Route Claude Code's Bash search through fff (fast file finder). CC 2.1.186 shadows the shell `grep`→embedded ugrep and `find`→embedded bfs (and offers `rg`); the agent uses grep ~136x more than rg. This repoints all three at a per-platform fff wrapper that serves, relevance-ranked from a warm-index daemon: literal, regex (RE2 — the dialect the model writes), case-insensitive (-i), multi-word phrases, context (-A/-B/-C), extension globs (-g/--include '*.ts'), and multi-path (app lib scripts) searches. Anything fff can't serve faithfully — PCRE, multiline/newline- or empty-matching regex, only-matching (-o), single-file, non-recursive grep, --no-ignore, find, non-ASCII, lines over 512 bytes, piped stdin → re-exec the real embedded ugrep/bfs/ripgrep. Every engine still ships; any uncertainty falls back, so results never diverge from the model's intent. Transparent (no prompt-compliance reliance) and CC-scoped (the user's own terminal grep/find/rg are untouched). Installs the wrapper into ~/.tweakcc/fff.",
  },
  {
    id: 'dream-mode',
    name: 'Dream mode',
    group: PatchGroup.FEATURES,
    description:
      'Enable dream (/dream + auto-dream background memory consolidation)',
  },
  {
    id: 'lean-memory-types',
    name: 'Lean memory types',
    group: PatchGroup.FEATURES,
    description:
      'Compact "Types of memory" prompt block + on-demand memory-types skill',
  },
  {
    id: 'toolsets',
    name: 'Toolsets',
    group: PatchGroup.FEATURES,
    description: 'Custom toolsets will be registered',
  },
  {
    id: 'mcp-non-blocking',
    name: 'MCP non-blocking',
    group: PatchGroup.FEATURES,
    description: 'If you have MCP servers, CC startup will be much faster',
  },
  {
    id: 'mcp-batch-size',
    name: 'MCP batch size',
    group: PatchGroup.FEATURES,
    description: 'Change the number of MCP servers started in parallel',
  },
  {
    id: 'user-message-display',
    name: 'User message display',
    group: PatchGroup.FEATURES,
    description: 'User messages in the chat history will be styled',
  },
  {
    id: 'input-pattern-highlighters',
    name: 'Input pattern highlighters',
    group: PatchGroup.FEATURES,
    description: 'Custom input highlighters will be registered',
  },
  {
    id: 'conversation-title',
    name: 'Conversation title',
    group: PatchGroup.FEATURES,
    description: '/title command will be created & enabled',
  },
  {
    id: 'voice-mode',
    name: 'Voice mode',
    group: PatchGroup.FEATURES,
    description:
      'Enable /voice command for speech-to-text input (hold Space to record)',
  },
  {
    id: 'channels-mode',
    name: 'Channels mode',
    group: PatchGroup.FEATURES,
    description:
      'Enable MCP channel notifications (--channels without allowlist or dev flag)',
  },
  {
    id: 'suppress-deferred-tools',
    name: 'Suppress deferred tools list (DANGEROUS)',
    group: PatchGroup.SYSTEM_REMINDERS,
    description:
      'Kill the "deferred tools are now available via ToolSearch" announcement. WARNING: MCP/Cron/EnterPlanMode/WebFetch/Monitor become invisible to the model unless explicitly named.',
  },
  {
    id: 'claudemd-context-once-per-conversation',
    name: 'claudeMd context: once per conversation',
    group: PatchGroup.SYSTEM_REMINDERS,
    description:
      'Inject the claudeMd / userEmail / currentDate <system-reminder> only on the first API call per conversation (re-fires after /clear). Default: ON. Toggle OFF for vanilla CC per-turn injection.',
  },
] as const;

/** Union type of all valid patch IDs */
export type PatchId = (typeof PATCH_DEFINITIONS)[number]['id'];

/** Patch definition interface (derived from PATCH_DEFINITIONS) */
export interface PatchDefinition {
  id: PatchId;
  name: string;
  group: PatchGroup;
  description: string;
}

/**
 * Returns the list of all available patches with their IDs, names, groups, and descriptions.
 * Used by --list-patches flag.
 */
export const getAllPatchDefinitions = (): PatchDefinition[] => {
  return [...PATCH_DEFINITIONS];
};

/** Patch implementation with function and optional condition */
interface PatchImplementation {
  fn: (content: string) => string | null;
  condition?: boolean;
}

// =============================================================================
// Legacy types (for backward compatibility with patchesAppliedIndication)
// =============================================================================

export interface PatchApplied {
  newContent: string;
  items: string[];
}

// =============================================================================
// Helper Functions
// =============================================================================

export const escapeIdent = (ident: string): string => {
  return ident.replace(/\$/g, '\\$');
};

/**
 * Apply patches to content using the implementations map, tracking results.
 * @param patchFilter - Optional list of patch IDs to apply (if provided, only matching patches are applied)
 */
const applyPatchImplementations = (
  content: string,
  implementations: Record<PatchId, PatchImplementation>,
  patchFilter?: string[] | null
): { content: string; results: PatchResult[] } => {
  const results: PatchResult[] = [];

  // Process patches in the order defined in PATCH_DEFINITIONS
  for (const def of PATCH_DEFINITIONS) {
    const impl = implementations[def.id];

    // Skip patches not in the filter (if filter is provided)
    if (patchFilter && !patchFilter.includes(def.id)) {
      results.push({
        id: def.id,
        name: def.name,
        group: def.group,
        applied: false,
        skipped: true,
        details: 'not in --patches filter',
        description: def.description,
      });
      continue;
    }

    // Skip patches where condition is explicitly false, but record them as skipped
    if (impl.condition === false) {
      results.push({
        id: def.id,
        name: def.name,
        group: def.group,
        applied: false,
        skipped: true,
        details: 'not enabled',
        description: def.description,
      });
      continue;
    }

    debug(`Applying patch: ${def.name}`);
    const result = impl.fn(content);
    const failed = result === null;
    const applied = !failed && result !== content;

    if (!failed) {
      content = result;
    }

    results.push({
      id: def.id,
      name: def.name,
      group: def.group,
      applied,
      failed,
      description: def.description,
    });
  }

  return { content, results };
};

const assertNativeBinaryStarts = (binaryPath: string) => {
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (
    result.error ||
    result.status !== 0 ||
    /Expected CommonJS module|Bun v|TypeError/.test(output)
  ) {
    const error = new Error(
      `Patched native binary failed startup sanity check (${binaryPath}).\n` +
        output.trim()
    );
    error.stack = error.message;
    throw error;
  }
};

// =============================================================================
// Main Apply Function
// =============================================================================

export const applyCustomization = async (
  config: TweakccConfig,
  ccInstInfo: ClaudeCodeInstallationInfo,
  patchFilter?: string[] | null
): Promise<ApplyCustomizationResult> => {
  let content: string;
  let clearBytecode = false;

  if (ccInstInfo.nativeInstallationPath) {
    // For native installations: restore the binary, then extract to memory
    await restoreNativeBinaryFromBackup(ccInstInfo);

    // Extract from backup if it exists, otherwise from the native installation
    let backupExists = false;
    try {
      await fs.stat(NATIVE_BINARY_BACKUP_FILE);
      backupExists = true;
    } catch {
      // Backup doesn't exist, extract from native installation
    }

    const pathToExtractFrom = backupExists
      ? NATIVE_BINARY_BACKUP_FILE
      : ccInstInfo.nativeInstallationPath;

    debug(
      `Extracting claude.js from ${backupExists ? 'backup' : 'native installation'}: ${pathToExtractFrom}`
    );

    const {
      data: claudeJsBuffer,
      clearBytecode: needsClearBytecode,
      error: extractError,
    } = await extractClaudeJsFromNativeInstallation(
      pathToExtractFrom,
      ccInstInfo.version
    );

    if (!claudeJsBuffer) {
      throw new Error(
        `Failed to extract claude.js from native installation${
          extractError ? `: ${extractError}` : ''
        }`
      );
    }

    clearBytecode = needsClearBytecode;

    const origPath = path.join(CONFIG_DIR, 'native-claudejs-orig.js');
    fsSync.writeFileSync(origPath, claudeJsBuffer);
    debug(`Saved original extracted JS from native to: ${origPath}`);

    content = claudeJsBuffer.toString('utf8');
  } else {
    // For NPM installations: restore cli.js from backup, then read it
    await restoreClijsFromBackup(ccInstInfo);

    if (!ccInstInfo.cliPath) {
      throw new Error('cliPath is required for NPM installations');
    }

    content = await fs.readFile(ccInstInfo.cliPath, { encoding: 'utf8' });
  }

  // Collect all patch results
  const allResults: PatchResult[] = [];

  // Snapshot the binary BEFORE any override splicing. A named system prompt
  // whose text lives inside a region an inline-blob/reminder override consumes
  // (e.g. the "# System" bullets array, the "## Types of memory" arrays) is
  // legitimately gone once that override applies — its curated content was
  // intentionally superseded. applySystemPrompts uses this snapshot to tell
  // that case (matched the pristine binary, clobbered by our own earlier
  // splice → silent skip) apart from genuine anchor drift (never matched the
  // pristine binary → warn), so consumed-region prompts don't raise spurious
  // "Could not find" noise.
  const pristineContent = content;

  // ==========================================================================
  // Apply inline-blob overrides FIRST (prompts not extracted into prompts JSON)
  // Inline-blob overrides replace whole template-literal arrays / template
  // strings. Some named system prompts in prompts-X.Y.Z.json wipe a single
  // <description>...</description> element that lives INSIDE one of those
  // arrays. If the named-prompt wipe ran first, the inline-blob anchor
  // (which uses the original <description> text to disambiguate which of
  // the 4 "## Types of memory" arrays to target) would no longer match.
  // Running inline-blob overrides first means the named-prompt wipes
  // for content already inside an inline-blob target simply no-op.
  // ==========================================================================
  const inlineResult = await applyInlineBlobOverrides(content);
  content = inlineResult.content;
  const appliedInline = inlineResult.results.filter(r => r.applied);
  const failedInline = inlineResult.results.filter(r => r.failed);
  if (inlineResult.results.length > 0) {
    debug(
      `inlineBlobOverrides: ${appliedInline.length} applied, ${failedInline.length} failed`
    );
    for (const r of failedInline) {
      console.log(
        `inline-blob: failed "${r.name}" (${r.filename}): ${r.details}`
      );
    }
  }
  for (const r of inlineResult.results) {
    allResults.push({
      id: `inline-blob:${r.filename}`,
      name: r.name,
      group: PatchGroup.SYSTEM_PROMPTS,
      applied: r.applied,
      failed: r.failed,
      skipped: r.skipped,
      details: r.details,
    });
  }

  // ==========================================================================
  // Apply named system prompt customizations AFTER inline-blob overrides.
  // ==========================================================================
  const reminderResult = await applySystemReminderOverrides(
    content,
    ccInstInfo.version ?? ''
  );
  content = reminderResult.content;
  for (const r of reminderResult.results) {
    allResults.push({
      id: `reminder:${r.id}`,
      name: `Reminder: ${r.name} (${r.state})`,
      group: PatchGroup.SYSTEM_REMINDERS,
      applied: r.applied,
      failed: r.failed,
      skipped: r.skipped,
      details: r.details,
      description: r.description,
    });
  }

  // Apply system prompts unconditionally, including native installs — this fork's
  // lobotomization patches the prompts inside the Bun bundle (upstream skips native
  // here; we don't, because native prompt overrides are the whole point).
  const systemPromptsResult = await applySystemPrompts(
    content,
    ccInstInfo.version,
    undefined, // escapeNonAscii - auto-detect
    patchFilter,
    pristineContent
  );
  content = systemPromptsResult.newContent;

  const sortedSystemPromptResults = [...systemPromptsResult.results].sort(
    (a, b) => a.name.localeCompare(b.name)
  );
  allResults.push(...sortedSystemPromptResults);

  // Legacy items array for patchesAppliedIndication (backward compatibility)
  // Escape ANSI codes so they render properly when injected into cli.js
  const escapeForCliJs = (str: string): string =>
    str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  const legacyItems: string[] = sortedSystemPromptResults
    .filter(r => r.applied && r.details)
    .map(r => escapeForCliJs(`${r.name}: ${r.details}`));

  // Extract config values that are used multiple times or need pre-computation
  const tableFormat = config.settings.misc?.tableFormat ?? 'default';
  const showTweakccVersion = config.settings.misc?.showTweakccVersion ?? true;
  const showPatchesApplied = config.settings.misc?.showPatchesApplied ?? true;

  // ==========================================================================
  // Define patch implementations (keyed by PatchId)
  // ==========================================================================
  // Keep model list customization and select-menu size behavior in sync.
  // Disabling model customizations should restore both selectors to vanilla CC behavior.
  const modelCustomizationsEnabled =
    config.settings.misc?.enableModelCustomizations ?? true;

  // fff swap: install the per-platform wrapper BEFORE patching the resolver. If
  // it can't be obtained for this platform, keep ripgrep — never point the
  // resolver at a missing binary (that would silently disable Grep).
  const swapRipgrepEnabled = !!config.settings.misc?.swapRipgrepForFff;
  let rgFffWrapperPath: string | null = null;
  if (swapRipgrepEnabled) {
    rgFffWrapperPath = await ensureRgFffWrapper();
    if (!rgFffWrapperPath) {
      console.log(
        'patch: swapRipgrepForFff: no fff wrapper available for this platform — keeping ripgrep'
      );
    }
  }

  const patchImplementations: Record<PatchId, PatchImplementation> = {
    // Always Applied
    'verbose-property': {
      fn: c => writeVerboseProperty(c),
      condition: !ccInstInfo.nativeInstallationPath,
    },
    'read-default-lines': {
      fn: c => writeReadDefaultLines(c),
    },
    'context-limit': {
      fn: c => writeContextLimit(c),
      condition: !!config.settings.misc?.enableContextLimitOverride,
    },
    opusplan1m: {
      fn: c => writeOpusplan1m(c),
      condition:
        modelCustomizationsEnabled && !ccInstInfo.nativeInstallationPath,
    },
    'thinking-block-styling': {
      fn: c => writeThinkingBlockStyling(c),
      condition:
        ccInstInfo.version == null ||
        compareVersions(ccInstInfo.version, '2.1.26') < 0,
    },
    'fix-lsp-support': {
      fn: c => writeFixLspSupport(c),
    },
    'fix-summarize-from-here': {
      fn: c => writeFixSummarizeFromHere(c),
      condition: config.settings.misc?.fixSummarizeFromHere !== false,
    },
    'fix-rewind-summary-header': {
      fn: c => writeFixRewindSummaryHeader(c),
      condition: config.settings.misc?.fixRewindSummaryHeader !== false,
    },
    'statusline-update-throttle': {
      fn: c =>
        writeStatuslineUpdateThrottle(
          c,
          config.settings.misc?.statuslineThrottleMs ?? 300,
          config.settings.misc?.statuslineUseFixedInterval ?? false
        ),
      condition: config.settings.misc?.statuslineThrottleMs != null,
    },
    'clear-screen': {
      fn: c => writeClearScreen(c),
    },
    'strip-empty-system-reminders': {
      fn: c => writeStripEmptySystemReminders(c),
    },
    // Misc Configurable
    'patches-applied-indication': {
      fn: c =>
        writePatchesAppliedIndication(
          c,
          TWEAKCC_VERSION,
          legacyItems,
          showTweakccVersion,
          showPatchesApplied
        ),
    },
    'model-customizations': {
      fn: c => writeModelCustomizations(c),
      condition: modelCustomizationsEnabled,
    },
    'show-more-items-in-select-menus': {
      fn: c => writeShowMoreItemsInSelectMenus(c, 25),
      condition: modelCustomizationsEnabled,
    },
    'table-format': {
      fn: c => writeTableFormat(c, tableFormat),
      condition: tableFormat !== 'default',
    },
    themes: {
      fn: c => writeThemes(c, config.settings.themes!),
      condition: !!(
        config.settings.themes &&
        config.settings.themes.length > 0 &&
        JSON.stringify(config.settings.themes) !==
          JSON.stringify(DEFAULT_SETTINGS.themes)
      ),
    },
    'thinking-verbs': {
      fn: c => writeThinkingVerbs(c, config.settings.thinkingVerbs!.verbs),
      condition:
        !!config.settings.thinkingVerbs &&
        JSON.stringify(config.settings.thinkingVerbs.verbs) !==
          JSON.stringify(DEFAULT_SETTINGS.thinkingVerbs.verbs),
    },
    'thinker-format': {
      fn: c => writeThinkerFormat(c, config.settings.thinkingVerbs!.format),
      condition:
        !!config.settings.thinkingVerbs &&
        config.settings.thinkingVerbs.format !==
          DEFAULT_SETTINGS.thinkingVerbs.format,
    },
    'thinker-symbol-chars': {
      fn: c => writeThinkerSymbolChars(c, config.settings.thinkingStyle.phases),
      condition:
        JSON.stringify(config.settings.thinkingStyle.phases) !==
        JSON.stringify(DEFAULT_SETTINGS.thinkingStyle.phases),
    },
    'thinker-symbol-speed': {
      fn: c =>
        writeThinkerSymbolSpeed(
          c,
          config.settings.thinkingStyle.updateInterval
        ),
      condition:
        config.settings.thinkingStyle.updateInterval !==
          DEFAULT_SETTINGS.thinkingStyle.updateInterval &&
        (ccInstInfo.version == null ||
          compareVersions(ccInstInfo.version, '2.1.27') < 0),
    },
    'thinker-symbol-width': {
      fn: c =>
        writeThinkerSymbolWidthLocation(
          c,
          Math.max(...config.settings.thinkingStyle.phases.map(p => p.length)) +
            1
        ),
      condition:
        JSON.stringify(config.settings.thinkingStyle.phases) !==
        JSON.stringify(DEFAULT_SETTINGS.thinkingStyle.phases),
    },
    'thinker-symbol-mirror': {
      fn: c =>
        writeThinkerSymbolMirrorOption(
          c,
          config.settings.thinkingStyle.reverseMirror
        ),
      condition:
        config.settings.thinkingStyle.reverseMirror !==
        DEFAULT_SETTINGS.thinkingStyle.reverseMirror,
    },
    'input-box-border': {
      fn: c => writeInputBoxBorder(c, config.settings.inputBox!.removeBorder),
      condition: !!(
        config.settings.inputBox &&
        config.settings.inputBox.removeBorder !==
          DEFAULT_SETTINGS.inputBox.removeBorder
      ),
    },
    'subagent-models': {
      fn: c => writeSubagentModels(c, config.settings.subagentModels!),
      condition:
        !!config.settings.subagentModels &&
        JSON.stringify(config.settings.subagentModels) !==
          JSON.stringify(DEFAULT_SETTINGS.subagentModels),
    },
    'thinking-visibility': {
      fn: c => writeThinkingVisibility(c),
      condition: config.settings.misc?.expandThinkingBlocks ?? true,
    },
    'hide-startup-banner': {
      fn: c => writeHideStartupBanner(c),
      condition: !!config.settings.misc?.hideStartupBanner,
    },
    'hide-ctrl-g-to-edit': {
      fn: c => writeHideCtrlGToEdit(c),
      condition: !!config.settings.misc?.hideCtrlGToEdit,
    },
    'hide-startup-clawd': {
      fn: c => writeHideStartupClawd(c),
      condition: !!config.settings.misc?.hideStartupClawd,
    },
    'increase-file-read-limit': {
      fn: c => writeIncreaseFileReadLimit(c),
      condition: !!config.settings.misc?.increaseFileReadLimit,
    },
    'suppress-line-numbers': {
      fn: c => writeSuppressLineNumbers(c),
      condition: !!config.settings.misc?.suppressLineNumbers,
    },
    'suppress-rate-limit-options': {
      fn: c => writeSuppressRateLimitOptions(c),
      condition: !!config.settings.misc?.suppressRateLimitOptions,
    },
    'token-count-rounding': {
      fn: c =>
        writeTokenCountRounding(c, config.settings.misc!.tokenCountRounding!),
      condition: !!config.settings.misc?.tokenCountRounding,
    },
    'remember-skill': {
      fn: c => writeRememberSkill(c),
      condition: !!config.settings.misc?.enableRememberSkill,
    },
    'agents-md': {
      fn: c => writeAgentsMd(c, config.settings.claudeMdAltNames!),
      condition: !!(
        config.settings.claudeMdAltNames &&
        config.settings.claudeMdAltNames.length > 0
      ),
    },
    'auto-accept-plan-mode': {
      fn: c => writeAutoAcceptPlanMode(c),
      condition: !!config.settings.misc?.autoAcceptPlanMode,
    },
    'allow-sudo-bypass-permissions': {
      fn: c => writeAllowBypassPermsInSudo(c),
      condition: !!config.settings.misc?.allowBypassPermissionsInSudo,
    },
    'suppress-native-installer-warning': {
      fn: c => writeSuppressNativeInstallerWarning(c),
      condition: !!config.settings.misc?.suppressNativeInstallerWarning,
    },
    'filter-scroll-escape-sequences': {
      fn: c => writeScrollEscapeSequenceFilter(c),
      condition: !!config.settings.misc?.filterScrollEscapeSequences,
    },
    'max-effort-default': {
      fn: c => writeMaxEffortDefault(c),
      condition: !!config.settings.misc?.maxEffortDefault,
    },
    'autonomous-operation-all-models': {
      fn: c => writeAutonomousOperationAllModels(c),
      condition: !!config.settings.misc?.autonomousOperationAllModels,
    },
    'auto-mode-classifier-model': {
      fn: c =>
        writeAutoModeClassifierModel(
          c,
          config.settings.misc?.autoModeClassifierModel ?? 'default'
        ),
      condition:
        (config.settings.misc?.autoModeClassifierModel ?? 'default') !==
        'default',
    },
    // Features
    'allow-custom-agent-models': {
      fn: c => writeAllowCustomAgentModels(c),
      condition: !!config.settings.misc?.allowCustomAgentModels,
    },
    'worktree-mode': {
      fn: c => writeWorktreeMode(c),
      condition: !!config.settings.misc?.enableWorktreeMode,
    },
    'session-memory': {
      fn: c => writeSessionMemory(c),
      condition: !!config.settings.misc?.enableSessionMemory,
    },
    'swap-ripgrep-for-fff': {
      // condition gates non-null, so the assertion is honest (vs `as string`,
      // which would also silently accept null).
      fn: c => writeSwapRipgrepForFff(c, rgFffWrapperPath!),
      condition: swapRipgrepEnabled && !!rgFffWrapperPath,
    },
    'dream-mode': {
      fn: c => writeDreamMode(c),
      condition: !!config.settings.misc?.enableDreamMode,
    },
    'lean-memory-types': {
      fn: c => writeLeanMemoryTypes(c),
      condition: !!config.settings.misc?.enableLeanMemoryTypes,
    },
    toolsets: {
      fn: c =>
        writeToolsets(
          c,
          config.settings.toolsets!,
          config.settings.defaultToolset,
          config.settings.planModeToolset
        ),
      condition: !!(
        config.settings.toolsets && config.settings.toolsets.length > 0
      ),
    },
    'mcp-non-blocking': {
      fn: c => writeMcpNonBlocking(c),
      condition:
        !!config.settings.misc?.mcpConnectionNonBlocking &&
        (ccInstInfo.version == null ||
          compareVersions(ccInstInfo.version, '2.1.85') < 0),
    },
    'mcp-batch-size': {
      fn: c => writeMcpBatchSize(c, config.settings.misc!.mcpServerBatchSize!),
      condition: !!config.settings.misc?.mcpServerBatchSize,
    },
    'user-message-display': {
      fn: c => writeUserMessageDisplay(c, config.settings.userMessageDisplay!),
      // Runs on native installs too: the memoized-child pattern matches the
      // Bun-bundled cli.js (verified on CC 2.1.165 darwin-arm64), and the
      // replacement is a self-contained, balanced createElement expression, so
      // it survives native repack. (Was NPM-only — that gate silently disabled
      // the border when the install moved nvm/NPM → mise/native.)
      condition: !!(
        config.settings.userMessageDisplay &&
        JSON.stringify(config.settings.userMessageDisplay) !==
          JSON.stringify(DEFAULT_SETTINGS.userMessageDisplay)
      ),
    },
    'input-pattern-highlighters': {
      fn: c =>
        writeInputPatternHighlighters(
          c,
          config.settings.inputPatternHighlighters!
        ),
      condition: !!(
        config.settings.inputPatternHighlighters &&
        config.settings.inputPatternHighlighters.length > 0
      ),
    },
    'conversation-title': {
      fn: c => writeConversationTitle(c),
      condition:
        (config.settings.misc?.enableConversationTitle ?? true) &&
        !ccInstInfo.nativeInstallationPath,
    },
    'voice-mode': {
      fn: c =>
        writeVoiceMode(
          c,
          config.settings.misc?.enableVoiceConciseOutput ?? true
        ),
      condition: !!config.settings.misc?.enableVoiceMode,
    },
    'channels-mode': {
      fn: c => writeChannelsMode(c),
      condition: !!config.settings.misc?.enableChannelsMode,
    },
    'suppress-deferred-tools': {
      fn: c => writeSuppressDeferredTools(c),
      condition: !!config.settings.misc?.suppressDeferredTools,
    },
    'claudemd-context-once-per-conversation': {
      fn: c => writeClaudemdContextOncePerConversation(c),
      condition:
        config.settings.misc?.claudemdContextOncePerConversation ?? true,
    },
  };

  // ==========================================================================
  // Apply all patches
  // ==========================================================================
  const { content: patchedContent, results: patchResults } =
    applyPatchImplementations(content, patchImplementations, patchFilter);
  content = patchedContent;
  allResults.push(...patchResults);

  const failedBinaryPatches = patchResults.filter(r => r.failed);
  if (ccInstInfo.nativeInstallationPath && failedBinaryPatches.length > 0) {
    const error = new Error(
      `Refusing to repack the native binary: ${failedBinaryPatches.length} ` +
        `binary patch(es) failed (${failedBinaryPatches
          .map(r => r.id)
          .join(', ')}) on Claude Code ${ccInstInfo.version}. The binary was ` +
        'left unchanged — your Claude Code still works. Each failure’s cause ' +
        'is in the "patch: … failed to …" line(s) above; this usually means ' +
        `Anthropic changed the code shape in CC ${ccInstInfo.version}, so a ` +
        'patch’s pattern no longer matches. Update tweakcc-fixed, or disable ' +
        'the failing optional patch(es) in ~/.tweakcc/config.json, then ' +
        're-run --apply.'
    );
    error.stack = error.message;
    throw error;
  }

  // ==========================================================================
  // Write the modified content back
  // ==========================================================================
  if (ccInstInfo.nativeInstallationPath) {
    // For native installations: repack the modified claude.js back into the binary
    debug(
      `Repacking modified claude.js into native installation: ${ccInstInfo.nativeInstallationPath}`
    );

    // Save patched JS for debugging
    const patchedPath = path.join(CONFIG_DIR, 'native-claudejs-patched.js');
    fsSync.writeFileSync(patchedPath, content, 'utf8');
    debug(`Saved patched JS from native to: ${patchedPath}`);

    const modifiedBuffer = Buffer.from(content, 'utf8');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tweakcc-native-'));
    const tempBinaryPath = path.join(
      tempDir,
      path.basename(ccInstInfo.nativeInstallationPath)
    );

    try {
      await fs.copyFile(ccInstInfo.nativeInstallationPath, tempBinaryPath);
      await fs.chmod(
        tempBinaryPath,
        fsSync.statSync(ccInstInfo.nativeInstallationPath).mode
      );
      await repackNativeInstallation(
        tempBinaryPath,
        modifiedBuffer,
        tempBinaryPath,
        clearBytecode
      );
      assertNativeBinaryStarts(tempBinaryPath);
      // Land the repacked binary via an atomic same-directory rename so the live
      // path gets a NEW inode. An in-place copyFile reuses the target's inode,
      // which leaves macOS's cached code-signature for that vnode stale -> the
      // next `claude` exec dies with a silent SIGKILL (Code Signature Invalid).
      // A rename is also the safe way to swap a binary that may be executing.
      const finalPath = ccInstInfo.nativeInstallationPath;
      const stagedPath = path.join(
        path.dirname(finalPath),
        `.${path.basename(finalPath)}.tweakcc-${process.pid}`
      );
      try {
        await fs.copyFile(tempBinaryPath, stagedPath);
        await fs.chmod(stagedPath, fsSync.statSync(finalPath).mode);
        await fs.rename(stagedPath, finalPath);
      } catch (e) {
        await fs.rm(stagedPath, { force: true });
        throw e;
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  } else {
    // For NPM installations: replace the cli.js file
    if (!ccInstInfo.cliPath) {
      throw new Error('cliPath is required for NPM installations');
    }

    // Unlike native (which refuses to repack on any failure above), the npm
    // path writes a partially-patched cli.js. Recap which patches were skipped
    // so the agent/user isn't left guessing why a feature didn't take.
    if (failedBinaryPatches.length > 0) {
      console.warn(
        `tweakcc: ${failedBinaryPatches.length} patch(es) did not apply on ` +
          `Claude Code ${ccInstInfo.version}: ${failedBinaryPatches
            .map(r => r.id)
            .join(', ')}. Those feature(s) are skipped; everything else was ` +
          'applied. Each cause is in the "patch: … failed to …" line(s) ' +
          'above — usually a CC version whose code shape a patch does not ' +
          'match yet. Update tweakcc-fixed, or disable the failing optional ' +
          'patch(es) in ~/.tweakcc/config.json.'
      );
    }

    await replaceFileBreakingHardLinks(ccInstInfo.cliPath, content, 'patch');
  }

  const updatedConfig = await updateConfigFile(cfg => {
    cfg.changesApplied = true;
  });

  return {
    config: updatedConfig,
    results: allResults,
  };
};
