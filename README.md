<div align="center">

# ⚡ tweakcc-fixed

### Customize Claude Code far past its settings menu — themes, prompts, thinking, toolsets, and behavior — patched straight into the installed binary.

[![npm](https://img.shields.io/npm/v/tweakcc-fixed?color=cb3837&label=npm&logo=npm&style=flat-square)](https://www.npmjs.com/package/tweakcc-fixed)
[![downloads](https://img.shields.io/npm/dt/tweakcc-fixed?color=cb3837&style=flat-square)](https://www.npmjs.com/package/tweakcc-fixed)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.0.98%20%E2%86%92%202.1.191-d97757?style=flat-square)](https://github.com/anthropics/claude-code)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#credit--license)

**[Install](#install) · [Customize](#what-you-can-customize) · [The fork](#what-this-fork-adds) · [How it works](#how-it-works)**

</div>

---

Claude Code only exposes so much through its settings. tweakcc reaches the rest: it patches the installed binary directly — the `cli.js`, and the JavaScript baked into the native Bun build — so you can restyle the interface, rewrite the prompts Claude actually runs on, and change how it behaves. You pick what you want from a terminal UI, apply it in one command, and roll it back whenever you like.

This is **tweakcc-fixed**, a fork of [Piebald's tweakcc](https://github.com/Piebald-AI/tweakcc) that keeps everything the original does and pushes further — roughly twice the prompt coverage, a deeper set of patches, and overrides that reach the native install where upstream stops. More on that [below](#what-this-fork-adds).

```console
$ npx -y tweakcc-fixed@latest --apply
  ✓ Theme, spinner, thinking verbs, statusline
  ✓ System Prompt: Doing tasks (override)        92 fewer chars
  ✓ Tool Description: Bash (override)             4 fewer chars
  ✓ Toolset + subagent model selection
  …  patches applied · backup written
```

## Install

```bash
npx -y tweakcc-fixed@latest            # interactive TUI — toggle patches, edit prompts
npx -y tweakcc-fixed@latest --apply    # apply everything you've enabled
npx -y tweakcc-fixed@latest --restore  # revert from the backup
```

Nothing to clone or build. Prompt data is pulled from this repo at runtime, so a new Claude Code release works the moment its version bump lands here. Updating Claude Code overwrites the patches, so you just re-run `--apply` — your configuration in `~/.tweakcc/config.json` is untouched either way.

> Versions ≤ 1.0.5 on npm came from a different, unmaintained fork. 2.0.0 onward is this one.

## What you can customize

Everything lives behind one terminal UI: toggle a patch, edit a prompt, apply.

The surface is wide. You can restyle the **look** — themes, the wording of the thinking verbs, the spinner's symbols and speed, the input border, the statusline, table rendering, session titles. You can rewrite the **prompts** — every system prompt, tool description, and `<system-reminder>` is plain markdown you can edit, so you change what Claude is told, not just how it's dressed. You can retune the **tooling** — toolsets, subagent model selection, input-pattern highlighters, file-read limits, MCP startup. And you can adjust **behavior** — reasoning-effort defaults, memory handling, session naming, and a good deal more.

It works the same on npm and native (Bun-compiled) installs, every change is a toggle, and `--restore` puts the original binary back.

## What this fork adds

tweakcc-fixed is a strict superset of the original: everything above still applies, on the same latest Claude Code target. What it adds is reach.

The biggest difference is coverage. Its extractor pulls roughly twice the prompt surface upstream does — every model-facing string, including the short ones the base skips — which is what makes serious prompt editing possible in the first place.

|                              | tweakcc-fixed | upstream  |
| ---------------------------- | :-----------: | :-------: |
| Prompt sites (CC 2.1.191)    |   **1,091**   |    519    |
| Unique prompt IDs            |   **1,050**   |    519    |
| Patches                      |    **58**     |    45     |
| Overrides on native installs |    **yes**    | gated off |

That reach shows up in a few mechanisms the base doesn't have. The `<system-reminder>` injections that fire per turn — and never surface as named prompts — become editable: blank one out to drop it, or rewrite it. Each connected MCP server's instruction block can be dropped or rewritten the same way. And where upstream gates system-prompt overrides off for native installs, this fork applies them. It pairs with [lobotomized-claude-code](https://github.com/skrabe/lobotomized-claude-code), a set of per-model override packs tuned against exactly this extraction.

The extra patches cluster around a few themes: **memory** (a dream-mode consolidation pass, leaner memory types), **reasoning** (Opus defaulting to max effort, plus the experimental complexity router), **search** (the experimental fff backend), and a run of **correctness fixes** — an honest rewind-summary header, a "summarize from here" that actually starts at the rewind point, quieter empty system-reminders, and more.

Two of those are worth calling out, and both ship off by default. **fff-first Bash search** routes Claude's grep, find, and rg through [fff](https://github.com/dmtrKovalenko/fff) and a warm-index daemon, so results come back ranked; it serves a query only when the result is provably identical to the real tool and falls back to the embedded ripgrep/ugrep on anything it can't match exactly, so correctness never rides on it. **The complexity router** reads how hard each task is and routes reasoning effort to match — routine work runs low, the hardest runs max — without switching models or churning the prompt cache, and an explicit `/effort` or `CLAUDE_CODE_EFFORT_LEVEL` always wins.

<details>
<summary>Every patch the fork adds</summary>

<br>

Each patch is tagged with how it behaves on `--apply`: **`[default on]`** applies unless you set its config flag to `false`, **`[always]`** applies unconditionally with no toggle, **`[opt-in]`** applies only if you turn it on. Patches that change model-facing behavior are marked **on by default** below — `--apply` activates them even if you never selected them, so review these before applying.

**Memory & context**

- `dream-mode` **`[default on]`** — `/dream` plus automatic memory consolidation
- `lean-memory-types` **`[opt-in]`** — a trimmed memory-type taxonomy
- `claudemd-context-once-per-conversation` **`[default on]`** — inject CLAUDE.md and context once per conversation, not every turn (rewrites how CLAUDE.md reaches the model)

**Reasoning**

- `max-effort-default` **`[opt-in]`** — Opus defaults to max reasoning effort
- `complexity-router` **`[opt-in]`** — route reasoning effort by task difficulty _(experimental)_

**Search**

- `swap-ripgrep-for-fff` **`[opt-in]`** — fff-backed grep, find, and rg _(experimental)_

**Correctness & noise**

- `fix-rewind-summary-header` **`[default on]`** — an honest rewind / compaction summary header
- `fix-summarize-from-here` **`[default on]`** — "summarize from here" starts at the rewind point, not the top
- `strip-empty-system-reminders` **`[always]`** — drop the empty `<system-reminder>` blocks left after empty tool output
- `read-default-lines` **`[always]`** — an env-gated cap on the default `Read` line count
- `suppress-deferred-tools` **`[opt-in]`** — drop the deferred-tools announcement

**Models & prompts**

- `autonomous-operation-all-models` **`[opt-in]`** — apply the Fable/Mythos autonomous prompt set to every model
- `auto-mode-classifier-model` **`[opt-in]`** — pin the auto-mode safety classifier to a cheaper model

</details>

## How it works

Two kinds of edit, both driven by your config in `~/.tweakcc/config.json`:

```
  ┌──────────────────────┐      ┌────────────────────────────┐
  │ 1. code patches      │      │ 2. prompt overrides        │
  │ regex-anchored        │      │ swap embedded prompt text   │
  │ splices of JS         │      │ for your markdown           │
  └──────────┬───────────┘      └─────────────┬──────────────┘
             └────────────┬────────────────────┘
                          ▼
       npm cli.js   ──or──   native Bun binary
       (patched in place)    (JS extracted → patched → repacked)
                          ▼
             backup written · `--restore` anytime
```

A code patch finds a minified shape with a regex and splices in modified JS; a prompt override swaps the embedded prompt text for your markdown. npm installs are patched in place, while native installs have their JS pulled out of the Bun binary with [node-lief](https://github.com/Piebald-AI/node-lief), patched, and repacked with stale bytecode cleared. The same building blocks ship as a library — `tryDetectInstallation`, `readContent`/`writeContent`, `backupFile`, and the minified-identifier `helpers` — if you'd rather script your own patches.

## Staying current

When Claude Code ships a new version, the [showtime skill](./skills/showtime/) runs the whole upgrade: pull the new `cli.js`, re-extract the prompts, realign anything that drifted, and verify it landed clean. Say "it's showtime," or run `node skills/showtime/driver.mjs check`.

## Credit & license

A fork of [Piebald-AI/tweakcc](https://github.com/Piebald-AI/tweakcc) (© [Piebald LLC](https://piebald.ai)) — all of the core customization is its work, carried here with fixes from upstream PRs [#601](https://github.com/Piebald-AI/tweakcc/pull/601), [#646](https://github.com/Piebald-AI/tweakcc/pull/646), [#655](https://github.com/Piebald-AI/tweakcc/pull/655), and [#664](https://github.com/Piebald-AI/tweakcc/pull/664) on top of the fork-only additions. [MIT](https://github.com/Piebald-AI/tweakcc/blob/main/LICENSE).

<div align="center">

If it made your Claude Code better, a ⭐ helps others find it.

</div>
