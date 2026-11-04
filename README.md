# tweakcc-fixed

Patch Claude Code's prompts, UI and tools. A fork of [Piebald's tweakcc](https://github.com/Piebald-AI/tweakcc) with fff filename search, effort routing, Fable planning and editable runtime reminders.

[![npm](https://img.shields.io/npm/v/tweakcc-fixed?color=cb3837&label=npm&style=flat-square)](https://www.npmjs.com/package/tweakcc-fixed)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1.317-d97757?style=flat-square)](https://github.com/anthropics/claude-code)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[Install](#install) · [Fork additions](#fork-additions) · [Prompt editing](#prompt-editing) · [Build from source](#build-from-source)

## Install

Requires Node.js 20+ and pnpm. Supports npm and native Claude Code installations; the tested target is 2.1.317.

```sh
pnpm dlx tweakcc-fixed@latest            # open the settings UI
pnpm dlx tweakcc-fixed@latest --apply    # apply saved settings
pnpm dlx tweakcc-fixed@latest --restore  # restore the original binary
```

Restart Claude Code after applying. Claude Code updates replace the patched binary, so reapply after an update. Settings and overrides stay in `~/.tweakcc/`.

These docs describe main. npm v2.9.23 predates the Bash-description FFF note and empty Environment cleanup; [build from source](#build-from-source) to use those changes.

## Fork additions

Defaults below are for a new config. Existing settings are kept.

| Feature                                                           | What it does                                                                                                                                   | Default                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| [fff search](docs/fff-search.md)                                  | Fuzzy filename discovery through `fff files`, fuzzy `@` completion, and optional learning from file reads. Grep and Glob keep native behavior. | Off; experimental       |
| [Effort Router](docs/effort-router.md)                            | Select `opusrouter` or `fablerouter` to choose reasoning effort per message. Haiku or Jev decisions; Jev sends selected context to TypeSafe.   | Off; experimental       |
| [Fable Plan](src/patches/fablePlan.ts)                            | Select `fableplan` to plan with Fable and execute with Opus, using each model's native effort setting.                                         | Off                     |
| [Model + effort](src/patches/modelAtEffort.ts)                    | `/model opus@high` switches the model, then sets effort.                                                                                       | On                      |
| [Dynamic reminders](src/patches/systemReminderOverrides.ts)       | Edit per-turn messages and individual MCP servers' instruction blocks in Markdown.                                                             | Stock text until edited |
| [Browser bridge](https://github.com/skrabe/claude-browser-bridge) | Install, repair or remove the bridge from the **Better Claude in Chrome** menu. Extension setup is a separate step.                            | Manual install          |
| [Memory controls](src/patches/leanMemoryTypes.ts)                 | Expose bundled dream mode and compact memory-type instructions. Native settings still control automatic dreaming.                              | Off                     |
| [Responsive mode](src/patches/responsiveMode.ts)                  | Expose the bundled responsive-mode plugin; enable it separately in `/plugin`.                                                                  | Off                     |
| [Output-style reminders](src/patches/outputStyleTurnReminder.ts)  | Set custom reminder text with `turn-reminder:` in an output style's frontmatter.                                                               | Off                     |
| [Rewind fixes](src/patches/fixSummarizeFromHere.ts)               | Summarize from the selected rewind point and label deliberate rewinds correctly.                                                               | On                      |

Empty reminder cleanup always runs. Main also removes empty Environment scaffolding and stale FFF notes from restored prompts.

Upstream provides the themes, spinners, thinking text, toolsets, subagent model selection and other base customization. Both projects support native prompt overrides. Their patch lists differ; see the [versioned comparison](docs/upstream-comparison.md) for upstream controls this fork doesn't include.

<!-- coverage:start -->

|                           | tweakcc-fixed | upstream |
| ------------------------- | :-----------: | :------: |
| Prompt sites (CC 2.1.317) |    16,355     |  1,084   |
| Unique prompt IDs         |    15,141     |  1,084   |
| Patches                   |      82       |    61    |

Same Claude Code 2.1.317 catalogue, compared with [upstream 925d13fd](https://github.com/Piebald-AI/tweakcc/tree/925d13fd513bc86659ae395c647674cd0d57e6da). Counts describe source inventory; active prompts depend on model, tools and settings.

<!-- coverage:end -->

Refresh this table from a checkout with `git fetch upstream main`, then `node tools/readmeStats.mjs 2.1.317 --write`. The command requires the same Claude Code catalogue version on both sides.

## Prompt editing

| Path                               | Contents                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `~/.tweakcc/config.json`           | Patch switches, UI preferences and model settings                               |
| `~/.tweakcc/system-prompts/*.md`   | System prompts, tool descriptions, bundled references and other named fragments |
| `~/.tweakcc/system-reminders/*.md` | Dynamic reminders and MCP instruction overrides                                 |

Use the prompt screens in the UI, or edit the files directly. Keep their metadata and variable bindings intact, then check and apply:

```sh
pnpm dlx tweakcc-fixed@latest --validate-system-prompts
pnpm dlx tweakcc-fixed@latest --apply
```

[lobotomized-claude-code](https://github.com/skrabe/lobotomized-claude-code) supplies ready-made overrides for Opus 5.5 and Fable 5.1. Its [clean Opus fixture](https://github.com/skrabe/lobotomized-claude-code/blob/main/docs/measurements.md) measured 22.6% fewer characters in system blocks and tool descriptions than stock. Token counts and task quality weren't measured.

## Build from source

Use Node.js 24 and pnpm 11+ for development.

```sh
git clone https://github.com/skrabe/tweakcc-fixed
cd tweakcc-fixed
pnpm install --frozen-lockfile
pnpm build
node dist/index.mjs --apply
```

`--list-patches --json` lists registered patch IDs. `--apply --patches <id,...>` applies selected patches plus required cleanup. Prompt data comes from `data/prompts/` in a checkout; packaged releases fetch it from their own GitHub release tag.

Code patches change Claude Code's JavaScript. Prompt overrides replace embedded text. For native installations, tweakcc extracts the JavaScript, patches it and repacks the binary with affected bytecode cleared. `--restore` uses the saved original.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and test commands.

## License

Forked from [Piebald-AI/tweakcc](https://github.com/Piebald-AI/tweakcc), © Piebald LLC and contributors. [MIT](LICENSE).
