#!/usr/bin/env node
import { render } from 'ink';
import { Command } from 'commander';
import chalk from 'chalk';

import App from './ui/App';
import {
  CONFIG_FILE,
  readConfigFile,
  readConfigFileForDetection,
  updateConfigFile,
  fetchConfigFromUrl,
} from './config';
import {
  enableDebug,
  enableVerbose,
  enableShowUnchanged,
  isShowUnchanged,
} from './utils';
import {
  applyCustomization,
  PatchResult,
  PatchGroup,
  getAllPatchDefinitions,
  TWEAKCC_VERSION,
  TWEAKCC_SUPPORTED_CC,
} from './patches/index';
import {
  preloadStringsFile,
  getSystemPromptDefinitions,
} from './systemPromptSync';
import {
  newestLocalPromptsVersion,
  resolveFetchVersion,
} from './systemPromptDownload';
import { migrateConfigIfNeeded } from './migration';
import { completeStartupCheck, startupCheck } from './startup';
import {
  formatNotFoundError,
  findClaudeCodeInstallation,
  getPendingCandidates,
  InstallationDetectionError,
  selectAndSaveInstallation,
} from './installationDetection';
import { InstallationPicker } from './ui/components/InstallationPicker';
import {
  InstallationCandidate,
  ClaudeCodeInstallationInfo,
  StartupCheckInfo,
  TweakccConfig,
} from './types';
import { handleUnpack, handleRepack, handleAdhocPatch } from './commands';
import { resolvePatchFilter } from './patchFilter';
import {
  restoreClijsFromBackup,
  restoreNativeBinaryFromBackup,
} from './installationBackup';
import { clearAllAppliedHashes } from './systemPromptHashIndex';
import {
  formatPreflightFinding,
  loadShadowDeclarations,
  runSystemPromptPreflight,
} from './systemPromptPreflight';
import {
  loadPristineBundleFromFile,
  resolvePristineBundle,
} from './systemPromptPristine';

// =============================================================================
// Invocation Command Detection
// =============================================================================

/**
 * Detects how the user invoked tweakcc-fixed to show the correct --apply command.
 * Handles: tweakcc-fixed, npx tweakcc-fixed, pnpm dlx tweakcc-fixed, etc.
 */
function getInvocationCommand(): string {
  const args = process.argv;

  // args[0] is the node executable, args[1] is the script path
  // For npx/pnpm/yarn, the script path often contains clues
  const scriptPath = args[1] || '';

  // Check for package manager dlx/npx patterns in the path
  if (scriptPath.includes('npx') || scriptPath.includes('.npm/_npx')) {
    return 'npx tweakcc-fixed';
  }
  if (scriptPath.includes('pnpm') || scriptPath.includes('.pnpm')) {
    return 'pnpm dlx tweakcc-fixed';
  }
  if (scriptPath.includes('yarn')) {
    return 'yarn dlx tweakcc-fixed';
  }
  if (scriptPath.includes('bun')) {
    return 'bunx tweakcc-fixed';
  }

  // Default to the bare bin name (globally installed or via PATH)
  return 'tweakcc-fixed';
}

// =============================================================================
// Patch Results Display
// =============================================================================

/**
 * Prints patch results to console, organized by group.
 * Respects --show-unchanged flag for filtering.
 * @param results - The patch results to display
 * @param patchFilter - Optional list of explicitly requested patch IDs (always shown even if skipped)
 */
