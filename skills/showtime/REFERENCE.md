# Showtime reference

Self-contained background for the public `showtime` skill: the completion bar, the
recurring bug classes, and the conventions you need to bring **tweakcc-fixed** (the
patcher) and its overrides repo up to a new Claude Code (CC) release without
shipping a silent downgrade or a latent crash. The skill points at the numbered
sections below; everything here is meant to be acted on by a stranger running the
tool on their **local** machine.

Two repos move together on the same release cycle:

- **tweakcc-fixed** — the patcher: regex code-patches in `src/patches/*.ts`, the
  prompt-JSON sync (`data/prompts/prompts-X.Y.Z.json`), the extractor
  (`tools/promptExtractor.js`), and the CLI/TUI.
- **the overrides repo** — the curated system-prompt overrides (`.md` files with
  frontmatter). The tweakcc README pairs the patcher with an overrides repo
  (`lobotomized-claude-code` by default); clone or symlink it where the README
  says. `~/.tweakcc/system-prompts` and `~/.tweakcc/system-reminders` are symlinks
  into that repo's active per-model override set; the patcher reads both at
  `--apply`. The `~/.tweakcc/...` layout is tweakcc's own convention.

The canonical pristine `cli.js` is `~/.tweakcc/native-claudejs-orig.js`, which the
patcher rewrites on every `--apply`. The patched copy is saved alongside as
`~/.tweakcc/native-claudejs-patched.js`. These two files (plus the native binary
backup) are your diffing anchors when something breaks.

---

## 1. The four zeros (the completion bar)

`blocking issues: 0` is necessary but **not** sufficient. A bump is done only when
**all four** counters are zero. Stopping at the first one ships silent regressions.

1. **Smoke** — `claude --print "say only the word READY"` returns `READY`. The
   binary boots and runs.
2. **Apply hygiene** — `--apply` output is only `✓` rows plus
   `Customizations applied successfully!`: zero `✗`, zero `failed to find`, zero
   `Could not find`, zero `Conflicts detected`, zero patch `no-op` lines, zero
   `WARNING`/`ENOENT`. "Acceptable noise" is the wrong framing — every warning has
   a root-cause fix or is downgraded to debug output.
3. **No orphan overrides** — the version-bump report's
   `prompt overrides not in JSON` is `0`. Every override `.md` maps to a live
   prompt id in the new JSON.
