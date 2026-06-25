# Changelog

All notable changes to **tweakcc-fixed** (skrabe's fork of
[Piebald-AI/tweakcc](https://github.com/Piebald-AI/tweakcc)) are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/);
this fork uses its own `2.x` line (npm package `tweakcc-fixed`) and is a strict
superset of upstream. Pre-fork upstream history lives in Piebald's releases.

## [Unreleased]

Complexity effort router — memory, true rewind, and full customizability.

- **Classifier memory**: the Haiku router now gets a `<context>` block each turn
  — the model in use (and whether it switched mid-session) plus the level it
  assigned last turn — so a continuing thread holds effort instead of being
  re-judged cold. Kills the "tunnel-vision" mis-routes on terse follow-ups.
- **Rewind-aware (true cut)**: a per-turn snapshot keyed by timestamp; `/rewind` →
  "Restore conversation" captures the rewound-to message's timestamp (splice 5 on
  `onRestoreMessage`) and the next turn cuts the rolling summary + level back to
  that point, dropping the rewound-away work (or cold-resets if the target
  predates the log). The log is persisted in the sidecar (bounded, async write),
  so resume→rewind cuts precisely too. "Summarize from here/up to here" rewinds
  reseed via the existing compaction path. No uuid-matching (the fork mints new
  uuids); the message timestamp is the stable cross-fork link.
- **Full customizability in the TUI**: edit the classifier system prompt in your
  `$EDITOR` (`{LEVELS}`/`{MAX}` stay dynamic), and each tier's label/help inline
  — all with sane defaults and reset-to-default.

## [2.2.2] - 2026-06-25

- Deep-review fixes on the router rework: shared `escapeNonAscii` helper,
  `getRequireFuncName` so sidecar persistence works on NPM/esbuild installs (not
  just Bun native), and corrected `assistantCap` docs.

## [2.2.1] - 2026-06-25

- CC 2.1.191 prompt sync; fix version stamp for new/cache-named prompts (a
  missing `version` crashed the sync and aborted all stubs).

## [2.2.0] - 2026-06-24

- Complexity effort router reworked to Haiku-only with a rolling TL;DR session
  summary fed to the classifier each turn, reseeded from CC's compaction summary
  on compaction; unified middle-truncation caps (TUI-editable); reshaped rubric
  (top tier reserved for genuinely frontier work).

## [2.1.1] - 2026-06-24

- CC 2.1.190 prompt sync.

## [2.1.0] - 2026-06-24

- fff-first Bash search (`swapRipgrepForFff`, default off) + the first cut of the
  complexity effort router.

## [2.0.16] - 2026-06-24

- CC 2.1.187 support.

## [2.0.15] - 2026-06-23

- Banner-layout fix (Clawd logo next to the header, not in the patch list).

## [2.0.14] - 2026-06-23

- CC 2.1.186 support — `createElement` → `jsx()` runtime migration fixes (4 UI
  patches) + prompt sync.

## [2.0.13] - 2026-06-22

- Escape injected non-ASCII at every injection surface (mojibake fix on
  Bun-compiled CC, which stores `cli.js` as Latin-1).

## [2.0.12] - 2026-06-21

- Fable/Mythos prompt set (all models) toggle.

## [2.0.11] - 2026-06-21

- CC 2.1.185 support.

## [2.0.10] - 2026-06-19

- CC 2.1.183 support.

## [2.0.9] - 2026-06-18

- CC 2.1.181 support.

## [2.0.8] - 2026-06-17

- Atomic native write (fixes the macOS code-signature SIGKILL via a fresh inode)
  - network-first prompts fetch for npm + workflow-script harness gate.

## [2.0.7] - 2026-06-17

- Generalize member-access keys (Linux member-access prompt apply).

## [2.0.6] - 2026-06-17

- npm-install identifier-union fallback (#15, dividedby) — hardens the
  unresolved-placeholder guard.

## [2.0.5] - 2026-06-17

- Code-review slot-bind + inline-blob nested-`${}` remap.

## [2.0.4] - 2026-06-16

- CC 2.1.179 deep support + apply round-trip safety (ground-truth harness).

## [2.0.3] - 2026-06-13

- CC 2.1.177 support.

## [2.0.2] - 2026-06-12

- CC 2.1.175 prompts (395 named, + Projects tool).

## [2.0.1] - 2026-06-11

- Fix: version stamp reads `package.json`.

## [2.0.0] - 2026-06-11

- First release of the `tweakcc-fixed` npm package from this fork (re-forked
  directly off Piebald-AI/tweakcc; trusted publish-to-npm via GitHub release).
