import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ClaudeCodeInstallationInfo,
  CLIJS_BACKUP_FILE,
  CLIJS_SEARCH_PATHS,
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_SETTINGS,
  TweakccConfig,
} from './types.js';

export const ensureConfigDir = async (): Promise<void> => {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
};

/**
 * Loads the contents of the config file, or default values if it doesn't exist yet.
 */
export const readConfigFile = async (): Promise<TweakccConfig> => {
  const config: TweakccConfig = {
    ccVersion: '',
    ccInstallationDir: null,
    lastModified: new Date().toISOString(),
    changesApplied: true,
    settings: DEFAULT_SETTINGS,
  };
  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf8');
    return { ...config, ...JSON.parse(content) };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return config;
    }
    throw error;
  }
};

/**
 * Updates the config file with the changes made by the `updateFn` callback.
 */
export const updateConfigFile = async (
  updateFn: (config: TweakccConfig) => void
): Promise<TweakccConfig> => {
  const config = await readConfigFile();
  updateFn(config);
  config.lastModified = new Date().toISOString();
  await saveConfig(config);
  return config;
};

/**
 * Internal function to write contents to the config file.
 */
const saveConfig = async (config: TweakccConfig): Promise<void> => {
  try {
    config.lastModified = new Date().toISOString();
    await ensureConfigDir();
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Error saving config:', error);
    throw error;
  }
};

/**
 * Restores the original cli.js file from the backup.
 */
export const restoreClijsFromBackup = async (
  ccInstInfo: ClaudeCodeInstallationInfo
): Promise<boolean> => {
  await fs.copyFile(CLIJS_BACKUP_FILE, ccInstInfo.cliPath);
  await updateConfigFile(config => {
    config.changesApplied = false;
  });

  return true;
};

/**
 * Searches for the Claude Code installation in the default locations.
 */
export const findClaudeCodeInstallation = async (
  config: TweakccConfig
): Promise<ClaudeCodeInstallationInfo> => {
  if (config.ccInstallationDir) {
    CLIJS_SEARCH_PATHS.unshift(config.ccInstallationDir)
  }

  for (const searchPath of CLIJS_SEARCH_PATHS) {
    try {
      const cliPath = path.join(searchPath, 'cli.js');
      const packageJsonPath = path.join(searchPath, 'package.json');
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, 'utf8')
      );
      return {
        cliPath: cliPath,
        packageJsonPath,
        version: packageJson.version,
      };
    } catch {
      // Continue searching if this path fails.
      continue;
    }
  }

  console.clear();
  console.error(`\x1b[31mCannot find Claude Code's cli.js -- do you have Claude Code installed?

Searched at the following locations:
${CLIJS_SEARCH_PATHS.map(p => '- ' + p).join('\n')}

If you have it installed but it's in a location not listed above, please open an issue at
https://github.com/piebald-ai/tweakcc/issues and tell us where you have it--we'll add that
location to our search list and release an update today!  Or you can specify the path to its
\`cli.js\` file in ${CONFIG_FILE}:
{
  "ccInstallationDir": "${process.platform == 'win32'
      ? 'C:\\absolute\\path\\to\\@anthropic-ai\\claude-code'
      : '/absolute/path/to/@anthropic-ai/claude-code'
    }"
}
(Note: don't include cli.js in the path.)\x1b[0m
`);
  process.exit(1);

}

const backupClijs = async (ccInstInfo: ClaudeCodeInstallationInfo) => {
  await ensureConfigDir();
  await fs.copyFile(ccInstInfo.cliPath, CLIJS_BACKUP_FILE);
  await updateConfigFile(config => {
    config.changesApplied = false;
    config.ccVersion = ccInstInfo.version;
  });
};

async function doesFileExist(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Performs startup checking: finding Claude Code, creating a backup if necessary, checking if
 * it's been updated.  If true, an update is required.
 */
export async function startupCheck(): Promise<{
  wasUpdated: boolean;
  oldVersion: string | null;
  newVersion: string | null;
  ccInstInfo: ClaudeCodeInstallationInfo;
}> {
  const config = await readConfigFile();

  const ccInstInfo = await findClaudeCodeInstallation(config);

  const realVersion = ccInstInfo.version;
  const backedUpVersion = config.ccVersion;

  // Backup cli.js if we don't have any backup yet.
  if (!(await doesFileExist(CLIJS_BACKUP_FILE))) {
    await backupClijs(ccInstInfo);
  }

  // If the installed CC version is different from what we have backed up, clear out our backup
  // and make a new one.
  if (realVersion !== backedUpVersion) {
    await fs.unlink(CLIJS_BACKUP_FILE);
    await backupClijs(ccInstInfo);
    return {
      wasUpdated: true,
      oldVersion: backedUpVersion,
      newVersion: realVersion,
      ccInstInfo,
    };
  }

  return {
    wasUpdated: false,
    oldVersion: null,
    newVersion: null,
    ccInstInfo,
  };
}
