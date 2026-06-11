---
name: showtime
description: >-
  The Claude Code version-bump "showtime" pipeline for tweakcc-fixed (the
  patcher) plus its companion overrides repo (lobotomized-claude-code by
  default). Brings the patcher and the curated overrides up to a newly-released
  Claude Code, end-to-end on the local machine, to a green smoke test — patches
  working, prompts extracted, overrides realigned, nothing regressed. Use this
  when a new Claude Code version dropped, when the user says "it's showtime" /
  "its showtime", or when asked to support / patch / lobotomize a new CC
  version, bump prompts, run the version-bump pipeline, or realign overrides.
  Triggers: showtime, new CC version, version bump, support CC X.Y.Z, patch
  Claude Code, lobotomize, realign overrides, run/verify the patcher. This skill
  ships REFERENCE.md (the "why" / bug-class catalog) and driver.mjs (the
  mechanical + verification harness) alongside it.
---

# CC version-bump ("showtime") pipeline

This is the recurring task: Claude Code ships a new version, and you bring
**tweakcc-fixed** (the patcher) and your **overrides repo** (lobotomized-claude-code,
LCC, by default per the README) up to it, end-to-end on the **local machine**, to
a green smoke test — patches working, prompts extracted, overrides realigned,
nothing regressed.

> **Paths in this file are relative to the tweakcc-fixed repo root** unless
> absolute. The driver lives next to this skill at `driver.mjs`. The skill OWNS
> the pipeline _behavior_ (the steps + the gotchas + the driver); the _conventions
> and the "why"_ live in `REFERENCE.md` next to this file — read the sections it
> points at, this skill points at them rather than restating every word.

> **The trigger.** "it's showtime" / "its showtime" = run this whole thing
> autonomously, end to end, to a green smoke test on the local machine, including
> all commits and pushes. Don't ask "should I commit/push" — the answer is always
> yes; that's the point of the phrase. Ask **only** on genuine ambiguity or a
> decision that needs the user (low-confidence prompt identity, or a true id
> collision). **A rewritten/reformatted prompt is NOT an ask case** — when
> Anthropic rewrites or reformats a prompt, always re-trim the override against
> the NEW pristine (preserving the existing lobotomization intent in the
> established style); NEVER keep stale old-flow/old-format content, and NEVER ask
> about it. See `REFERENCE.md → The override-realignment recipe (bump / retrim /
resync / rename / inline / removed / suppress)`.

---

## §0 — STEP ZERO: ground yourself before you touch anything

This is not optional and it is not throat-clearing. The pipeline is a minefield
of non-obvious gotchas (see §10). An agent that skips grounding ships a silent
downgrade, a duplicated override, or a latent `ReferenceError`. **Read first:**

1. **The bug-class catalog and conventions** in `REFERENCE.md` next to this file —
   it owns the "why" behind every phase and every gotcha. At minimum read the
   sections this skill links: the four zeros, the bug classes, the
   override-realignment recipe, fuzzy-carryover + `NEW_PROMPT_ASSIGNMENTS`, the
   three override surfaces, the upstream-comparison policy.
2. **The current model's system card** — you need it for the override realignment
   in §7 (the diligence/honesty findings drive keep/cut calls). The per-topic
   section map lives with the overrides repo's docs.
3. **The Anthropic prompting guide** — canonical for any override-content edit.
   ⚠️ Live fetches of that page can return a **stale render** for an older model —
   do NOT trust a render that doesn't name the current model. Cross-check against
   the offline digests in the overrides repo + the prompting checklist in the
   overrides repo's `CLAUDE.md`.
4. **Both `CLAUDE.md` files** — the tweakcc-fixed `CLAUDE.md` (bug-class
   diagnostics, patch-authoring) and the overrides repo's `CLAUDE.md` (the
   lobotomization decision rule + realignment recipe).

If you are doing **substantive prompt/override reshaping** (the §7 realignment, or
a cull pass), the standing convention is: **fan out + verify, and every subagent
grounds itself first** (reads the guide + its assigned system-card sections)
before editing. Mechanical steps and pure ccVersion-bump frontmatter touches do
**not** need a workflow — do them directly.

---

## §1 — The two repos, the install, the paths

