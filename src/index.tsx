#!/usr/bin/env node
import { render } from 'ink';
import { Command } from 'commander';
import App from './App.js';
import { CLIJS_SEARCH_PATHS, CONFIG_FILE } from './utils/types.js';
import { startupCheck } from './utils/config.js';
import { enableDebug } from './utils/misc.js';

const main = async () => {
  const program = new Command();

  program
    .name('tweakcc')
    .description(
      'Command-line tool to customize your Claude Code theme colors, thinking verbs and more.'
    )
    .version('1.1.2')
    .option('-d, --debug', 'enable debug mode');

  program.parse();

  const options = program.opts();

  if (options.debug) {
    enableDebug();
  }

  const startupCheckInfo = await startupCheck();

  if (startupCheckInfo) {
    render(<App startupCheckInfo={startupCheckInfo} />);
  } else {
    console.error(`\x1b[31mCannot find Claude Code's cli.js -- do you have Claude Code installed?

Searched at the following locations:
${CLIJS_SEARCH_PATHS.map(p => '- ' + p).join('\n')}

If you have it installed but it's in a location not listed above, please open an issue at
https://github.com/piebald-ai/tweakcc/issues and tell us where you have it--we'll add that
location to our search list and release an update today!  Or you can specify the path to its
\`cli.js\` file in ${CONFIG_FILE}:

{
  "ccInstallationDir": "${
    process.platform == 'win32'
      ? 'C:\\\\absolute\\\\path\\\\to\\\\node_modules\\\\@anthropic-ai\\\\claude-code'
      : '/absolute/path/to/node_modules/+@anthropic-ai/claude-code'
  }"
}

Notes:
- Don't include cli.js in the path.

- Don't specify the path to your Claude Code executable's directory.  It needs to be the path
  to the folder that contains **cli.js**.
\x1b[0m`);
    process.exit(1);
  }
};

main();
