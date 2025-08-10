# tweakcc

[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)

Customize your Claude Code installations styles.

```
npx tweakcc
```

Create custom themes, change the list of verbs shown during generation, change the spinner animation, and the banner text shown when you sign in.  More options are coming soon, such as adding elements to the footer, customizing the generation status line, and modifying prompts used in generation.

tweakcc works by patching the Claude Code's minified `cli.js` file.  When you update your Claude Code installation, your customizations will be overwritten, but they're remembered in your `~/.tweakcc/config.js` configuration file, so they can be reapplied by just rerunning the tool.

Works with Claude Code 1.0.72.

## Running

Use `npx tweakcc` or build and run it locally:

```
git clone https://github.com/Piebald-AI/tweakcc.git
cd tweakcc
pnpm i
pnpm build
node dist/index.js
```

## Demo

Edit themes:

<img alt="tweakcc theme edit view" src="https://raw.githubusercontent.com/Piebald-AI/tweakcc/main/assets/theme_1.png" width="600">

Built-in color picker:

<img alt="tweakcc theme color edit view" src="https://raw.githubusercontent.com/Piebald-AI/tweakcc/main/assets/theme_2.png" width="600">

Edit the thinking spinner:

<img alt="tweakcc thinking styles edit view" src="https://raw.githubusercontent.com/Piebald-AI/tweakcc/main/assets/thinking_styles.png" width="600">

Apply your changes:

<img alt="tweakcc launch screen" src="https://raw.githubusercontent.com/Piebald-AI/tweakcc/main/assets/startup.png" width="600">

Run Claude Code!

<img alt="Customized Claude Code demo" src="https://raw.githubusercontent.com/Piebald-AI/tweakcc/main/assets/claude_demo.png" width="600">

## Related projects

[**ccstatusline**](https://github.com/sirmalloc/ccstatusline) - A highly customizable status line formatter for Claude Code CLI that displays model info, git branch, token usage, and other metrics in your terminal.

## FAQ

### How can I customize my Claude Code theme?

Run `npx tweakcc`, go to `Themes`, and modify existing themes or create new ones.  Then go back to the main menu and choose `Apply customizations to cli.js`.

### Why isn't all the text in Claude Code is getting its color changed?

Some of the text Claude Code outputs has no coloring information at and is rendered using your terminal's default text foreground color.

### How can I disable color altogether?

You can use the [`FORCE_COLOR`](https://force-color.org/) environment variable, a convention which many CLI tools including Claude Code respect.  Set it to `0` to disable colors entirely in Claude Code.

### Why isn't my new theme being applied?

You may have forgotten to actually set Claude Code's theme to your new theme.  Run `claude` and then use `/theme` to switch to your new theme.

## License

[MIT](https://github.com/Piebald-AI/tweakcc/blob/main/LICENSE)

Copyright © 2025 [Piebald LLC](https://piebald.ai).