Two git repos move together on the same release cycle:

| Repo                              | Role                                                | Remote / upstream                                                              |
| --------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| **tweakcc-fixed**                 | patcher: regex patches + prompt-JSON sync + CLI/TUI | `origin` = your fork; `upstream` = `Piebald-AI/tweakcc` (direct fork)          |
| **lobotomized-claude-code (LCC)** | curated overrides (`.md` + frontmatter)             | `origin` = your fork of the overrides repo; no upstream (own canonical source) |

- The README pairs tweakcc-fixed with an overrides repo (lobotomized-claude-code
  by default) — clone or symlink it where the README says. `~/.tweakcc/system-prompts`
  is a **symlink** → your active per-model override set (e.g. `…/lobotomized-claude-code/system-prompts-<model>`).
  `~/.tweakcc/system-reminders` is symlinked the same way. The patcher reads both
  via the symlinks at `--apply`. Use your active model override set — the public
  skill does not assume a single model dir.
- **CC install detection.** tweakcc auto-detects the installed Claude Code; the
  native binary it extracts from is the versioned binary your `claude` launcher
  resolves to. No env var is needed when there's exactly one install.
- **`claude` may be a shell function/alias locally** (wrapping the binary with env
  vars). In a non-interactive `node`/`sh` context it isn't available — the driver
  resolves the real binary by `realpath`-ing the `claude` launcher. When you need a
  version off the binary in a script, call the binary directly, not `claude`. See
  `REFERENCE.md → Platform-minified names differ per target`.
- Canonical pristine cli.js: **`~/.tweakcc/native-claudejs-orig.js`** — tweakcc
  auto-writes it every `--apply`. (NOT any stale global npm install path.)

---

## §2 — The driver (agent verification path) — RUN THIS

The driver (`driver.mjs`, shipped alongside this skill) is the **mechanical +
verification harness**. It runs the deterministic parts and the health check so
you can _prove_ a bump landed clean. The judgment-heavy phases (naming anon
prompts, patch shape-drift fixes, the LCC override realignment) are agent work —
the driver verifies their _result_.

```bash
# the driver resolves the repo itself — run from anywhere in the checkout
node .claude/skills/showtime/driver.mjs versions   # installed CC vs repo's latest prompts JSON
node .claude/skills/showtime/driver.mjs extract     # extract cli.js from the native binary -> /tmp/cli-<ver>.js
node .claude/skills/showtime/driver.mjs report 2.1.160   # run + parse the version-bump report (old -> current)
node .claude/skills/showtime/driver.mjs check       # FULL health check: version + stale-backup guard + idempotent --apply hygiene + smoke
```

`check` is the one to run after a bump (or any time) to confirm the install is
on-version, patched clean (0 ✗ / 0 "failed to find" / 0 "Could not find" / 0
"Conflicts detected" / "applied successfully"), and boots (`claude --print
READY`). Exit 0 = all green. It re-applies idempotently, so it's safe to run
repeatedly. It also flags the **stale-backup** condition before it can bite (§10).

> The public driver exposes the **local** commands only: `versions`, `extract`,
> `report`, `check`. There is no remote/sync command.

---

## §3 — Pipeline overview (the phases)

```
0. Ground (read REFERENCE.md + system card)         ← §0, mandatory
1. Update CC + detect the new version               ← claude update; driver versions
2. Fetch upstream for COMPARISON ONLY (never merge) ← git fetch; git show upstream JSON; our extractor is canonical
3. Extract cli.js + run the prompt extractor        ← driver extract; promptExtractor; NEW_PROMPT_ASSIGNMENTS
4. version-bump report -> drive the counters to 0   ← driver report; the FOUR ZEROS
5. README bump + lint + test + build                ← pnpm lint && pnpm test && pnpm build
6. Stale-backup check + --apply + smoke             ← driver check
7. LCC override realignment (the conflicts)         ← grounded workflow + the decision rule (§7)
8. Commit each repo + push                          ← git commit -F (avoid the bad-substitution trap)
9. Publish to npm (if you distribute via npm)       ← bump package.json version, tag vX.Y.Z, push --tags → release CI; consumers npx the new version
```