4. **No latent var breakage** — the orphan-`${VAR}` validator reports
   `UNKNOWN_N placeholders: 0` and `unbound labels: 0` across every override, AND
   the mis-bind audit (`node tools/auditMisbinds.mjs`) exits 0. (The one standing
   benign exception is `data-anthropic-cli`'s `${VERSION}` — see §15.)

Why all four matter: smoke alone is a boot-only check. Many failure modes (a
mislabeled override slot, a lazily-rendered TUI path, a conditional prompt that
never materializes at boot) pass the smoke test and only crash — or render wrong
content — later. `READY came back` is not `the bump is complete`. Smoke should
also exercise key post-patch UI paths (`/config`, `/theme`, `/help`), not just
boot — see §7.

---

## 2. Bug class: patch failed to find (regex anchor drift)

**Symptom.** During `--apply`: `patch: <name>: failed to find <pattern>`.

**Cause.** A code-patch in `src/patches/*.ts` anchors a regex on a minified-but-
stable shape that CC's new build changed: the bundler renamed an identifier, OR
Anthropic refactored the surrounding code, OR the feature the patch gated on got
promoted past that gate (the anchor literal is gone entirely).

**First decide which case you are in** by grepping the freshly extracted `cli.js`
for the anchor literal the patch keys on:

- **Matches present, regex still fails** → the shape changed. Add a new match
  method as the **first** attempt in the patch's match function
  (`// Method N: <description>`), keeping the older methods as zero-cost fallbacks
  for older CC versions. Don't delete old methods unless the old shape is gone
  from every CC version the tool supports.
- **Zero matches for the anchor literal** → the feature was promoted; Anthropic
  took over the gating. The right fix is a graceful no-op, not a regex hunt:

  ```typescript
  if (!file.includes('"the_anchor_literal"')) {
    console.log(
      'patch: <name>: feature already promoted in this CC build — no-op'
    );
    return file;
  }
  ```

**How to find the new shape.** Extract `cli.js` from the installed native binary,
grep for stable strings near the target (UI labels, config keys, English error
messages — these survive minification), then walk back from a unique anchor to the
function/object the patch needs. Write the regex to tolerate the same renames the
existing methods do: use `[$\w]+` for identifiers (CC's minifier emits `$` in many
names), anchor on literal punctuation (`,` `;` `{` `}`) rather than `\b` (`\b` is
slow on V8 and treats `$` inconsistently).

Also check the patch's `condition` in `src/patches/index.ts` before chasing regex
drift — a conditionally-skipped patch passes the four-zeros and smoke while silently
dropping a feature (e.g. a patch gated to NPM-only installs does nothing on a native
install). A vanished feature with a _clean_ apply is often a `condition` problem,
not a regex problem.

---

## 3. Bug class: Could not find system prompt (override pristine/ccVersion drift)

**Symptom.** During `--apply`: `Could not find system prompt 'X' in cli.js`.

**Cause.** The pristine regex for an override (built from the pieces in
`data/prompts/prompts-<ccVersion>.json`) doesn't match the running binary. Either
the override's `ccVersion:` frontmatter is older than the binary's actual CC
version, or the binary's prompt content diverged from what the JSON says.

**Fixes.**

- **`ccVersion:` is stale** → bump it to the binary's version and re-apply. Don't
  blindly bump without reading the pristine diff first (see §10).
- **Pristine pieces genuinely don't match the binary** → open the prompt id in
  `prompts-X.Y.Z.json`, grep its distinctive content against `cli.js`. If it's
  truly absent, the prompt was removed — archive the override (see §10, "removed").
- **Pristine matches but the generated regex escapes something wrong** → look at
  `buildSearchRegexFromPieces` in `src/systemPromptSync.ts`. Common culprits:
  non-ASCII chars, newlines (needs a `(?:\n|\\n)` alternation), backticks inside
  code blocks.

---

## 4. Bug class: CommonJS wrapper crash / template-literal escaping

**Symptom.** After `--apply`, launching `claude` errors with
`TypeError: Expected CommonJS module to have a function wrapper. ...` (native
install) or a raw syntax error inside `cli.js` (NPM install).

**Cause.** A prompt override emitted a string into a JS **template literal**
(backtick) whose unescaped backslashes or backticks broke template parity —
prematurely terminating the literal and leaving the rest of `cli.js` as floating
syntax. Anthropic stores prompts using a mix of single-quoted, double-quoted, and
backtick delimiters; each has different escape semantics, and override content must
be re-escaped for the _specific_ delimiter it lands in (see §8).

**How to debug.**

1. Diff the patched `cli.js` against `~/.tweakcc/native-claudejs-orig.js` and
   `~/.tweakcc/native-claudejs-patched.js`.
2. Find the patched span; look for unbalanced backticks, unescaped backslashes, a
   lone `${` with no closing `}`.
3. The fix lives in the per-delimiter escape logic: `src/patches/systemPrompts.ts`
   (the per-delimiter branches) and `escapeDepthZeroBackticks` in
   `src/systemPromptSync.ts`. Backslash-doubling is scoped to single/double-quote
   contexts; template literals get a separate parity-aware backtick-escape pass.

**Related distinct cause — stale Bun bytecode.** Bun caches compiled bytecode
alongside `cli.js`. If `--apply` writes new JS but doesn't invalidate the cached
bytecode, Bun re-runs the OLD bytecode and emits a similar error. The `clearBytecode`
flag handles this — make sure it's threaded through any new code path that mutates
`cli.js`.

---

## 5. Bug class: ReferenceError VAR is not defined (orphan placeholder)

**Symptom.** `--apply` is clean, but `claude` crashes on launch with
`ReferenceError: VAR is not defined`.

**Cause.** An override references `${VAR}` (a template interpolation) but `VAR` no
longer exists in the binary's runtime scope. Anthropic refactored the prompt and
inlined the variable as literal text, but the override still treats it as an
interpolation.

**Detection.** Run the orphan-`${VAR}` validator after every CC version bump and
every override edit. It cross-references each unescaped `${VAR}` in the overrides
against the pristine `identifierMap` for the current `ccVersion`. Don't defer the
fixes — an empty-string `identifierMap` entry (an `UNKNOWN_N`) is a latent
ReferenceError; read `cli.js` for the surrounding context, name the captures, and
fix the override in the same session.

**Per-orphan resolutions.**

- Swap to the new variable name Anthropic now uses.
- Replace `${VAR}` with the literal value Anthropic inlined.
- Escape as `\${VAR}` if the override author wanted a literal placeholder — but
  **only** when the prompt is stored in a backtick template literal. If it's stored
  in a single/double-quoted string, `${VAR}` is already inert literal text and
  escaping it corrupts the content (see §8 and §15).

---

## 6. Bug class: mis-bind (override resolves to a wrong-but-valid var) + the auditMisbinds gate

**Symptom.** None at apply, none at smoke. `--apply` is clean, the binary boots,
and the override renders **valid-but-wrong content** — or `${LABEL(N)}` becomes a
call on a string and throws a `TypeError` only when CC reaches that line.

**Cause.** Override placeholders are resolved **positionally**: a human-readable
label (`${SOME_NAME}`) maps to a slot in the prompt's `identifierMap`, and that slot
binds to whatever minified var actually sits there in the binary. Two ways this goes
wrong:

- **Partial map.** Our `identifierMap` names _fewer_ slots than the binary uses, so
  a reused label binds to a wrong-but-valid slot. Real case: a tool description's
  `${CANCEL_TIMEFRAME_DAYS}` resolved to a _function_ (a different slot) instead of
  the day-count number, so the rendered text read "auto-expire after `function …`
  days." No crash; invisible to the four-zeros (the lazy tool description never
  materializes at boot) and to the `UNKNOWN_N` validator (the override hardcoded or
  dropped the unnamed slots instead of leaving `${UNKNOWN_N}`).