function printPatchResults(
  results: PatchResult[],
  patchFilter?: string[] | null
): void {
  // Define group order for display
  const groupOrder = [
    PatchGroup.SYSTEM_PROMPTS,
    PatchGroup.ALWAYS_APPLIED,
    PatchGroup.MISC_CONFIGURABLE,
    PatchGroup.FEATURES,
    PatchGroup.SYSTEM_REMINDERS,
  ];

  // Group results by PatchGroup
  const byGroup = new Map<PatchGroup, PatchResult[]>();
  for (const group of groupOrder) {
    byGroup.set(group, []);
  }
  for (const result of results) {
    const groupResults = byGroup.get(result.group);
    if (groupResults) {
      groupResults.push(result);
    }
  }

  console.log(
    '\nPatches applied (run with --show-unchanged to show all patches):'
  );

  for (const group of groupOrder) {
    const groupResults = byGroup.get(group)!;

    // Filter based on --show-unchanged (but always show applied, failed, or explicitly requested)
    const filtered = groupResults.filter(
      r =>
        r.applied ||
        r.failed ||
        r.partial ||
        isShowUnchanged() ||
        (patchFilter && patchFilter.includes(r.id))
    );
    if (filtered.length === 0) continue;

    console.log(`\n  ${chalk.bold(group)}:`);

    for (const result of filtered) {
      const status = result.failed
        ? chalk.red('✗')
        : result.partial
          ? chalk.yellow('⚠')
          : result.applied
            ? chalk.green('✓')
            : chalk.dim('○');
      const details = result.details ? `: ${result.details}` : '';
      // Show description in gray on the same line for applied patches only
      const description =
        result.applied && result.description
          ? ` ${chalk.gray('—')} ${chalk.gray(result.description)}`
          : '';
      console.log(`    ${status} ${result.name}${details}${description}`);
    }
  }

  console.log('');
}

/**
 * After an apply, surface the patches that changed model-facing behavior (what
 * reaches the model / how it reasons) rather than just output styling. Several
 * of these are on by default with no menu toggle, so without this notice they
 * would activate on a bare `--apply` with no signal. This is informational
 * only — no prompt — because `--apply` runs non-interactively (CI, the npx VPS
 * legs) and a confirm would hang those.
 */
function printModelFacingNotice(results: PatchResult[]): void {
  const modelFacing = results.filter(r => r.applied && r.modelFacing);
  if (modelFacing.length === 0) return;

  console.log(
    chalk.yellow(
      'ℹ These applied patches change model-facing behavior (not just output styling):'
    )
  );
  for (const r of modelFacing) {
    const description = r.description
      ? ` ${chalk.dim('—')} ${r.description}`
      : '';
    console.log(`    ${chalk.yellow('•')} ${r.name}${chalk.dim(description)}`);
  }
  console.log(
    chalk.dim(
      '  Several are on by default. Toggle any off in the menu or ~/.tweakcc/config.json, or run --restore to revert everything.'
    )
  );
  console.log('');
}

