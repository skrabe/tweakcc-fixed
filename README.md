# tweakcc-fixed (skrabe fork)

A hard fork of [Piebald-AI/tweakcc](https://github.com/Piebald-AI/tweakcc) that patches an installed Claude Code in place — both npm `cli.js` and the JavaScript embedded in a native Bun binary — to apply **curated system-prompt overrides** and a set of **fork-only patches**. It is purpose-built to pair with [skrabe/lobotomized-claude-code](https://github.com/skrabe/lobotomized-claude-code), and it stays current with every Claude Code release through its own prompt-extraction pipeline.

> [!IMPORTANT]
> **This fork is a superset of upstream and no longer merges from it (2026-06-04).** Upstream's `tweakcc` gates system-prompt overrides **off** for native installs and doesn't have this fork's override mechanisms (inline-blob, system-reminders) or extended extractor; we add those and apply system prompts to native installs too. Upstream is essentially static — recent releases are version bumps plus prompt-data drops we supersede (our extractor names 389 prompts for CC 2.1.170; Piebald's 2.1.170 extract has 346) — so there's nothing to gain by merging. We keep the `upstream` remote only as a **fetch-only comparison signal** and extract our own prompts.

|                        |                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| **This fork**          | [skrabe/tweakcc-fixed](https://github.com/skrabe/tweakcc-fixed)                                          |
| **Base**               | [Piebald-AI/tweakcc](https://github.com/Piebald-AI/tweakcc) @ `bc41a43`, then diverged                   |
| **Target CC versions** | 2.0.98 through **2.1.170**                                                                               |
| **npm package**        | `tweakcc-fixed` (separate from upstream's `tweakcc`)                                                     |
| **Pairs with**         | [skrabe/lobotomized-claude-code](https://github.com/skrabe/lobotomized-claude-code) (Opus 4.8 overrides) |
| **Agent guide**        | [`AGENTS.md`](./AGENTS.md) — bug-class diagnostics, patch authoring, the version-bump pipeline           |

## What this fork adds over the base

These mechanisms extend what's reachable for system-prompt customization ("lobotomization") beyond the base's named-prompt overrides. They don't exist upstream.

### System-reminder override mechanism

A directory `~/.tweakcc/system-reminders/` with one `.md` file per editable dynamic injection. This targets the per-turn / event-driven `<system-reminder>` wrappers that never appear as named prompts in `prompts-X.Y.Z.json` and therefore bypass the named-prompt pipeline.

- **Empty body** → injection suppressed.
- **Custom body** → pristine content replaced.
- **`{{placeholder}}` tokens** → whitelisted JS expressions substituted at apply time.

Files are seeded automatically on first `--apply`. The registry (~30 entries) covers the claudeMd context wrapper, the anti-thinking nudge, MCP per-server overrides, token/budget telemetry, plan-mode reminders, hook/tool-call wrappers, the task-list reminder, the ultrathink booster, the user-sent-new-message wrap, the stop-hook session-goal, and more. UI: `tweakcc` → **System reminders (injection lobotomy)**.

### MCP per-server instruction routing

Auto-generates `~/.tweakcc/system-reminders/mcp-<server-name>.md` for each connected MCP server (from `~/.claude.json` `mcpServers`) and patches `cli.js` so MCP-instruction assembly consults those files at runtime — empty body drops the server's block from the model's context, custom body replaces it, and `{{server_instructions}}` resolves to the server's pristine instructions.

### `string` kind in inline-blob overrides

Extends the inline-blob mechanism to double-quoted JS string literals (previously array/template only), reaching blobs like `function xu3(){return"Users may configure 'hooks'..."}` that the base couldn't override.

### Skills view

A UI surface for managing `~/.claude/settings.json` `skillOverrides` — per-skill cycle through `on / name-only / user-invocable-only / off`. Writes `settings.json` natively (CC honors it immediately; no patch required).

### Strip empty system-reminders (always applied)

Short-circuits CC's universal reminder wrapper so empty / `"(no content)"` text produces no `<system-reminder>` block, killing the drift-inducing `<system-reminder>(no content)</system-reminder>` appended after empty tool outputs. Cache-control-safe (returns the unwrapped placeholder, not an empty text block, so prompt-cached message blocks aren't rejected).

### claudeMd context once-per-conversation

Patches the claudeMd wrapper so the `claudeMd` / `userEmail` / `currentDate` system-reminder injects only on the first API call per conversation (re-firing after `/clear`), instead of CC's default of re-prepending it every call.

### `maxEffortDefault`

A Misc-Configurable toggle that defaults Opus to `"max"` reasoning effort instead of `"xhigh"`. Override at runtime with `/effort` or `CLAUDE_CODE_EFFORT_LEVEL`.

## Fixes carried in this fork

Beyond the fork-only features above, this fork carries correctness fixes that originated in open upstream PRs and in BenIsLegit's now-unmaintained `tweakcc-fixed`, plus fork-only patch work. They are now simply part of this fork (we don't merge upstream, so nothing here is "pending"). Credit:

| Source                                                 | Author                                         | Fix                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [#601](https://github.com/Piebald-AI/tweakcc/pull/601) | [@signadou](https://github.com/signadou)       | Handle `WASMagic` import errors gracefully during native-installation detection                                     |
| [#646](https://github.com/Piebald-AI/tweakcc/pull/646) | [@sla-te](https://github.com/sla-te)           | Support React Compiler output / async refactoring introduced in CC 2.1.85–2.1.88                                    |
| [#655](https://github.com/Piebald-AI/tweakcc/pull/655) | [@LeonFedotov](https://github.com/LeonFedotov) | Fall back to npm source when Bun-bytecode extraction yields non-patchable JS; thread `clearBytecode` through repack |
| [#664](https://github.com/Piebald-AI/tweakcc/pull/664) | [@mike1858](https://github.com/mike1858)       | Fix two patches that broke `cli.js` on literal `\"` sequences in prompt content (#660)                              |

Fork-only patch work: scoping #664's backslash-doubling to quote contexts only (template literals already get a parity-aware backtick pass); adapting `opusplan1m` / `patchesAppliedIndication` / `thinkerFormat` / `verboseProperty` / `userMessageDisplay` matchers across successive CC minified shapes; the past-tense thinking-verb array fix; the `migration.test.ts` `vi.mock` fix; and TS7 build + Linux native-binary patching. See [`AGENTS.md`](./AGENTS.md) for the full rundown and how to extend the fork.

## Inherited base features

These come from the tweakcc base and work unchanged in this fork: system-prompt customization, custom themes, thinking-verb and spinner customization, toolsets (`/toolset`), input-pattern highlighters, `opusplan[1m]`, MCP startup optimization, table-format options, token-count rounding, statusline throttling, `AGENTS.md`/`CLAUDE.md` alternate names, session naming (`/title`, `/rename`), subagent model selection, and the `unpack` / `repack` CLI commands.

For detailed docs on these shared features, see the [upstream tweakcc README](https://github.com/Piebald-AI/tweakcc#readme) — with the caveat that upstream is now v4 and has diverged, so its API / `adhoc-patch` / remote-config sections and native-install behavior describe upstream's build, not this fork.

## Pairing with lobotomized-claude-code

Use this fork's extraction surface with [skrabe/lobotomized-claude-code](https://github.com/skrabe/lobotomized-claude-code) — overrides tuned for **Claude Opus 4.8** against this fork's extraction. Our named-prompt JSON catches prompts Piebald's published extract doesn't (389 named for CC 2.1.170 vs their 346 for 2.1.170), and the system-reminder + `string`-kind reach lets the overrides cover content the base mechanisms can't.

## Install

Published to npm as [`tweakcc-fixed`](https://www.npmjs.com/package/tweakcc-fixed):

```bash
npx tweakcc-fixed@latest              # interactive UI
npx tweakcc-fixed@latest --apply      # apply customizations from ~/.tweakcc/config.json
npm install -g tweakcc-fixed@latest   # or install globally (re-run to upgrade)
```

> [!TIP]
> **Use `@latest`** — this fork iterates as new Claude Code versions ship; without it, `npx` may reuse a cached copy and miss newly-published fixes.

For development, or to run patches that aren't published to npm yet, build and run from source:

```bash
git clone https://github.com/skrabe/tweakcc-fixed ~/dev/tweakcc-fixed
cd ~/dev/tweakcc-fixed && pnpm install && pnpm build
node dist/index.mjs --apply
```

## How it works

tweakcc-fixed patches Claude Code's minified `cli.js`, reading customizations from `~/.tweakcc/config.json`. For npm installs `cli.js` is patched directly; for native installs the JS is extracted from the Bun binary with [node-lief](https://github.com/Piebald-AI/node-lief), patched, and repacked (with stale Bun bytecode cleared). Updating Claude Code overwrites the patches, but they live in your config, so reapply with `--apply`. Revert with `--restore`.

## The `showtime` skill (CC version-bump pipeline)

When Claude Code ships a new version, [`skills/showtime/`](./skills/showtime/) is a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) that drives the whole bump end-to-end on your local machine — extract the new `cli.js`, run the prompt extractor, drive the version-bump report to zero, realign drifted overrides, and prove it landed clean against a **four-zeros** bar (smoke + apply-hygiene + no-orphan-overrides + no-latent-var-breakage). It ships three files:

| File           | Role                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `SKILL.md`     | the runbook — the phases, the gates, when to ask vs act                                                                |
| `REFERENCE.md` | the self-contained "why" — the bug-class catalog, the quote-context rule, the realignment recipe, the gotchas          |
| `driver.mjs`   | the mechanical harness — `versions` / `extract` / `report` / `check` (resolves the repo itself; honors `TWEAKCC_REPO`) |

**Install:** copy `skills/showtime/` into your skills dir — `cp -R skills/showtime ~/.claude/skills/` (global) or `.claude/skills/` in a project — then say _"it's showtime"_ when a new CC version drops, or run the driver directly: `node ~/.claude/skills/showtime/driver.mjs check`. Pair it with an overrides repo ([lobotomized-claude-code](https://github.com/skrabe/lobotomized-claude-code) by default) as described above.

## License

[MIT](https://github.com/Piebald-AI/tweakcc/blob/main/LICENSE). Fork of [Piebald-AI/tweakcc](https://github.com/Piebald-AI/tweakcc); upstream © [Piebald LLC](https://piebald.ai).
