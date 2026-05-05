# Working on tweakcc-fixed (the patcher)

You're an agent working on `tweakcc-fixed`. This file explains the bigger picture — what the tool does, the fork situation, and the bug classes you'll run into. The companion file [`~/.tweakcc/lobotomized-claude-code/CLAUDE.md`](../../.tweakcc/lobotomized-claude-code/CLAUDE.md) covers the prompt-overrides side; read that too if you're touching `data/prompts/` or anything related to `--apply` correctness.

## What this tool does

`tweakcc-fixed` patches an installed Claude Code's `cli.js` (or the JS embedded in a Bun-compiled native binary) in place. It applies two kinds of changes:

1. **Code patches** — find a minified shape with a regex, splice in modified JS. Source: `src/patches/*.ts`, registered in `src/patches/index.ts → PATCH_DEFINITIONS`. Toggleable via `~/.tweakcc/config.json → settings.misc.*`.
2. **System-prompt overrides** — replace embedded prompt text with user-edited markdown from `~/.tweakcc/system-prompts/`. The pristine prompt content lives in `data/prompts/prompts-X.Y.Z.json` and is cherry-picked from upstream. Match-and-replace logic: `src/patches/systemPrompts.ts` → `applySystemPrompts`, building regexes from pristine pieces via `src/systemPromptSync.ts → buildSearchRegexFromPieces`.

Native installations use `node-lief` to extract JS from the Bun bundle, patch, then repack. NPM installations write `cli.js` directly. Logic gated behind `nativeInstallationLoader.ts` so non-Linux/macOS systems without C++ libs degrade gracefully.

## Fork lineage

Current setup (verify with `git remote -v`):

```
origin    https://github.com/skrabe/tweakcc-fixed       (user's fork — push target)
upstream  https://github.com/Piebald-AI/tweakcc         (Piebald — actively maintained source)
```