const main = async () => {
  const program = new Command();
  program
    .name('tweakcc-fixed')
    .description(
      'Maintained fork of tweakcc — customize and patch your installed Claude Code (system-prompt overrides, themes, thinking verbs and more).'
    )
    .version(TWEAKCC_VERSION)
    .option('-d, --debug', 'enable debug mode')
    .option('-v, --verbose', 'enable verbose debug mode (includes diffs)')
    .option('--show-unchanged', 'show unchanged diffs (requires --verbose)')
    .option('-a, --apply', 'apply saved customizations without interactive UI')
    .option('--restore', 'restore Claude Code to its original state')
    .option(
      '--revert',
      'restore Claude Code to its original state (alias for --restore)'
    )
    .option(
      '--patches <ids>',
      'comma-separated list of patch or system prompt IDs to apply (use with --apply)'
    )
    .option('--list-patches', 'list all available patches with their IDs')
    .option(
      '--json',
      'with --list-patches: output machine-readable JSON (id, name, group, description)'
    )
    .option(
      '--list-system-prompts [version]',
      'list all available system prompts for a CC version'
    )
    .option(
      '--fetch-system-prompts [version]',
      'download a Claude Code version’s system prompts into the cache, then print that version (defaults to the Claude Code version this release supports)'
    )
    .option(
      '--validate-system-prompts [cliJsPath]',
      'dry-run the apply preflight over the system-prompt overrides (no writes)'
    )
    .option(
      '--config-url <url>',
      'fetch configuration from a URL instead of local config.json'
    )
    .action(async () => {
      // This action handles the default case (no subcommand).
      // All the --flag handling lives here so that Commander's subcommand
      // support doesn't swallow the no-args invocation.
      const options = program.opts();

      if (options.verbose) {
        enableVerbose();
      } else if (options.debug) {
        enableDebug();
      }

      if (options.showUnchanged) {
        enableShowUnchanged();
      }

      // Migrate old ccInstallationDir config to ccInstallationPath if needed
      const configMigrated =
        options.apply && options.patches
          ? false
          : await migrateConfigIfNeeded();

      // Check for conflicting flags
      if (options.apply && (options.restore || options.revert)) {
        console.error(
          chalk.red(
            'Error: Cannot use --apply and --restore/--revert together.'
          )
        );
        process.exit(1);
      }

      // Handle --list-patches flag
      if (options.listPatches) {
        handleListPatches(Boolean(options.json));
        return;
      }

      // Handle --list-system-prompts flag
      if (options.listSystemPrompts !== undefined) {
        await handleListSystemPrompts(
          options.listSystemPrompts as string | true
        );
        return;
      }

      // Handle --validate-system-prompts flag
      if (options.validateSystemPrompts !== undefined) {
        await handleValidateSystemPrompts(
          options.validateSystemPrompts as string | true
        );
        return;
      }

      // Handle --fetch-system-prompts: download a version's prompts into the
      // cache, then print that version. Only the version reaches stdout, so
      // `claude install "$(tweakcc-fixed --fetch-system-prompts)"` is safe;
      // progress and errors go to stderr, and a failed download exits non-zero
      // having printed nothing. Printing after the download is what makes the
      // version a receipt: the prompts are on disk, so a later --apply cannot
      // fail for want of them even if the network has gone by then.
      if (options.fetchSystemPrompts !== undefined) {
        const requested =
          typeof options.fetchSystemPrompts === 'string'
            ? options.fetchSystemPrompts
            : undefined;

        // TWEAKCC_SUPPORTED_CC is typed as a string but read from package.json,
        // so a checkout predating the field yields undefined here, which is the
        // case resolveFetchVersion's last source covers.
        const declared: string | undefined = TWEAKCC_SUPPORTED_CC;
        const version = resolveFetchVersion(
          requested,
          declared,
          newestLocalPromptsVersion
        );
        if (!version) {
          console.error(
            'Error: no version given, and this build neither declares a supported Claude Code version nor carries prompt data to take the newest from. Pass a version, e.g. --fetch-system-prompts 2.1.276.'
          );
          process.exit(1);
        }

        console.error(`Fetching system prompts for Claude Code ${version}...`);
        const fetched = await preloadStringsFile(version);
        if (!fetched.success) {
          console.error(`Error: ${fetched.errorMessage}`);
          process.exit(1);
        }
        console.log(version);
        return;
      }

      // Handle --apply flag for non-interactive mode
      if (options.apply) {
        await handleApplyMode(
          options.patches as string | undefined,
          options.configUrl
        );
        return;
      }

      // --config-url is only valid with --apply
      if (options.configUrl) {
        console.error(
          chalk.red('Error: --config-url can only be used with --apply.')
        );
        console.error(
          chalk.gray(
            'The interactive TUI is for editing local configuration only.'
          )
        );
        console.error(chalk.gray('To apply a remote config, use:'));
        console.error(
          chalk.gray(`  ${getInvocationCommand()} --apply --config-url <url>`)
        );
        process.exit(1);
      }

      // Handle --restore or --revert flags for non-interactive mode
      if (options.restore || options.revert) {
        await handleRestoreMode();
        return;
      }

      // Interactive mode
      await handleInteractiveMode(configMigrated);
    });

  // =========================================================================
  // Subcommands
  // =========================================================================

  program
    .command('unpack')
    .argument('<output-js-path>', 'path to write extracted JS')
    .argument('[binary-path]', 'path to native binary (default: auto-detect)')
    .description('Extract JS from a native Claude Code binary')
    .action(async (outputJsPath: string, binaryPath?: string) => {
      await handleUnpack(outputJsPath, binaryPath);
      process.exit(0);
    });

  program
    .command('repack')
    .argument('<input-js-path>', 'path to JS file to embed')
    .argument('[binary-path]', 'path to native binary (default: auto-detect)')
    .description('Embed JS into a native Claude Code binary')
    .action(async (inputJsPath: string, binaryPath?: string) => {
      await handleRepack(inputJsPath, binaryPath);
      process.exit(0);
    });

  program
    .command('adhoc-patch')
    .description('Apply an ad-hoc patch to Claude Code')
    .option(
      '-s, --string <values...>',
      'replace string: <old-string> <new-string>'
    )
    .option('-r, --regex <values...>', 'replace regex: <pattern> <replacement>')
    .option(
      '--script <script>',
      'run a patch script (prefix with @ for file/URL)'
    )
    .option(
      '-i, --index <number>',
      'replace only the Nth occurrence (1-based)',
      parseInt
    )
    .option(
      '-p, --path <path>',
      'path to cli.js or native binary (default: auto-detect)'
    )
    .option(
      '--confirm-possible-dangerous-patch',
      'skip diff preview and apply immediately'
    )
    .option(
      '--dangerous-no-script-sandbox',
      'run --script without the Node.js permission sandbox (use if Node < 20)'
    )
    .action(
      async (options: {
        string?: string[];
        regex?: string[];
        script?: string;
        index?: number;
        path?: string;
        confirmPossibleDangerousPatch?: boolean;
        dangerousNoScriptSandbox?: boolean;
      }) => {
        await handleAdhocPatch(options);
        process.exit(0);
      }
    );

  program.parse();
};