- **Slot shift.** Anthropic added identifier slots to an existing prompt; carried-
  over labels stay attached to their old slot numbers, but those slots now point at
  different minified vars. `${OUTPUT_FORMAT_FN(N)}` that used to land on the
  formatter function now lands on a template-literal _string_, so at runtime
  `<string>(N)` throws `TypeError: ... is not a function`.

**Prevention.** The extractor takes upstream's complete `identifierMap` for every
_shared_ prompt (any prompt upstream also ships whose `identifiers` array matches
ours), gated on the `TWEAKCC_UPSTREAM_JSON` env var pointing at upstream's published
prompts JSON. Upstream labels every slot, so a shared prompt's placeholder lands on
the slot it means with no per-prompt curation — a mis-bind is structurally
impossible for shared prompts. Only net-new prompts (upstream lacks them) use our
generated names.

**Detection — the auditMisbinds gate.** `node tools/auditMisbinds.mjs` (run in the
driver's `check` and as part of the four-zeros) exits 1 on any finding: for every
override, every placeholder it _uses_ must sit at the same `identifierMap` slot as
upstream's complete map. This is stronger than a `named < distinct-slots` count
check — it catches **complete-but-mislabeled** maps too (where the count matches but
labels sit at wrong slots), which a count check never flags. Dump upstream's JSON
first so the audit has a reference; it skips gracefully when no upstream reference
is available.

**Fix.** Adopt the complete `identifierMap` for that prompt — name all slots in the
extractor's new-prompt assignments (see §9), confirming the `identifiers` array
matches upstream's first — then realign the override against the corrected slots. A
slot-shift fix uses an assignment matcher anchored on text unique to the new shape,
supplying the _entire_ new `identifierMap` (every slot, named correctly).

---

## 7. Bug class: code patch applies clean but crashes a lazy UI path (capture-group lesson)

**Symptom.** A regex-replace patch in `src/patches/*.ts` applies with 0 errors and
the binary boots (smoke = READY), but a lazily-rendered TUI path crashes — e.g.
`/config` dies with `undefined is not an object (evaluating '<map>[...]')`.

**Cause.** The code-patch analog of the override mis-bind. Real case: the themes
patch used a **non-capturing** prefix group `(?:return|[$\w]+=)`, but the writer
read `objMatch[1]` as the assignment prefix. That capture was `undefined`, so the
prefix defaulted to `'return'` and a theme-map assignment `hM3={...}` got rewritten
to `return{...}` — destroying the binding. `/config` then crashed reading the now-
undefined map. The four-zeros and a boot-only smoke missed it because `/config` is
never materialized by `claude --print READY`.

**Detection.** Any patch that reuses a regex group via `match[N]` in its writer MUST
capture that group. Grep `src/patches` for first-groups written as `(?:…)` whose
match index is read downstream. Add a regression test per patch asserting the
binding/structure it depends on survives the rewrite. Smoke must exercise `/config`,
`/theme`, `/help`, not just boot.

**Fix.** Make the reused group capturing — `(return|[$\w]+=)` — so the writer
preserves the real assignment prefix. That prefix is **platform-specific** (the
theme-map name differs per minify target; see §14) — never hardcode it; always read
it from the live capture.

---

## 8. The quote-context rule (delimiter decides whether to escape a placeholder)

The delimiter a prompt is stored in inside `cli.js` decides whether `${VAR}` is a
live interpolation or inert literal text — and therefore whether it must be escaped.

- **Backtick template literal** → `${VAR}` **interpolates** at runtime. The var
  must exist in scope (else §5's ReferenceError), and a literal `${...}` you want
  to survive must be escaped `\${...}`. Backslashes and backticks in override
  content must be parity-escaped for the template (else §4's wrapper crash).
- **Single- or double-quoted string** → `${VAR}` is **inert literal characters**.
  There is no interpolation and no ReferenceError is possible. **Do not escape it** —
  escaping pushes a literal backslash into the content (the double/single-quote
  escape pass doubles it), corrupting whatever the model reads (e.g. an install
  command or an MCP-config example).

To tell which delimiter a prompt uses, grep `~/.tweakcc/native-claudejs-orig.js`
for the `var <ID>=` assignment that precedes the prompt's content. The first
character after `=` (`` ` ``, `'`, or `"`) is the delimiter. The patcher's escape
logic is per-delimiter for exactly this reason (§4): override content destined for
one delimiter is re-escaped to survive _that_ delimiter's parser.

---

## 9. Fuzzy-carryover miss & NEW_PROMPT_ASSIGNMENTS

**The extractor's carryover.** When you re-extract prompts for a new CC version, the
extractor seeds names from the _previous_ version's `prompts-<prev>.json` by fuzzy-
matching on the **first ~100 chars** of each prompt's reconstructed content. Always
seed from **our own** previous JSON, never from upstream's — different naming
conventions produce mass fuzzy-misses.

**The miss.** If Anthropic edited a prompt's _opening_ (a rename, or wrapping it in
a `${flag()?A:B}` conditional), the fingerprint changes and the carried name
silently drops — the prompt extracts **anonymous**. This looks identical to a real
removal but is not one. To distinguish, grep the "removed" id's _distinctive
content_ against the freshly extracted `cli.js`:

- **0 hits** → genuine removal → archive the override (see §10, "removed").
- **hits present** → fuzzy-miss → restore the name with a `NEW_PROMPT_ASSIGNMENTS`
  entry, then re-seed and re-run the extractor.

**NEW_PROMPT_ASSIGNMENTS** (in `tools/promptExtractor.js`) maps a content matcher to
a name/id/description (and, for a slot fix, a complete `identifierMap`). It's used
for two things: restoring fuzzy-missed names, and naming **genuinely new** prompts.
High-confidence naming of new prompts via this map is allowed automatically — but
prompt _content_ and the corresponding override edits need explicit sign-off (see
§16). Before naming a new prompt, dig the binary for its identity: registration
function, model-invocation gating, skill frontmatter. Place newer-shape entries
_before_ older fallbacks in the array, since the lookup returns the first match.

**No-regression bar.** Print prev-named / current-named counts. The current named
count must not drop below the previous unless each dropped id is **verified gone**
from `cli.js` (a fuzzy-miss looks exactly like a removal — confirm by grepping
content). See §15 for the upstream-comparison angle.

---

## 10. The override-realignment recipe (bump / retrim / resync / rename / inline / removed / suppress)

After the new prompts JSON lands, `--apply` may report
`Conflicts detected for N system prompt file(s)` — overrides whose pristine drifted
(their `ccVersion:` is older than the prompt's current version). The overrides still
_apply_ (0 `Could not find`); the conflict is advisory: "the pristine you tuned
against has moved — review." Drive it to **0 conflicts**. **Read every diff** —
bumping `ccVersion:` without reading the pristine-old → pristine-new diff is the lazy
path and silently keeps stale content. Classify each:

- **Trivial drift** (whitespace, a conditional wrapper a full-replacement body
  supersedes, a removed example) → **mechanical ccVersion bump** of the `.md`
  frontmatter. The target version comes from the prompt's `version` in
  `prompts-X.Y.Z.json`.
- **Real content change** (Anthropic added/removed a meaningful section, OR
  rewrote/reformatted the prompt) → **re-trim the override against the NEW pristine**
  in the override's established style, keeping every load-bearing
  command/path/field/error-tag and cutting prose. A rewrite/reformat is the same
  class: **always re-trim, never keep old-flow/old-format content.** Keeping stale
  content is a silent correctness bug — it applies warning-free and passes smoke
  while injecting now-wrong instructions. (Distinguish from a mechanical bump: if the
  override is still a valid leaner-than-latest trim and Anthropic only _added/reworded_
  detail, a ccVersion bump is enough; if Anthropic _replaced_ the flow the override
  describes, you must re-trim.)
- **Renamed id** — the content survives under a new id. `git mv` the override to the
  new id and bump its `ccVersion:`. Confirm by grepping distinctive content from the
  override body in the new JSON.
- **Inlined id** — the prompt's content was merged into a larger prompt. Archive the
  override; the parent prompt's override likely already carries the inlined content.
- **Removed id** — distinctive strings from the override appear nowhere in the new
  JSON. Archive the override (move it to an `orphans-removed-for-X.Y.Z/` dir);
  recoverable from there or git history if the feature returns.
- **Prompt split into shared constants** — a combined prompt's sub-sections move to
  shared `var`s referenced by both inline cells and a bundled workflow. Trim the
  parent override to its shrunk pristine, populate the new split ids with the
  reshaped sub-sections, and leave the bundled `workflow-script-*` override pristine
  (it references the same constants — DRY propagation).
- **Suppress a prompt** — keep its `.md` present with an **empty body**. Do NOT move
  the file away: `syncPrompt` auto-recreates a pristine `.md` for any JSON id lacking
  one on the next `--apply`, so a moved-away override comes back. An empty body is the
  intended suppression signal.

After realigning, re-run the health check → 0 conflicts.

---

## 11. The three override surfaces (named-prompt, inline-blob, system-reminders)

There are **three** distinct override targets — it's easy to reshape one and forget
the other two on a model-card pass:

1. **Named-prompt overrides** — one `.md` per prompt id in `prompts-X.Y.Z.json`.
   These carry `ccVersion:` frontmatter and resolve placeholders against the
   `identifierMap`.
2. **Inline-blob overrides** (`inline-*.md`) — content spliced into a larger blob,
   not standalone prompts in the JSON. They use **positional** remapping of `${...}`
   interpolations / array identifiers (the patcher binds them to whatever the binary
   carries at apply time). A naïve orphan-`${VAR}` scan flags their minified idents
   (`${H}`, `${GJH}`) as unbound — **false positives**: don't check inline-blob
   overrides against the named-prompt `identifierMap`.
3. **System-reminder overrides** (`system-reminders/*.md`) — a registry of code-
   patch-injected reminder bodies. Each has a vanilla `defaultBody`; an empty body
   suppresses the reminder. These are prompts too: on a model-card reshape, diff each
   `<id>.md` body against its `defaultBody` and judge each one against the new model's
   behavior, just like the named prompts.

---

## 12. Stale-backup downgrade gotcha

**What bites.** `claude update` pulls a new pristine binary, but the tweakcc backup
(`native-binary.backup` + `native-claudejs-orig.js` + `native-claudejs-patched.js`)
stays on the OLD version. `--restore` then copies the OLD binary over the new one →
a **silent CC downgrade**. `--apply` also restores-from-backup-first for native
installs, so it downgrades too.

**Fix.** When the CC version actually changed, **`rm`** the stale backup trio — `rm`,
not `mv` to a `.stale-*` archive (archiving stacks up hundreds of MB of slop over a
few bumps, and `--apply` re-extracts from the live binary anyway). The driver's
health check flags this condition before it can bite.

**Backup-vintage trap.** Grepping the native _binary_ backup for a version pattern
returns a bundled-lib version, NOT CC's version. Read the vintage off the extracted
`native-claudejs-orig.js` instead.

---

## 13. Commit-message bad-substitution gotcha

**What bites.** `git commit -m "…${VAR}…"` in zsh/bash **expands `${...}` and
backticks inside the double-quoted message** → `bad substitution` → the commit
silently doesn't happen. Pipeline commit messages are full of `${VAR}`, `${?...}`,
and backticked code, so this fires constantly.

**Fix.** Write the message to a file and use `git commit -F /tmp/msg.txt`. Verify
afterward with `git log -1`. Commit each logical change separately (prompt sync,
patch fix, README bump, override realignment) with descriptive messages.

---

## 14. Platform-minified names differ per target

CC ships as Bun-compiled native binaries, and **the same `cli.js` source is minified
to different identifier names per target** (darwin-arm64 vs linux-x64 vs linux-arm64,
etc.). The same source-level variable gets a different minified name on each platform.
Anything that hardcodes one platform's minified name — a `${VAR}` in a template
override, a bare identifier in a raw-passthrough array body, a `${EXPR.method()}`
inline expression, or a captured assignment prefix in a code patch — will crash the
_other_ platform with `ReferenceError: VAR is not defined`,
`Cannot access 'J' before initialization`, or a named-prompt regex that matches one
platform's pristine but not the other.

The patcher handles this with **positional remapping**, not hardcoded names:

1. Inline-blob template overrides — captures the pristine template's `${...}`
   expressions in order, rewrites the override's positional placeholders to whatever
   the binary actually carries.
2. Inline-blob array raw-passthrough overrides — a JS-aware tokenizer finds free
   identifiers in the pristine array body and positionally rewrites the override.
3. Named system-prompt regex builder — when a piece contains a complex inline
   `${...}`, the builder substitutes a `\$\{[^{}]*\}` wildcard before escaping, so the
   pattern matches any single-level interpolation regardless of the minified name.
4. System-reminder case-body wrappers — discovers the array-wrapper / message-
   constructor / feature-gate identifiers from the existing body rather than
   hardcoding them.

**Consequence for the bar.** A clean apply on one platform does not prove valid
emission on another — only a smoke test on that platform does. If you patch on more
than one OS/arch, **every** platform must smoke green before the work is complete.
Never hardcode one platform's minified name anywhere — in an override or a code patch.

---

## 15. Upstream comparison: extractor canonical, no count regressions, the data-anthropic-cli VERSION false-positive

**Our extractor is canonical.** Do not merge upstream and do not pull upstream's
prompts JSON into the tree. Fetch upstream as a **comparison signal only**:
`git show upstream/main:data/prompts/prompts-X.Y.Z.json > /tmp/upstream-X.Y.Z.json`,
then compare named-count and id-sets against your freshly extracted JSON. Cherry-pick
a single upstream data file or one-off fix only if it materially beats ours.

**Two things to verify against upstream each bump:**

- **No count regression.** The named-prompt count must not drop versus the previous
  version unless every dropped id is verified absent from the current `cli.js` (a
  fuzzy-rename miss, §9, looks identical to a real removal). Compare against upstream
  to catch coverage gaps.
- **Per-prompt identifierMap adoption.** Where upstream's `identifierMap` for a
  specific prompt is fuller or fresher than ours (and its `identifiers` array
  matches), adopt upstream's map for that prompt and realign the override — that's
  how mis-binds (§6) are prevented for shared prompts. Don't wholesale-rename the
  whole corpus to upstream's vocabulary: override names are keyed to **our** JSON's
  `identifierMap` by human-readable name, so a mass rename to a different vocabulary
  breaks every override against our JSON. The underlying vars are positional captures
  — names are ours, slots come from upstream.

**The data-anthropic-cli `${VERSION}` false-positive.** On every bump the orphan-var
validator flags `data-anthropic-cli`'s `${VERSION}` as UNBOUND (its `identifierMap`
is empty). This is **benign — never escape it.** The prompt is stored in a
_double-quoted_ string in `cli.js`, so `${VERSION}` is inert literal shell-var text
(a placeholder the user fills when downloading the CLI), not a JS interpolation — it
cannot throw a ReferenceError. Escaping it would double the backslash and corrupt the
install docs the model reads. This generalizes (§8): **a `${UPPER_SNAKE}` flagged
UNBOUND is benign iff the prompt is stored in a single/double-quoted string** — grep
`~/.tweakcc/native-claudejs-orig.js` for the `var <ID>=` assignment and check the
delimiter; only a backtick template literal can actually interpolate. Count these as
benign; leave them untouched.

---

## 16. New-prompt naming: high-confidence auto-name vs content sign-off

When a CC bump introduces genuinely new prompts (no previous-version entry to fuzzy-
match), two different things have two different bars:

- **Naming** — assigning a high-confidence id/name/description via
  `NEW_PROMPT_ASSIGNMENTS` is allowed **automatically**, _provided_ you've grounded
  the identity in the binary first: read the registration function, any model-
  invocation/disable gating, the injection model, and skill frontmatter. The matcher
  keys on text from the raw template-literal source. Don't guess a name from a single
  snippet — dig until the identity is unambiguous.
- **Content / override edits** — writing or reshaping the _override body_ for a new
  prompt requires **explicit user sign-off**. Never autonomously write an override
  for a new prompt or decide its lobotomization on your own. Present the full context
  (what the prompt does, how it's gated, how it's injected) and propose names; let the
  user approve before you commit override content.

The split exists because a wrong _name_ is a cheap rename, but a wrong _override body_
silently changes what the model is told — and (per §6) can pass the four-zeros and
smoke while rendering wrong content on a lazy path.