> **Major-change gate — deem and stop, don't blindly apply.** "Applied cleanly /
> N-of-N landed" is mechanical success, not the judgment that a layer still _fits_
> the new prompt landscape. Before finalizing each judgment-dependent layer, detect
> and SURFACE major structural changes rather than auto-baking through them:
> wholesale prompt rewrites, brand-new always-on prompts, large identifier-slot
> restructures. Most are auto-handled (re-trim per §7), but they go in the run
> summary.

We do NOT merge upstream (Phase 2 is fetch + read upstream's JSON for comparison
only; our extractor is canonical — see §5).

---

## §4 — Phase 1: update CC + detect the new version

```bash
claude update                 # native installer; safe no-op if already current
claude --version              # confirm
node .claude/skills/showtime/driver.mjs versions
```

If `versions` prints `NEW VERSION: installed X > repo Y`, you have a real bump to
do. If it says `up to date`, there's nothing to bump — `check` and stop.

---

## §5 — Phase 2: fetch upstream for COMPARISON ONLY — never merge

**Rule: we do NOT `git merge upstream/main`** — because it gains nothing, not
because it's destructive. Our fork is a **strict superset** of upstream's code
(zero upstream-only files). Upstream is essentially static: its releases are
version bumps + prompt-JSON drops we supersede with our own extractor's output. A
real test-merge is just a few keep-ours conflicts (`README.md` + the prompt JSONs)
and deletes nothing — it would only pull a version label that's theirs and prompt
data we replace with our own. Upstream's tree gates system-prompt overrides off
native installs, but that gate predates our fork; our fork overrides it to apply
prompts to native. See `REFERENCE.md → Upstream comparison: extractor canonical,
no count regressions, the data-anthropic-cli VERSION false-positive`.

`upstream` stays only as a **fetch-only comparison remote**:

```bash
git fetch upstream                                   # fetch only — NEVER merge
# upstream's published JSON = comparison signal ONLY (count named, diff id-sets):
git show upstream/main:data/prompts/prompts-X.Y.Z.json > /tmp/upstream-X.Y.Z.json
```

**Source-of-truth policy:** **our** extractor is canonical; upstream is a
comparison signal. Seed fuzzy carryover from **our own** latest
`prompts-X.Y.Z.json`, never upstream's (different conventions → mass fuzzy-misses).
See `REFERENCE.md → Fuzzy-carryover miss & NEW_PROMPT_ASSIGNMENTS`.

**Patch shape-drift is now caught at `--apply`, not at merge.** Since we no longer
import upstream's matchers, if a CC bump changes a minified shape our patch anchors
on, you find out from a `patch: X: failed to find …` line in Phase 6 — fix it by
adding a new match method to our patch, using the real binary (driver `extract`) to
verify the new regex. See `REFERENCE.md → Bug class: patch failed to find (regex
anchor drift)`. Don't go looking at upstream for a newer matcher — ours are already
equal-or-newer on every patch.

There is **no merge commit** in the pipeline — Phase 2 produces no tree changes,
only `/tmp/upstream-X.Y.Z.json` for the §6 comparison.

---

## §6 — Phase 3: extract cli.js + run the prompt extractor

```bash
# 1. Extract a fresh cli.js from the PRISTINE native binary (no patching):
node .claude/skills/showtime/driver.mjs extract /tmp/cli-X.Y.Z.js
# (or manually via the dist nativeInstallation module — the driver wraps exactly that)

# 2. Set up the extractor's temp dir + SEED from OUR OWN latest prompts JSON:
mkdir -p /tmp/cc-X.Y.Z && printf '{"name":"@anthropic-ai/claude-code","version":"X.Y.Z"}' > /tmp/cc-X.Y.Z/package.json
cp /tmp/cli-X.Y.Z.js /tmp/cc-X.Y.Z/cli.js
cp data/prompts/prompts-<prev>.json data/prompts/prompts-X.Y.Z.json     # seed = OUR latest, NOT upstream
# Upstream's JSON: the extractor takes its identifierMap for every shared prompt
# (whose identifiers array matches), so an override's ${NAME} binds to the right
# slot automatically — net-new prompts keep our generated names. Without this the
# maps drift and overrides silently mis-bind.
git show upstream/main:data/prompts/prompts-X.Y.Z.json > /tmp/upstream-X.Y.Z.json
TWEAKCC_UPSTREAM_JSON=/tmp/upstream-X.Y.Z.json node tools/promptExtractor.js /tmp/cc-X.Y.Z/cli.js data/prompts/prompts-X.Y.Z.json
```