function exitInvalidPatchFilter(
  error: string,
  version?: string,
  promptsAvailable = true
): never {
  console.error(chalk.red(`Error: ${error}`));
  if (version && !promptsAvailable) {
    console.error(
      chalk.gray(
        `The system prompts for ${version} could not be loaded, so only patch IDs are known.`
      )
    );
  }
  const promptList = version
    ? ` --list-system-prompts ${version}`
    : ' --list-system-prompts [version]';
  console.error(
    chalk.gray(
      `Run "${getInvocationCommand()} --list-patches" or "${getInvocationCommand()}${promptList}" to see valid IDs.`
    )
  );
  process.exit(1);
}

async function preflightPatchFilter(
  patchesArg: string,
  urlConfig?: TweakccConfig
): Promise<{
  filter: string[];
  ccInstInfo?: ClaudeCodeInstallationInfo;
  preloadResult?: { success: boolean; errorMessage?: string };
}> {
  const patchOnly = resolvePatchFilter(patchesArg);
  if (patchOnly.ok) return { filter: patchOnly.filter ?? [] };
  if (patchesArg.split(',').every(id => !id.trim())) {
    exitInvalidPatchFilter(patchOnly.error);
  }

  const detectionConfig = urlConfig ?? (await readConfigFileForDetection());
  let ccInstInfo: ClaudeCodeInstallationInfo | null;
  try {
    ccInstInfo = await findClaudeCodeInstallation(detectionConfig, {
      interactive: false,
    });
  } catch (error) {
    if (error instanceof InstallationDetectionError) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
    throw error;
  }
  if (!ccInstInfo || getPendingCandidates(ccInstInfo)) {
    console.error(formatNotFoundError());
    process.exit(1);
  }
  const preloadResult = await preloadStringsFile(ccInstInfo.version);
  const result = resolvePatchFilter(
    patchesArg,
    getSystemPromptDefinitions()?.map(prompt => prompt.id) ?? [],
    await loadShadowDeclarations()
  );
  if (!result.ok) {
    exitInvalidPatchFilter(
      result.error,
      ccInstInfo.version,
      preloadResult.success
    );
  }
  return { filter: result.filter ?? [], ccInstInfo, preloadResult };
}

/**
 * Handles the --apply flag for non-interactive mode.
 * All errors in detection will throw with detailed messages.
 * @param patchesArg - The raw --patches value: comma-separated patch and system
 *   prompt IDs to apply (absent or empty applies all)
 * @param configUrl - Optional URL to fetch configuration from
 */