`skrabe/tweakcc-fixed` is a **direct fork of `Piebald-AI/tweakcc`** carrying cherry-picked fixes from open upstream PRs (#601, #646, #655, #664) plus fork-only patches that aren't upstreamed yet (Bun wrapper crash scoping, CC 2.1.113/2.1.126 regex shape adapts, the userMessageDisplay rewrite arc, thinkingVerbs past-tense, max-effort default, sessionMemory graceful no-op, TS7/Linux native patching).

**Historical note for context:** the fork used to be `skrabe/tweakcc-fixed → BenIsLegit/tweakcc-fixed → Piebald-AI/tweakcc` (2-hop fork chain). Ben's fork went unmaintained at 2026-04-22, so on 2026-05-05 we deleted the GH fork, re-forked directly off Piebald, and cherry-picked Ben's still-useful commits onto the new branch. There is no longer a `ben` remote and no longer a fork-of-fork relationship. If you find documentation referring to one, it's stale.

### Syncing with upstream

```bash
git -C ~/dev/tweakcc-fixed fetch upstream
git -C ~/dev/tweakcc-fixed merge upstream/main         # most upstream pushes are pure prompt drops, conflict-free
# Resolve conflicts only when our fork-only commits touch the same files
pnpm build && pnpm test
git push origin main
```

When one of our cherry-picked open upstream PRs eventually gets merged upstream, the next `git merge upstream/main` will recognize the same change is on both sides and the duplicate disappears cleanly — no manual intervention needed.

## Bug classes — diagnostics, not recipes

These recur. The diagnostics are general; the specific symptoms vary.

### "Expected CommonJS module to have a function wrapper" on CC startup after `--apply`

**Class.** `cli.js` parsed as malformed by Bun. Almost always: a prompt override emitted a string into a JS template literal whose unescaped backslashes or backticks broke template parity, prematurely terminating the template literal and leaving the rest of `cli.js` as floating syntax.

**Why it exists.** Anthropic stores prompts in `cli.js` using a mix of single-quoted strings, double-quoted strings, and template literals (backtick). Each delimiter has different escape semantics. Override content destined for one delimiter must be re-escaped to survive that specific delimiter's parser. PR #664 (cherry-picked as `bcce70a`) scoped backslash-doubling to single/double-quote contexts only, because template literals already use a parity-aware backtick-escape pass.

**How it shows up.** User runs `claude` after `--apply`, gets:

```
TypeError: Expected CommonJS module to have a function wrapper. ...
Bun v1.x.y (...)
```

or a syntax error inside `cli.js` if the install is NPM-style.

**How to debug.**

1. Diff the patched `cli.js` against the backup in `~/.tweakcc/native-claudejs-orig.js` and `~/.tweakcc/native-claudejs-patched.js` (auto-saved every `--apply`).
2. Find the patched span. Look for unbalanced backticks, unescaped backslashes, lone `${` not followed by a closing `}`.
3. The fix is in the escape logic for whichever delimiter context the offending prompt landed in: see `src/patches/systemPrompts.ts` lines ~150-200 (the per-delimiter branches) and `src/systemPromptSync.ts → escapeDepthZeroBackticks`.

**Stale Bun bytecode** is a related but distinct cause. Bun caches compiled bytecode alongside `cli.js`; if `--apply` writes new JS but doesn't invalidate the cached bytecode, Bun re-runs the OLD bytecode and may emit similar errors. `clearBytecode` flag (`9ec4d9f`, `96891e0`, `ab0bea8`) handles this — verify it's threaded through your code path when you add new patches that mutate `cli.js`.

### "patch: <name>: failed to find <pattern>"

**Class.** A regex anchored on minified-but-stable identifiers no longer matches. CC's bundler renamed something, OR Anthropic refactored the surrounding code shape, OR the feature was promoted past the gate the patch was bypassing.

**First decide which case you're in:**

1. **Feature still gated, shape changed** → add a new match method for the new shape (see "How to find the new shape" below).
2. **Feature promoted past the gate** → the flag literal / format marker the patch anchored on is gone from `cli.js` entirely because Anthropic took over the gating. The right fix is a graceful no-op, not a regex hunt. Pattern from `src/patches/sessionMemory.ts`:
   ```typescript
   if (!file.includes('"the_anchor_literal"')) {
     console.log(
       'patch: <name>: feature already promoted in this CC build — no-op'
     );
     return file;
   }
   ```
   Decide by grepping for the anchor literal in the extracted `cli.js`. Zero matches → it's case 2 (no-op). Matches present but regex doesn't → case 1 (new shape).

**Where to look.** Each patch in `src/patches/*.ts` typically has multiple match methods stacked in priority order — the latest method handles the latest CC shape, older methods handle older versions. Pattern: open the patch source, find the match function (often `findX`), and add a new `// Method N: <description>` block.

**How to find the new shape.**

1. Extract `cli.js` from the user's installed CC binary:
   ```javascript
   // /tmp/extract.mjs
   import { extractClaudeJsFromNativeInstallation } from '/Users/<you>/dev/tweakcc-fixed/dist/nativeInstallation-*.mjs';
   import fs from 'node:fs';
   const r = await extractClaudeJsFromNativeInstallation(
     '<path-to-claude-binary>'
   );
   fs.writeFileSync('/tmp/cli.js', r.data);
   ```
2. Grep `/tmp/cli.js` for unique strings near what the patch is supposed to find — UI labels, config keys, English error messages. These are stable across minification.
3. Walk back from the unique anchor to find the function/class/object the patch needs to identify. Write a regex that matches the new shape AND tolerates the same kind of minifier renames as the existing methods (use `[$\w]+` for identifiers, not `\w+`; word boundaries via literal punctuation, not `\b`).
4. Add the new method as the FIRST attempt in the matching function (matches latest shape first), keeping older methods as fallbacks.

**Don't delete old methods** unless you're sure the old shape is gone from every CC version `tweakcc-fixed` claims to support. The `--apply` flow tries methods in order; old ones that no longer match are zero-cost.

### "Could not find system prompt 'X' in cli.js"

**Class.** The pristine prompt's regex (built from `data/prompts/prompts-<ccVersion>.json`) doesn't match the running binary. Either the user's `.md` `ccVersion:` frontmatter is older than the binary's actual CC version, or the binary's prompt content diverges from what the JSON says.

**Resolutions.**

- If `ccVersion:` is old: bump it to the binary's version, re-apply.
- If pristine pieces don't match the binary at all: open `prompts-X.Y.Z.json` for the relevant prompt id, find the pristine content, grep `cli.js` for it. If it's truly absent, the prompt was removed — archive the override (`mv` to `~/.tweakcc/orphans-removed-for-X.Y.Z/`).
- If pristine matches but the regex generation is escaping something wrong: see `buildSearchRegexFromPieces` in `src/systemPromptSync.ts`. Common culprits: non-ASCII chars, newlines (`(?:\n|\\n)` alternation), backticks in code blocks.

### Override applies but CC crashes on launch with `ReferenceError: VAR is not defined`

**Class.** An override references `${VAR}` but `VAR` no longer exists in the binary's runtime scope. Anthropic refactored the prompt and inlined the variable as literal text, but the user's override still treats it as an interpolation.

**Detection.** See the validator script in [`~/.tweakcc/lobotomized-claude-code/CLAUDE.md`](../../.tweakcc/lobotomized-claude-code/CLAUDE.md#verification-rule-every-var-must-exist-in-the-current-binary) — it cross-references every unescaped `${VAR}` in user overrides against the pristine `identifierMap` for the current `ccVersion`. **Run this after every CC version bump and any override edit.**

**Resolutions per orphan:** swap to the new variable name, replace with the literal value Anthropic inlined, or escape as `\${VAR}` if the override author wanted a literal placeholder.

## When CC ships a new version (the recurring task)

1. `git -C ~/dev/tweakcc-fixed fetch upstream`. Cherry-pick or rebase upstream's prompt JSON additions (`data/prompts/prompts-X.Y.Z.json`) — these are pure data, no `src/` changes.
2. Bump README version line.
3. Run `pnpm test`. Run `pnpm lint`. Both green before going further.
4. `pnpm build`.
5. Run `dist/index.mjs --apply` against your own CC install.
6. Watch for any "patch: X: failed to find …" errors and fix per the diagnostic above.
7. Run the orphan-variable validator from the lobotomized CLAUDE.md.
8. Test `claude` actually starts. If it crashes with the wrapper error, diff the patched JS against the backup.
9. Commit each logical change separately (prompt sync, max-effort, regex update, etc.) with detailed messages — Ben's commit style is the example to follow.

## Patches: how to add a new one

Pattern from `src/patches/maxEffortDefault.ts` (a simple regex-replace patch):

```typescript
import { showDiff } from './index';

export const writeMaxEffortDefault = (oldFile: string): string | null => {
  const pattern = /function\s+([$\w]+)\s*\(\s*([$\w]+)\s*\)\s*\{ ... \}/;
  const match = oldFile.match(pattern);
  if (!match || match.index === undefined) {
    // Idempotency: detect already-patched shape and skip.
    if (/already-patched-form/.test(oldFile)) return oldFile;
    console.error('patch: maxEffortDefault: failed to find <description>');
    return null;
  }
  const replacement = /* ... */;
  const newFile = oldFile.slice(0, match.index) + replacement + oldFile.slice(match.index + match[0].length);
  showDiff(oldFile, newFile, replacement, match.index, match.index + match[0].length);
  return newFile;
};
```

Then register in `src/patches/index.ts`:

1. Import the function.
2. Add a `PATCH_DEFINITIONS` entry under the right `PatchGroup` (`ALWAYS_APPLIED`, `MISC_CONFIGURABLE`, `FEATURES`, `SYSTEM_PROMPTS`). The `id` must be unique and kebab-case.
3. Add the wiring entry inside the `_` map (in the same file) keyed by the same `id`, with `fn` and `condition`.
4. Add the toggle field to `MiscConfig` in `src/types.ts`.
5. Default value in `src/defaultSettings.ts`.
6. UI toggle in `src/ui/components/MiscView.tsx` (and update its `defaultMisc` block to keep typescript happy).

`pnpm test` runs vitest; add a test for new logic. `pnpm lint` runs `tsc --noEmit && eslint src`. Build with `pnpm build`. Then `dist/index.mjs --apply` end-to-end.

## Don't `npx tweakcc-fixed@latest --apply` if you have local changes

That pulls the published `1.0.4` from npm. If you've added local patches that aren't published, they won't run. Always use `node ~/dev/tweakcc-fixed/dist/index.mjs --apply` (or `pnpm start --apply`) for a workflow with unpublished patches. Publishing to npm is a deliberate step (`pnpm publish` after building, with `prepublishOnly` running build first).

## Code style

- Prettier: 80 char width, single quotes, 2 spaces, semicolons.
- TypeScript strict; avoid `any` — prefer `unknown` + type guards or `as unknown as Type`.
- No comments by default. Add only when WHY is non-obvious (a hidden constraint, a workaround, a surprising invariant).
- Patches: use `[$\w]+` not `\w+` for identifiers (CC's minifier emits `$` in many names). Anchor regex starts on literal punctuation (`,` `;` `{` `}`) not `\b` — `\b` is slow on V8 and treats `$` inconsistently.
- Errors: `console.error('patch: <name>: failed to find <thing>')` so the apply log surfaces the failure. Patches return `null` on failure; the harness catches that and tags the patch failed.

## Day-to-day commands

```bash
pnpm build           # tsc --noEmit + tsdown minified build → dist/
pnpm build:dev       # unminified, faster
pnpm watch           # rebuild on src/ changes
pnpm lint            # tsc --noEmit && eslint src
pnpm test            # vitest run
pnpm test:dev        # vitest watch
pnpm format          # prettier --write src

node dist/index.mjs --apply           # patch installed CC with all enabled toggles
node dist/index.mjs --restore         # revert CC to backup (preserves config.json)
node dist/index.mjs                   # interactive UI
node dist/index.mjs --list-patches    # dump every patch's id/name/group/description as JSON
```