**The fuzzy-carryover miss** (`REFERENCE.md → Fuzzy-carryover miss &
NEW_PROMPT_ASSIGNMENTS`): the matcher keys on the **first 100 chars** of
reconstructed content. If Anthropic edited a prompt's _opening_ (most often a
rename, or wrapping it in a `${flag()?A:B}` conditional), the fingerprint changes
and the name silently drops → the prompt extracts **anonymous**. This is **not** a
removal. To distinguish:

- grep the _distinctive content_ of the "removed" id against `/tmp/cli-X.Y.Z.js`.
- **0 hits** → real removal → archive the override (it's a different decision; see §7).
- **hits present** → fuzzy-miss → add a `NEW_PROMPT_ASSIGNMENTS` entry in
  `tools/promptExtractor.js` to restore the name, re-seed + re-run the extractor.

For **genuinely new** prompts (no seed to fuzzy-match): **high-confidence naming is
allowed automatically** via `NEW_PROMPT_ASSIGNMENTS` (matcher → name/id/description,
matched against the raw template-literal source). **Prompt-content / LCC override
edits still require user sign-off.** See `REFERENCE.md → New-prompt naming:
high-confidence auto-name vs content sign-off`. Dig the binary for identity
(registration fn, `disableModelInvocation`, gating, skill frontmatter) before
naming.

**No-regression bar** (`REFERENCE.md → Upstream comparison: extractor canonical,
no count regressions, the data-anthropic-cli VERSION false-positive`): print
**prev named / current named / upstream named**. `current` must not drop below
`prev` unless each dropped id is verified-gone from cli.js; and `current` must stay
**≥ upstream's** for the same version. Verify named count with:

```bash
python3 -c "import json; d=json.load(open('data/prompts/prompts-X.Y.Z.json'))['prompts']; print(len(d),'total,',sum(1 for p in d if p.get('id')),'named')"
```

---

## §7 — Phase 4 & 5 & 6: report → README/lint/test/build → apply → smoke

```bash
node .claude/skills/showtime/driver.mjs report <prev>   # parses the 6 counters
# or directly:  pnpm version-bump:report <prev> X.Y.Z
```

> The report extracts from `~/.tweakcc/native-claudejs-orig.js`. If that file is
> still the _old_ version (you extracted to `/tmp` but haven't `--apply`'d yet),
> the report's "fresh extraction differs from committed" blocking issue is a
> **false positive** — refresh orig.js to the new version first
> (`cp /tmp/cli-X.Y.Z.js ~/.tweakcc/native-claudejs-orig.js`) and re-run.

Then:

```bash
# README: bump the "Target Claude Code versions" line to X.Y.Z
pnpm lint && pnpm test && pnpm build
```

**Apply + smoke (mind the STALE-BACKUP GOTCHA, §10):**

```bash
node .claude/skills/showtime/driver.mjs check
# which is, mechanically:
#   (stale-backup guard) -> node dist/index.mjs --apply -> parse hygiene -> claude --print READY
```

`--apply` output must be **only ✓ rows + "Customizations applied successfully!"** —
no `WARNING`, no `Could not find`, no `ENOENT`, no patch `no-op` lines. The driver's
`check` parses for ✗ / "failed to find" / "Could not find" / "Conflicts detected"
and the success line. See `REFERENCE.md → The four zeros (the completion bar)`.

> **During the bump, always `node dist/index.mjs` from the checkout** — the
> published npm build lags your working tree until the publish phase (§9) ships
> it. This local apply is the pre-publish gate. `npx <package>@<exact-version>`
> is the consume path for other machines, only after the publish lands.

---

## §8 — Phase 7: LCC override realignment (the conflicts)

After Phase 6, `--apply` may report `WARNING: Conflicts detected for N system
prompt file(s)` — override `.md` files whose pristine drifted (their `ccVersion:`
is older than the prompt's current version). The overrides still _apply_ (you'll
see 0 "Could not find"); the conflict is advisory: "the pristine you lobotomized
against has moved — review." Drive this to **0 conflicts**. See `REFERENCE.md →
Bug class: Could not find system prompt (override pristine/ccVersion drift)`.

**This is content work. Ground per §0. Do not hand-edit hand-tuned overrides off
the cuff — that mistake is exactly what the grounded-workflow convention exists to
prevent.**

### The triage (read every diff — bumping ccVersion _without_ reading the diff is the lazy path)

Reconstruct each override's pristine-old → pristine-new (the `.diff.html` files
tweakcc wrote under `~/.tweakcc/system-prompts/`, or reconstruct from the historical
`data/prompts/prompts-*.json`). Classify per `REFERENCE.md → The override-realignment
recipe (bump / retrim / resync / rename / inline / removed / suppress)`:

- **Trivial drift** (whitespace, a conditional wrapper a full-replacement body
  supersedes, a removed example) → **mechanical ccVersion bump** of the `.md`
  frontmatter. Do directly (no workflow):
  ```bash
  sed -i '' "s/^ccVersion: .*/ccVersion: <target>/" system-prompts-<model>/<id>.md
  ```
  Targets come from the apply log's "Update the ccVersion…" list (= the prompt's
  `version` in `prompts-X.Y.Z.json`).
- **Real content change** (Anthropic added/removed a meaningful section, OR
  rewrote/reformatted the prompt) → **grounded workflow**: one agent per override,
  each reads the LCC decision rule + the current-model behavior digest + its
  assigned system-card pages + its diff, then does surgical realignment and returns
  a structured summary you review.
  - **A rewrite/reformat is the SAME class — re-trim, don't ask.** When the new
    pristine is a wholesale rewrite (old multi-step flow → new flow), the old
    override would inject **stale, now-wrong** content. Re-trim the override against
    the NEW pristine in the established trim style (diff a sibling already trimmed
    to learn the style); keep every load-bearing command/path/field/error-tag, cut
    the prose. **Never** keep old-flow/old-format content, and **never** ask whether
    to — realigning a rewritten prompt to current pristine is always correct.
  - **Distinguish from a mechanical bump:** if the override is a still-valid curated
    trim and Anthropic only _added/reworded_ detail (the trim is just leaner-than-
    latest, not stale-wrong), a ccVersion bump is enough. If Anthropic _replaced_
    the flow/format the override describes, you must re-trim.

### The lobotomization decision rule

> For each load-bearing claim: is it conveyed by a **sibling** override, OR a
> **model default** per the system card, OR a **feature you don't use**? → cut it.
> Whatever unique signals remain → keep. If nothing unique remains → **full-wipe**
> (empty body = suppress) is the correct outcome, not a failure.

Non-obvious sub-rules a context-less agent will get wrong:

- **Sibling-check is mandatory.** grep the rest of `system-prompts-<model>/` for any
  prompt conveying each claim; cut sentences already carried (more fully) by a
  sibling as duplicates, keeping only the unique residue.
- **Conditional prompts cost zero tokens when their feature is off.** "I don't use
  this feature" is **NOT** a wipe reason for a conditional prompt — TRIM, don't
  wipe. Wipe is for content-quality (CAPS theater, sibling-duplicate, anti-laziness
  scaffolding the current model doesn't need).
- **The current model's card sharpens the cut.** A model that already leads on
  diligence/honesty makes anti-laziness / "report faithfully" / "don't guess" /
  "investigate thoroughly" scaffolding largely a default → cut harder. BUT
  short-context eval wins are weakest in always-on long-horizon prompts — so keep
  where it's long-horizon-load-bearing or task-STRUCTURE (not exhortation).
- **The three override surfaces** (`REFERENCE.md → The three override surfaces
(named-prompt, inline-blob, system-reminders)`): named-prompt overrides,
  `inline-*.md` inline-blob overrides, AND `system-reminders/*.md` (a `REMINDER_REGISTRY`,
  `defaultBody` = vanilla, empty body = suppress). Reminders are prompts too — easy
  to forget on a model-card reshape; diff each `<id>.md` body vs its `defaultBody`.

### Structural realignment patterns

All of these live in `REFERENCE.md → The override-realignment recipe (bump /
retrim / resync / rename / inline / removed / suppress)`:

- **Renamed / inlined / removed id** → rename (`git mv` + ccVersion bump) / archive /
  archive.
- **Identifier-slot shift** (Anthropic added identifier slots; carried labels now
  point at the wrong minified var → `${LABEL(N)}` becomes a call on a _string_ →
  runtime `TypeError`) → slot-aware `NEW_PROMPT_ASSIGNMENTS` overlay with the
  COMPLETE new identifierMap. See `REFERENCE.md → Bug class: ReferenceError VAR is
not defined (orphan placeholder)` and `→ Bug class: mis-bind (override resolves
to a wrong-but-valid var) + the auditMisbinds gate`.
- **Prompt split into shared constants** (a combined prompt's sub-sections move to
  shared `var`s referenced by both inline cells and the bundled workflow) → trim the
  parent override to its shrunk pristine, populate the new split ids, leave the
  bundled `workflow-script-*` override pristine (DRY propagation).
- **Override auto-recreation** — `syncPrompt` recreates a pristine `.md` for any JSON
  id lacking one. To **suppress** a prompt, keep the `.md` present with an **empty
  body** — do NOT `mv` it away (it comes back next apply).

After realigning: re-run `driver.mjs check` → **0 conflicts**.

---

## §9 — Phase 8: commit + push (BOTH repos, each logical change separately)

> **THE COMMIT-MESSAGE GOTCHA.** `git commit -m "…"` in zsh/bash **expands `${…}`
> and backticks inside the double-quoted message** → `bad substitution` → the
> commit silently doesn't happen. Pipeline messages are full of `${VAR}`,
> `${?...}`, backticked code. **Always write the message to a file and use
> `git commit -F /tmp/msg.txt`.** Verify HEAD afterward (`git log -1`). See
> `REFERENCE.md → Commit-message bad-substitution gotcha`.

```bash
# tweakcc-fixed: commit each logical change separately (NO merge commit — we don't merge upstream)
git add data/prompts/prompts-X.Y.Z.json tools/promptExtractor.js && git commit -F /tmp/prompts-msg.txt
# + any patch shape-drift fixes (src/patches/*) as their own commit, if a patch needed adapting
git add README.md && git commit -F /tmp/readme-msg.txt
git push origin main

# LCC (your overrides repo): the realignment
git -C <overrides-repo> add system-prompts-<model>/ && git -C <overrides-repo> commit -F /tmp/lcc-msg.txt && git -C <overrides-repo> push origin main
```

### Phase 9: publish to npm (if your fork is distributed as an npm package)

The local `--apply` in Phase 6 is the pre-publish gate — publish only after the
four zeros. Push main FIRST: npm installs of the package ship no `data/`, they
fetch `prompts-X.Y.Z.json` from your repo's `main` branch at runtime, so an
unpushed JSON 404s for every consumer.

```bash
# bump "version" in package.json (its own commit), push main, then:
git tag vX.Y.Z && git push origin main --tags   # tag push triggers the release workflow (npm publish + GH release)
npm view <your-package> version                  # wait until the registry serves X.Y.Z
```

Other machines then consume with `npx -y <your-package>@X.Y.Z --apply` — no
checkout or build needed on those boxes (pin the exact version, not `@latest`,
so a mid-bump box can't race the registry).

---

## §10 — The completion bar: FOUR ZEROS (not one)

`blocking issues: 0` is necessary, not sufficient. Showtime is done only when **all
four** are zero. See `REFERENCE.md → The four zeros (the completion bar)`.

1. **Smoke** — `claude --print "say only the word READY"` → READY.
2. **Apply hygiene** — `--apply` shows 0 ✗ / 0 "failed to find" / 0 "Could not find"
   / 0 "Conflicts detected" + "Customizations applied successfully!".
3. **No orphan overrides** — version-bump report `prompt overrides not in JSON: 0`.
4. **No latent var breakage** — orphan-`${VAR}` validator: `UNKNOWN_N placeholders: 0`
   AND `unbound labels: 0` across every override (the _one_ allowed exception is
   `data-anthropic-cli`'s `${VERSION}` — see §11). `driver.mjs check` covers 1+2;
   `driver.mjs report` covers 3 + the UNKNOWN count.
   **Also run the MIS-BIND AUDIT** (`node tools/auditMisbinds.mjs`, must exit 0) — every
   placeholder an override USES must sit at the same identifierMap slot as upstream's
   complete map, else it silently mis-binds to a wrong-but-valid var → wrong content, no
   crash, invisible to four-zeros + smoke. STRONGER than a slot-count check: it catches
   **complete-but-mislabeled** maps too (named == distinct, names at wrong slots). Dump
   upstream first: `git show upstream/main:data/prompts/prompts-<ver>.json > /tmp/upstream-<ver>.json`.
   Fix = adopt upstream's identifierMap (identifiers array must match first). See
   `REFERENCE.md → Bug class: mis-bind (override resolves to a wrong-but-valid var) + the
auditMisbinds gate`. A `named < distinct` jq is a weaker backstop for prompts upstream
   lacks.

A subtle override mislabel can pass the smoke test (the prompt path is never
invoked) and only crash later (`/code-review`, a conditional reminder). "READY came
back" ≠ "version bump complete." See also `REFERENCE.md → Bug class: code patch
applies clean but crashes a lazy UI path (capture-group lesson)`.

---

## §11 — Gotchas catalog (the battle scars a context-less agent will miss)

Each row links the full diagnostic in `REFERENCE.md`.

| Gotcha                                      | What bites                                                                                                                                                                                                 | Fix / REFERENCE.md section                                                                                                                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stale-backup downgrade**                  | `claude update` pulls a new pristine binary but the tweakcc backup stays old; `--restore` (and `--apply`'s restore-first on native) then copies the OLD binary over the new one → silent CC **downgrade**. | `rm` the trio (`native-binary.backup` + `native-claudejs-orig.js` + `native-claudejs-patched.js`) — **`rm`, not `mv` to `.stale-*`**. `--apply` re-extracts from the live binary. Driver `check` flags this. `REFERENCE.md → Stale-backup downgrade gotcha`. |
| **Commit-message bad-substitution**         | `git commit -m "…${VAR}…"` → shell "bad substitution" → commit silently doesn't run.                                                                                                                       | `git commit -F /tmp/msg.txt`; verify `git log -1`. `REFERENCE.md → Commit-message bad-substitution gotcha`.                                                                                                                                                  |
| **`data-anthropic-cli ${VERSION}`**         | validator flags it UNBOUND every bump.                                                                                                                                                                     | **Benign** — the prompt is a _double-quoted_ string in cli.js, so `${VERSION}` is inert literal text. Never escape it. `REFERENCE.md → Upstream comparison: … the data-anthropic-cli VERSION false-positive`.                                                |
| **`inline-*` validator false positives**    | a naïve orphan-var scan flags `inline-*` overrides (their `${H}`/`${GJH}` are minified idents) and `data-anthropic-cli`.                                                                                   | inline-blob overrides aren't in the prompts JSON and use positional remapping — don't check them against the identifierMap. `REFERENCE.md → The three override surfaces (named-prompt, inline-blob, system-reminders)`.                                      |
| **Fuzzy-carryover miss**                    | a renamed/re-opened prompt extracts anonymous and looks "removed".                                                                                                                                         | grep its content in cli.js; if present → `NEW_PROMPT_ASSIGNMENTS`, not an archive. §6. `REFERENCE.md → Fuzzy-carryover miss & NEW_PROMPT_ASSIGNMENTS`.                                                                                                       |
| **Identifier-slot shift**                   | `${LABEL(N)}` becomes a call on a string → runtime `TypeError`; apply is warning-free.                                                                                                                     | slot-aware `NEW_PROMPT_ASSIGNMENTS` overlay with the full new identifierMap. `REFERENCE.md → Bug class: ReferenceError VAR is not defined (orphan placeholder)`.                                                                                             |
| **Partial identifierMap (silent mis-bind)** | our map names fewer slots than the binary uses → a reused label binds to a wrong-but-valid var → **wrong content, no crash**; four-zeros + smoke both pass and the `UNKNOWN_N` validator misses it.        | name every slot (or borrow upstream's fuller map, confirming the `identifiers` array matches); run `tools/auditMisbinds.mjs`. `REFERENCE.md → Bug class: mis-bind … + the auditMisbinds gate`.                                                               |
| **Code patch crashes a lazy UI path**       | a regex-replace patch applies clean and boots, but a lazily-rendered TUI path (`/config`, `/theme`) crashes — e.g. a non-capturing prefix group read downstream rewrote a binding.                         | reused match groups MUST be capturing; add a regression test; smoke must exercise `/config` `/theme`. `REFERENCE.md → Bug class: code patch applies clean but crashes a lazy UI path (capture-group lesson)`.                                                |
| **CommonJS wrapper crash**                  | an override emitted a string into a JS template literal whose unescaped backslashes/backticks broke template parity → Bun rejects `cli.js` ("Expected CommonJS module to have a function wrapper").        | re-escape per the delimiter the prompt landed in. `REFERENCE.md → Bug class: CommonJS wrapper crash / template-literal escaping` + `→ The quote-context rule (delimiter decides whether to escape a placeholder)`.                                           |
| **Shared-constant split**                   | old combined override over-matches → duplicated sections in the assembled prompt; apply reports 0 errors.                                                                                                  | trim parent to shrunk pristine, populate split ids, leave `workflow-script-*` pristine. `REFERENCE.md → The override-realignment recipe …`.                                                                                                                  |
| **Override auto-recreation**                | `mv`-ing an override away → recreated from pristine next apply.                                                                                                                                            | to suppress, keep the `.md` with an **empty body**. `REFERENCE.md → The override-realignment recipe …`.                                                                                                                                                      |
| **Platform-minified names**                 | overrides that hardcode a minified ident crash a _different_ platform target.                                                                                                                              | the patcher remaps positionally; never hardcode one platform's minified name. `REFERENCE.md → Platform-minified names differ per target`.                                                                                                                    |
| **Seed from upstream**                      | seeding fuzzy carryover from upstream's JSON → mass anon fuzzy-misses.                                                                                                                                     | seed from **our own** latest `prompts-<prev>.json`. `REFERENCE.md → Fuzzy-carryover miss & NEW_PROMPT_ASSIGNMENTS`.                                                                                                                                          |
| **`claude` is a shell function**            | `execSync('claude …')` fails in node/sh.                                                                                                                                                                   | resolve the binary (`realpath` the `claude` launcher); the driver does this. `REFERENCE.md → Platform-minified names differ per target`.                                                                                                                     |

---

## §12 — Where the deep detail lives (REFERENCE.md owns the conventions)

This skill owns the **pipeline behavior**. The **why / judgment / bug-class
diagnostics** live in `REFERENCE.md` next to this file — read the relevant section,
don't expect this file to restate it. Section index:

1. The four zeros (the completion bar)
2. Bug class: patch failed to find (regex anchor drift)
3. Bug class: Could not find system prompt (override pristine/ccVersion drift)
4. Bug class: CommonJS wrapper crash / template-literal escaping
5. Bug class: ReferenceError VAR is not defined (orphan placeholder)
6. Bug class: mis-bind (override resolves to a wrong-but-valid var) + the auditMisbinds gate
7. Bug class: code patch applies clean but crashes a lazy UI path (capture-group lesson)
8. The quote-context rule (delimiter decides whether to escape a placeholder)
9. Fuzzy-carryover miss & NEW_PROMPT_ASSIGNMENTS
10. The override-realignment recipe (bump / retrim / resync / rename / inline / removed / suppress)
11. The three override surfaces (named-prompt, inline-blob, system-reminders)
12. Stale-backup downgrade gotcha
13. Commit-message bad-substitution gotcha
14. Platform-minified names differ per target
15. Upstream comparison: extractor canonical, no count regressions, the data-anthropic-cli VERSION false-positive
16. New-prompt naming: high-confidence auto-name vs content sign-off

The tweakcc-fixed `CLAUDE.md` (patch authoring + bug classes) and the overrides
repo's `CLAUDE.md` (lobotomization rules + the prompting checklist) carry the rest.

If you finish a bump and discover a _new_ gotcha, add it to §11 here **and** to the
matching `REFERENCE.md` section — the skill is the runbook, REFERENCE.md is the record.