async function handleApplyMode(
  patchesArg: string | undefined,
  configUrl?: string
): Promise<void> {
  console.log('Applying saved customizations to Claude Code...');

  // Read the configuration (from URL or local file). The URL fetch writes
  // nothing, so it runs before the --patches check; the local read can save
  // config.json, so it waits until the filter is known to be valid.
  let config: TweakccConfig | undefined;
  if (configUrl) {
    console.log(`Fetching configuration from: ${configUrl}`);
    try {
      config = await fetchConfigFromUrl(configUrl);
      console.log('Configuration fetched successfully.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Error: ${message}`));
      process.exit(1);
    }
  }

  const preflight = patchesArg
    ? await preflightPatchFilter(patchesArg, config)
    : null;
  if (preflight) await migrateConfigIfNeeded();

  if (!config) {
    console.log(`Configuration saved at: ${CONFIG_FILE}`);
    config = await readConfigFile();
  }

  if (!config.settings || Object.keys(config.settings).length === 0) {
    const source = configUrl ? configUrl : CONFIG_FILE;
    console.error('No saved customizations found in ' + source);
    process.exit(1);
  }

  try {
    // Find Claude Code installation (non-interactive mode throws on ambiguity)
    const startupCheckInfo = preflight?.ccInstInfo
      ? await completeStartupCheck(config, preflight.ccInstInfo)
      : (await startupCheck({ interactive: false }, config)).startupCheckInfo;

    if (!startupCheckInfo || !startupCheckInfo.ccInstInfo) {
      // This shouldn't happen in non-interactive mode (should throw instead),
      // but handle it just in case
      console.error(formatNotFoundError());
      process.exit(1);
    }

    const { ccInstInfo } = startupCheckInfo;

    if (ccInstInfo.nativeInstallationPath) {
      console.log(
        `Found Claude Code (native installation): ${ccInstInfo.nativeInstallationPath}`
      );
    } else {
      console.log(`Found Claude Code at: ${ccInstInfo.cliPath}`);
    }
    console.log(`Version: ${ccInstInfo.version}`);

    // Preload strings file for system prompts
    console.log('Loading system prompts...');
    const preloadResult =
      preflight?.preloadResult ??
      (await preloadStringsFile(ccInstInfo.version));
    if (!preloadResult.success) {
      console.log(chalk.red('\n✖ Error downloading system prompts:'));
      console.log(chalk.red(`  ${preloadResult.errorMessage}`));
      console.log(
        chalk.yellow(
          '\n⚠ System prompts not available - skipping system prompt customizations'
        )
      );
    }

    const patchFilter = preflight?.filter ?? null;

    // Apply the customizations
    console.log('Applying customizations...');
    const { results } = await applyCustomization(
      config,
      ccInstInfo,
      patchFilter
    );

    // Print patch results
    printPatchResults(results, patchFilter);

    // Surface model-facing patches so default-on behavioral changes are never
    // applied silently.
    printModelFacingNotice(results);

    // Check if any patches failed
    const hasFailures = results.some(r => r.failed);
    const hasSystemPromptChanges = results.some(
      r => r.group === PatchGroup.SYSTEM_PROMPTS && r.applied
    );

    if (hasFailures) {
      console.log(chalk.yellow('Customizations applied with some failures.'));
      console.log(
        chalk.dim(
          'These patching errors do not affect your system prompt patches.'
        )
      );
      if (hasSystemPromptChanges) {
        console.log(
          chalk.dim(
            'Your system prompt customizations were still applied successfully.'
          )
        );
      }
      console.log(
        chalk.dim(
          'Please open an issue on https://github.com/skrabe/tweakcc-fixed/issues/new reporting these patching errors.'
        )
      );
    } else {
      console.log(chalk.green('Customizations applied successfully!'));
    }
    console.log(
      chalk.dim(
        'Run with --restore/--revert to revert Claude Code to its original state.'
      )
    );
    process.exit(0);
  } catch (error) {
    if (error instanceof InstallationDetectionError) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Handles the --validate-system-prompts flag.
 *
 * Runs the SAME preflight `--apply` runs before its first mutation, against a
 * pristine version-matched cli.js, and performs no splices and no writes.
 * Exits non-zero on any finding — and also when the pristine bundle or the
 * prompt catalogue is unavailable, because a validator that cannot see its
 * input must fail rather than report clean.
 */
async function handleValidateSystemPrompts(
  pathArg: string | true
): Promise<void> {
  const bundle =
    typeof pathArg === 'string'
      ? await loadPristineBundleFromFile(pathArg)
      : await (async () => {
          const result = await startupCheck({ interactive: false });
          const ccInstInfo = result.startupCheckInfo?.ccInstInfo;
          if (!ccInstInfo) {
            return { error: 'no Claude Code installation detected' };
          }
          return resolvePristineBundle(ccInstInfo);
        })();

  if ('error' in bundle) {
    console.error(chalk.red(`Error: ${bundle.error}`));
    process.exit(1);
  }

  console.log(
    `Validating system prompt overrides against CC ${bundle.version}`
  );
  console.log(chalk.dim(`  pristine: ${bundle.source}`));

  const preload = await preloadStringsFile(bundle.version);
  if (!preload.success) {
    console.error(
      chalk.red(`Error: could not load prompt data for ${bundle.version}:`)
    );
    console.error(chalk.red(`  ${preload.errorMessage}`));
    process.exit(1);
  }

  const preflight = await runSystemPromptPreflight({
    pristine: bundle.content,
    version: bundle.version,
  });

  if (preflight.promptsChecked === 0) {
    console.error(
      chalk.red('Error: no system prompts resolved — nothing was validated.')
    );
    process.exit(1);
  }

  console.log(
    chalk.dim(
      `  ${preflight.promptsChecked} catalogue entries, ${preflight.sitesChecked} resolved sites`
    )
  );

  for (const finding of preflight.findings) {
    const line = formatPreflightFinding(finding);
    if (finding.severity === 'error') console.log(chalk.red(line));
    else if (finding.severity === 'warning') console.log(chalk.yellow(line));
    else console.log(chalk.dim(line));
  }

  if (preflight.findings.length === 0) {
    console.log(chalk.green('0 findings.'));
    process.exit(0);
  }

  const count = (severity: string): number =>
    preflight.findings.filter(f => f.severity === severity).length;
  console.log(
    chalk.red(
      `${preflight.findings.length} finding(s): ${count('error')} error(s), ` +
        `${count('warning')} warning(s), ${count('info')} info.`
    )
  );
  process.exit(1);
}

/**
 * Handles the --restore/--revert flags for non-interactive mode.
 * Restores Claude Code to its original state by reverting from backup.
 */
async function handleRestoreMode(): Promise<void> {
  console.log('Restoring Claude Code to its original state...');

  try {
    // Find Claude Code installation (non-interactive mode throws on ambiguity)
    const result = await startupCheck({ interactive: false });

    if (!result.startupCheckInfo || !result.startupCheckInfo.ccInstInfo) {
      // This shouldn't happen in non-interactive mode (should throw instead),
      // but handle it just in case
      console.error(formatNotFoundError());
      process.exit(1);
    }

    const { ccInstInfo } = result.startupCheckInfo;

    if (ccInstInfo.nativeInstallationPath) {
      console.log(
        `Found Claude Code (native installation): ${ccInstInfo.nativeInstallationPath}`
      );
    } else {
      console.log(`Found Claude Code at: ${ccInstInfo.cliPath}`);
    }
    console.log(`Version: ${ccInstInfo.version}`);

    // Restore from backup based on installation type
    console.log('Restoring from backup...');
    let restored: boolean;
    if (ccInstInfo.nativeInstallationPath) {
      restored = await restoreNativeBinaryFromBackup(ccInstInfo);
    } else {
      restored = await restoreClijsFromBackup(ccInstInfo);
    }

    if (!restored) {
      console.error(
        chalk.red('No backup found. Cannot restore original Claude Code.')
      );
      console.error(
        chalk.yellow(
          'Tip: A backup is created automatically when you first apply customizations.'
        )
      );
      process.exit(1);
    }

    // Clear all applied hashes since we're restoring to defaults
    await clearAllAppliedHashes();

    // Update config to mark changes as not applied
    await updateConfigFile(config => {
      config.changesApplied = false;
    });

    console.log(chalk.blue('Original Claude Code restored successfully!'));
    console.log(
      chalk.gray(
        `Your customizations are still saved in ${CONFIG_FILE} and can be reapplied with --apply.`
      )
    );
    process.exit(0);
  } catch (error) {
    if (error instanceof InstallationDetectionError) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Handles the --list-patches flag.
 * Lists all available patches with their IDs, names, and descriptions.
 */
function handleListPatches(asJson = false): void {
  const patches = getAllPatchDefinitions();

  // Machine-readable output for agents/tooling (the documented --json form).
  if (asJson) {
    console.log(
      JSON.stringify(
        patches.map(p => ({
          id: p.id,
          name: p.name,
          group: p.group,
          description: p.description,
        })),
        null,
        2
      )
    );
    return;
  }

  // Define group order for display
  const groupOrder = [
    PatchGroup.ALWAYS_APPLIED,
    PatchGroup.MISC_CONFIGURABLE,
    PatchGroup.FEATURES,
    PatchGroup.SYSTEM_REMINDERS,
  ];

  // Group patches by PatchGroup
  const byGroup = new Map<PatchGroup, typeof patches>();
  for (const group of groupOrder) {
    byGroup.set(group, []);
  }
  for (const patch of patches) {
    const groupPatches = byGroup.get(patch.group);
    if (groupPatches) {
      groupPatches.push(patch);
    }
  }

  console.log(
    chalk.gray(
      'Use --patches <ids> with --apply to apply specific patches, e.g.:'
    )
  );
  console.log();
  console.log(chalk.gray('  tweakcc --apply --patches "themes,toolsets"'));
  console.log();
  console.log(chalk.blue.bold('Available patches'));
  console.log();

  for (const group of groupOrder) {
    const groupPatches = byGroup.get(group)!;
    if (groupPatches.length === 0) continue;

    console.log(chalk.bold(group) + ':');

    for (const patch of groupPatches) {
      console.log(`  ${chalk.cyan(patch.id)}`);
      console.log(
        `    ${chalk.white(patch.name)} ${chalk.gray('—')} ${chalk.gray(patch.description)}`
      );
    }
    console.log('');
  }

  console.log(chalk.bold('System Prompts:'));
  console.log(
    chalk.dim(
      '  System prompts also have IDs that can be used with --patches.  Use --list-system-prompts [version] to see them.'
    )
  );
}

/**
 * Handles the --list-system-prompts flag.
 * Lists all available system prompts for a given CC version.
 * @param versionArg - Optional CC version to use (defaults to detecting installed version)
 */
async function handleListSystemPrompts(
  versionArg: string | true
): Promise<void> {
  let version: string;

  if (typeof versionArg === 'string') {
    // User provided a specific version
    version = versionArg;
  } else {
    // Try to detect the installed CC version
    console.log('Detecting installed Claude Code version...');
    try {
      const result = await startupCheck({ interactive: false });
      if (!result.startupCheckInfo?.ccInstInfo?.version) {
        console.error(
          chalk.red(
            'Could not detect Claude Code version. Please specify a version:'
          )
        );
        console.error(chalk.gray('  tweakcc --list-system-prompts 1.0.20'));
        process.exit(1);
      }
      version = result.startupCheckInfo.ccInstInfo.version;
    } catch {
      console.error(
        chalk.red(
          'Could not detect Claude Code installation. Please specify a version:'
        )
      );
      console.error(chalk.gray('  tweakcc --list-system-prompts 1.0.20'));
      process.exit(1);
    }
  }

  console.log(`Loading system prompts for CC version ${version}...`);

  const preloadResult = await preloadStringsFile(version);
  if (!preloadResult.success) {
    console.error(chalk.red(`\n✖ Error loading system prompts:`));
    console.error(chalk.red(`  ${preloadResult.errorMessage}`));
    process.exit(1);
  }

  const prompts = getSystemPromptDefinitions();
  if (!prompts || prompts.length === 0) {
    console.error(chalk.yellow('No system prompts found for this version.'));
    process.exit(1);
  }

  // Group prompts by the prefix before the colon in the name
  // e.g., "Tool Parameter: Computer action" -> group is "Tool Parameters"
  const getGroupName = (name: string): string => {
    const colonIndex = name.indexOf(':');
    if (colonIndex === -1) return 'Other';
    const group = name.substring(0, colonIndex).trim();
    // Pluralize group names (except "Data" which is already plural-ish)
    if (group === 'Data') return group;
    return group + 's';
  };

  // Group prompts
  const byGroup = new Map<string, typeof prompts>();
  for (const prompt of prompts) {
    const group = getGroupName(prompt.name);
    if (!byGroup.has(group)) {
      byGroup.set(group, []);
    }
    byGroup.get(group)!.push(prompt);
  }

  // Sort groups alphabetically, and sort prompts within each group by name
  const sortedGroups = [...byGroup.keys()].sort((a, b) => a.localeCompare(b));

  console.log(
    chalk.gray(
      'Use --patches <ids> with --apply to apply specific prompts, e.g.:'
    )
  );
  console.log();
  console.log(
    chalk.gray(
      '  tweakcc --apply --patches "tool-description-read,tool-description-write"'
    )
  );
  console.log();
  console.log(chalk.blue.bold(`System prompts for CC ${version}`));
  console.log();

  for (const group of sortedGroups) {
    const groupPrompts = byGroup.get(group)!;
    // Sort prompts within group by name
    groupPrompts.sort((a, b) => a.name.localeCompare(b.name));

    console.log(chalk.bold(group) + ':');

    for (const prompt of groupPrompts) {
      console.log(`  ${chalk.cyan(prompt.id)}`);
      console.log(
        `    ${chalk.white(prompt.name)} ${chalk.gray('—')} ${chalk.gray(prompt.description)}`
      );
    }
    console.log('');
  }
  console.log(
    chalk.yellow(
      'To see all original system prompts for a given Claude Code version, visit:'
    )
  );
  console.log(
    chalk.yellow.bold(
      '  https://github.com/Piebald-AI/claude-code-system-prompts'
    )
  );
}

/**
 * Handles interactive mode with the full UI.
 * The TUI is for editing local configuration only - remote config URLs are
 * only supported with --apply mode.
 *
 * @param configMigrated - Whether the config was migrated
 */
async function handleInteractiveMode(configMigrated: boolean): Promise<void> {
  try {
    const result = await startupCheck({ interactive: true });

    if (result.pendingCandidates) {
      await handleInstallationSelection(
        result.pendingCandidates,
        configMigrated
      );
      return;
    }

    if (!result.startupCheckInfo) {
      console.error(chalk.red(formatNotFoundError()));
      process.exit(1);
    }

    await startApp(result.startupCheckInfo, configMigrated, result.config);
  } catch (error) {
    if (error instanceof InstallationDetectionError) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Handles the case where multiple installations are found and user needs to select one.
 *
 * @param candidates - List of installation candidates
 * @param configMigrated - Whether the config was migrated
 */
async function handleInstallationSelection(
  candidates: InstallationCandidate[],
  configMigrated: boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleSelect = async (candidate: InstallationCandidate) => {
      try {
        const ccInstInfo = await selectAndSaveInstallation(candidate);

        const config = await readConfigFile();
        const startupCheckInfo = await completeStartupCheck(config, ccInstInfo);

        if (!startupCheckInfo) {
          console.error(
            chalk.red(
              'Error: Failed to complete startup check after selection.'
            )
          );
          process.exit(1);
        }

        pickerInstance.unmount();

        await startApp(startupCheckInfo, configMigrated, config);
        resolve();
      } catch (error) {
        reject(error);
      }
    };

    const pickerInstance = render(
      <InstallationPicker candidates={candidates} onSelect={handleSelect} />
    );
  });
}

async function startApp(
  startupCheckInfo: StartupCheckInfo,
  configMigrated: boolean,
  initialConfig: TweakccConfig
): Promise<void> {
  const result = await preloadStringsFile(startupCheckInfo.ccInstInfo.version);
  if (!result.success) {
    console.log(chalk.red('\n✖ Error downloading system prompts:'));
    console.log(chalk.red(`  ${result.errorMessage}`));
    console.log(
      chalk.yellow(
        '⚠ System prompts not available - system prompt customizations will be skipped\n'
      )
    );
  }

  const invocationCommand = getInvocationCommand();

  render(
    <App
      startupCheckInfo={startupCheckInfo}
      configMigrated={configMigrated}
      invocationCommand={invocationCommand}
      initialConfig={initialConfig}
    />
  );
}

main();
