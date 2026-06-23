# fff ↔ ripgrep native integration — implementation plan

**Branch:** `experimental-fff`
**Author:** skrabe (with Codex GPT-5.5 xhigh design consultation, recorded in §6)
**Status:** design locked, not yet built. This document is the source of truth for the build.
**Scope rule:** everything here is verified against fff's source (`github.com/dmtrKovalenko/fff` @ v0.9.6, cloned and read) and the installed Claude Code `cli.js` (CC 2.1.186, `~/.tweakcc/native-claudejs-orig.js`). Claims marked **[VERIFIED]** were read from source/binary. Claims marked **[TO VERIFY]** must be confirmed before the code they gate is written. No claim in this doc is from memory or assumption.

---

## 0. TL;DR — the converged decision

> **⚠ ARCHITECTURE PIVOTED (2026-06-23) — see §19.** §1–18 describe the Grep-tool-backed design, which CC 2.1.186 bypasses for the main agent (Grep/Glob tools removed by default). The shipping design is now Bash-world fff (a `fff` CLI on PATH + best-practice instruction-appends across agent scopes). §1–18 remain as the verified groundwork (wrapper correctness, the resolver/contract analysis, subagent path).

We are **not** building a transparent "rg → fff" binary swap. That was the original framing; it dies on contact with the evidence (fff ships no grep CLI; the one resolver also feeds Glob + internal enumeration fff can't do; fff's strength is discovery, not exact search). After an adversarial research pass and a two-round design consultation with Codex GPT-5.5 xhigh, the shipped design is:

1. **Real ripgrep stays the DEFAULT Grep backend.** CC's Grep contract (rg-compatible, exact, exhaustive, deterministic) is preserved unchanged for every existing call.
2. **fff is added as an explicit, opt-in DISCOVERY capability.** A new `fuzzy?: boolean` param on CC's Grep tool. When `fuzzy:true`, the search routes to fff's fuzzy/ranked engine — a capability rg fundamentally lacks (typo-tolerant, frecency-ranked, definition-first symbol discovery). When absent/false, it's plain rg.
3. **The Grep tool description is rewritten** to teach bare-identifier query style, discourage regex-first habits, and honestly advertise the new fuzzy lever.
4. **Promotion to default-for-exact is EARNED, not assumed.** Only after a shadow-mode equivalence harness proves fff's exact-literal results match `rg` byte-for-byte (set, not just order) do we consider routing simple exact content searches through fff for its ranking benefit — and even then behind measured gates with rg fallback on any uncertainty.

**The invariant that governs the whole feature:** _fff is a discovery/optimization backend, not a replacement contract. Claude Code's Grep returns rg-compatible exact results unless the model explicitly asks for fuzzy._

This directly answers the original question — _"why default to plain? why not let the model choose?"_ — in the affirmative: **the model chooses, via `fuzzy:true`.** The adapter owns the plain-vs-regex distinction (the model is bad at that and shouldn't); the model owns the exact-vs-discovery intent (it knows that, and it's the valuable lever).

---

## 1. Goal & constraints

**Goal.** Give Claude Code first-class access to fff's search quality _natively_ — patched into `cli.js`, invisible at the model's reliance layer — rather than via fff's shipped MCP-server + `CLAUDE.md`-nudge integration, which is unreliable (fff's own issue #440: agents ignore the "use fff" instruction and fall back to rg). The user's words: "core of this tweakcc app is to have tweakability to CC's core, not relying that the agent will follow MCP via CLAUDE.md."

**Hard constraints (from the codebase + memory):**

- Patches are regex-anchored splices into minified `cli.js`; they must survive CC version bumps (anchor on **string literals**, never minified identifiers — `sLt`/`d2i`/`Qie` are darwin-bundle names that differ on linux-arm64/x64).
- Distribution is npm: `npx -y tweakcc-fixed@X --apply`. Boxes (incl. the two VPS mirrors: hermes aarch64, tencent x64) need **no checkout/build** — runtime assets are fetched from the repo `main`. Anything the feature needs at apply-time must be downloadable + checksummed.
- Cross-platform: darwin-arm64 (dev), linux-arm64 (hermes), linux-x64 (tencent). All three must smoke green.
- The "four-zeros" bar (0 errors, 0 warnings, 0 orphan vars, 0 unknown slots) plus a **real PTY TUI turn** — `--print` smoke misses interactive-only bugs (memory `reference_print_smoke_misses_interactive_prompt_bugs`).
- Silent-wrong-results is the **release-blocker class** (memory `reference_silent_binary_corruption_invisible_to_four_zeros`). This feature's entire risk surface is this class, so verification is non-negotiable.
- Off by default. This changes a core tool's behavior; it's a `PatchGroup.FEATURES` opt-in toggle.

---

## 2. Ground truth — fff [VERIFIED from cloned source @ v0.9.6]

### 2.1 fff ships NO grep CLI

The only executable in the workspace is **`fff-mcp`**, a stdio MCP/JSON-RPC server. `crates/fff-mcp/Cargo.toml` has a single `[[bin]]` (`fff-mcp`, `src/main.rs`). `main.rs` parses args and, unless `--healthcheck`, unconditionally calls `server.serve(stdio())`. Empirically (downloaded the real macos-arm64 v0.9.6 binary, sha256 `29a7fade…` matching the install script):

```
./fff-mcp --help     → no subcommands; usage: fff-mcp [OPTIONS] [PATH] [NO_CONTENT_INDEXING]
./fff-mcp grep 'x'   → clap error (parses 'grep' as PATH, 'x' as the bool positional)
./fff-mcp --files    → error: unexpected argument '--files'
./fff-mcp --version  → fff-mcp 0.9.6 (28321da…)
```

`fff-grep` is a **library crate** (`lib.rs`, deps bstr+memchr) with no `main`. There is nothing to shell out to as a drop-in `rg`. **Consequence:** any non-MCP integration must consume fff as a **library** (`libfff_c` C-ABI cdylib, or the `@ff-labs/fff-node` SDK, or vendoring the `fff-search` crate) — we write the executable.

### 2.2 The library content-search API [VERIFIED — `fff-core/src/grep.rs`, README]

```
content_search(query, { mode: plain|regex|fuzzy, smart_case, max_file_size,
                        max_matches_per_file, page_size, file_offset,
                        before_context, after_context, time_budget_ms,
                        classify_definitions, trim_whitespace })
  → GrepResult { items, total_matched, total_files_searched, total_files,
                 filtered_file_count, next_file_offset, regex_fallback_error? }
```

Each match item (`GrepMatch`): `file_index`, `line_number` (1-based), `col` (0-based byte), `byte_offset`, `line_content` (truncated to `MAX_LINE_DISPLAY_LEN`), `match_byte_offsets[]` (spans), `fuzzy_score?` (Fuzzy mode only), `is_definition`. **This is the clean mapping target** for CC's `PATH:LINENO:TEXT` contract (we have real line numbers — citations stay accurate).

`GrepMode` (verified enum):

- **PlainText** (default) — literal search via SIMD `memchr::memmem`; regex chars are literal.
- **Regex** — `regex::bytes::Regex` (the Rust `regex` crate — **no PCRE: no lookaround, no backreferences**). Invalid regex → 0 results (not an error), with `regex_fallback_error` set.
- **Fuzzy** — `neo_frizbee` Smith-Waterman scoring; lines ranked by score; matched char positions reported as highlight ranges.

### 2.3 How fff-mcp picks mode (the canonical "tool owns strategy" design) [VERIFIED — `fff-mcp/src/server.rs`]

The agent **never** selects mode. The `grep` tool computes:

```rust
let mode = if has_regex_metacharacters(grep_text) { GrepMode::Regex } else { GrepMode::PlainText };
// has_regex_metacharacters(t) = (regex::escape(t) != t)  — ANY metachar ⇒ Regex
```

On **zero exact matches + first page**, `perform_grep` cascades:

1. **Auto-broaden** — if the query is ≥2 whitespace words and the first isn't a constraint, drop the first word and retry (re-detecting regex on the remainder); if that yields ≤10 matches, return them prefixed `"0 matches for '…'. Auto-broadened to '…':"`.
2. **Fuzzy fallback** — `cleanup_fuzzy_query` (lowercase, strip `:-_`) → `GrepMode::Fuzzy`, return top 3 prefixed **`"0 exact matches. N approximate:"`**.
3. **File-path fallback** — if the query contains `/`, fuzzy file-search; if a strong match, return `"0 content matches. But there is a relevant file path: …"`.
4. Else `"0 matches."`

Output modes (`fff-mcp/src/output.rs`): `Content`, `FilesWithMatches`, `Count`, **`Usage`** (a 4th mode CC has no equivalent for — context-rich usage view). The MCP grep tool's deployed input schema is `{query, maxResults, output_mode, cursor}` — **no `mode`, no `caseSensitive`, no `context` param** (those live only in the library / multi_grep). Output is a **pre-rendered human text blob** inside the JSON-RPC envelope (not per-match objects), so driving fff-mcp would mean text-parsing its blob _and_ implementing an MCP client. → **We use the library, not fff-mcp**, to get the `mode` dial + structured output (see §11).

### 2.4 fff's agent-facing philosophy [VERIFIED — `MCP_INSTRUCTIONS` in `fff-mcp/src/main.rs`]

The server instructions string (fff's own guidance to agents) is the model for our rewritten Grep description:

- grep is the DEFAULT; **"Search BARE IDENTIFIERS only"** — `InProgressQuote`, not `struct ActorAuth`, not `load.*metadata.*InProgressQuote`, not `ctx.data::<ActorAuth>`.
- **"NEVER use regex unless you truly need alternation"** — `.*`, `\d+`, `\s+` almost always return 0 results because matches are single-line.
- **"Stop searching after 2 greps — READ the code."**
- Use `multi_grep` for case variants (`['ActorAuth','actor_auth']`).
- Inline constraint DSL: `*.rs query`, `src/ query`, `!test/`, `!*.spec.ts` (bare words are NOT constraints).
- Output auto-expands definition bodies (`|` = body context, `[def]` markers, `→ Read` suggestions).

**Note on multiline:** `grep.rs` has `has_unescaped_newline_escape` / `replace_unescaped_newline_escapes` — fff's engine _can_ match a pattern containing a literal `\n`, but this is **not** rg's `-U --multiline-dotall` (dot-matches-newline) semantics. Treat fff as single-line for our purposes; multiline → rg.

### 2.5 fff's "skill / CLAUDE.md" integration (the one we're replacing) [VERIFIED — README]

fff's documented Claude Code path: install `fff-mcp`, `claude mcp add fff -- fff-mcp`, and add to `CLAUDE.md`: _"For any file search or grep in the current git-indexed directory, use fff tools."_ fff ships no Claude Code _skill_. This path is **unreliable** — issue #440: a user followed it to the letter and the agent "more often than not" still used native tools and rg. Our native patch supersedes this: the model can't "decline" a tool whose backend we've swapped.

### 2.6 Platforms & artifacts [VERIFIED — releases + install-mcp.sh, SHAs recorded]

Prebuilt `fff-mcp` exists for macos-arm64/x64, linux-arm64/x64 (musl static), windows-x64/arm64. **Library** artifacts per triple: `c-lib-<triple>.dylib/.so/.dll` (C FFI) and `<triple>.dylib/.so` (nvim FFI). All three of our targets (darwin-arm64, linux-arm64, linux-x64) are covered. Pinned SHAs for the binaries are recorded in the research notes; library-artifact SHAs are **[TO VERIFY]** (pin them before download code ships).

---

## 3. Ground truth — Claude Code's ripgrep contract [VERIFIED from cli.js, CC 2.1.186]

### 3.1 The resolver and its blast radius

One memoized resolver (`sLt`, darwin name) returns `{mode, command, args, argv0}`; a shared accessor (`l$e`) exposes `{rgPath, rgArgs, argv0}`. **Four spawn sites share it:**

1. `d2i` — the core Grep searcher.
2. `JId` — file-count worker (`--files --hidden`).
3. `h2i` — one-time version self-test (gates first search).
4. `Qie`-based exclusion/file-listing (e.g. gitignore-exclusion scan `--files --hidden --no-ignore --max-depth 4`), and the **Glob tool**.

Resolver body (verified literal):

```
USE_BUILTIN_RIPGREP falsy → system: {mode:"system",command:<which rg>,args:[]}
else if embedded available → {mode:"embedded",command:process.execPath,args:["--no-config"],argv0:"rg"}
else → {mode:"system",command:<which rg>,args:[]}
```

**Critical:** the resolver also feeds **Glob + the internal `--files` enumeration callers** (`--files [--sort=modified] [--follow] [--no-ignore] [--max-depth N] -g !pattern`) — deterministic, exhaustive, mtime-sorted, ignore-aware full file enumeration. fff's `find_files` is fuzzy/frecency/query-required and **architecturally cannot** do this; there is **no model-facing description** for these callers, so no prompt can reshape them. → They MUST stay on rg.

### 3.2 Output contract — PLAIN TEXT, not JSON [VERIFIED]

CC does **not** use `rg --json` (0 occurrences of `submatches`/`absolute_offset`/`data.lines.text` in cli.js; every `--json` hit is a gh-CLI flag table). The resolver buffers stdout (20MB cap), then `.trim().split("\n").map(strip trailing \r).filter(Boolean)` → array of lines. Per `output_mode`:

- **content** (default for the tool's internal use; tool default param is `files_with_matches`): `PATH:LINENO:TEXT` — split on **first** `:` after an optional `^[A-Za-z]:` drive prefix. `-n` on by default; `-H` implied.
- **count**: `PATH:COUNT` (from `-c -H`) — split on **last** `:`, `parseInt`.
- **files_with_matches**: bare `PATH` per line (from `-l`) — CC `stat()`s each, sorts mtime-desc then path-asc.
- `head_limit` applied client-side (default 250; 0 = unlimited). 20MB stdout cap. **Byte offsets / submatch columns are never read** — only path, optional 1-based line number, and (count) the integer.

### 3.3 Exit codes & version gate [VERIFIED]

- Exit `1` = **no matches (success)** → resolves `[]`. Exit `0` = matches. ENOENT/EACCES/EPERM → reject. EAGAIN (os error 11) → retry once with `-j 1` prepended.
- **Version self-test (`h2i`):** requires `--version` stdout to `startsWith("ripgrep ")` (literal, trailing space — verified). Else `working:false`, **the Grep tool is disabled**, `tengu_ripgrep_availability` telemetry reports broken.

### 3.4 The Grep tool's model-facing surface [VERIFIED — quoted]

Tool name `Ac='Grep'`. Description (abridged, full text in research notes): *"A powerful search tool built on ripgrep … Supports full regex syntax (e.g. \"log.*Error\", \"function\\s+\\w+\") … Output modes: content / files_with_matches (default) / count … Multiline matching: … use `multiline: true`."\* Per-param zod `.describe()` strings (`OHp`): `pattern`, `path`, `glob` ("rg --glob"), `output_mode` (enum content|files_with_matches|count), `-A`/`-B`/`-C`/`context`, `-n`, `-i`, `-o`, `type` ("rg --type"), `head_limit`, `offset`, `multiline` ("rg -U --multiline-dotall"). **This description actively trains the wrong (regex-first) behavior for fff** — rewriting it is core to the feature, not cosmetic.

### 3.5 Arg-builder & override surfaces [VERIFIED]

- Arg-builder (anchor `["--hidden"];for(let O of LHp)T.push("--glob",`!${O}`)…T.push("--max-columns","500")` then per-request flag pushes) is where we inject the fuzzy sentinel (§9.4).
- Spawn arg vector: `c=[...rgArgs,...(EAGAIN?["-j","1"]:[]),...extraArgs,pattern]`.
- `config.json`/`hc.ripgrep` (`{command,args,argv0}` zod schema) feeds **only the sandbox wrap/preflight**, NOT the real Grep spawns → cannot be used to repoint; the patch must target the resolver `sLt`.
- Other literals: ENOENT `"ripgrep not found on PATH…"` (`jId`), telemetry `tengu_ripgrep_availability`, doctor UI `"ripgrep (rg): found/not found"`.

---

## 4. The mode-ownership decision (answering the original question)

> _"Why default to plain? Why not give the model the ability to choose? What does fff/MCP/API do? What about the CLAUDE.md instruction?"_

| Surface                       | Who picks search mode         | How                                                                                                                                     |
| ----------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **fff library**               | the **caller** (programmatic) | explicit `mode: plain\|regex\|fuzzy`                                                                                                    |
| **fff-mcp tool**              | the **tool** (auto)           | `has_regex_metacharacters` → plain/regex; zero-result cascade → fuzzy/broaden/path. Agent only passes a query.                          |
| **fff CLAUDE.md instruction** | n/a (style only)              | tells the agent _how to phrase_ ("bare identifiers", "never regex"), never which mode                                                   |
| **Claude Code Grep today**    | the **model** (implicitly)    | model writes ripgrep regex; rg executes it literally                                                                                    |
| **Our design**                | **split**                     | adapter owns plain-vs-regex (model is bad at it); **model owns exact-vs-fuzzy** via `fuzzy:true` (the valuable, well-understood intent) |

**Resolution:** "default to plain" was importing rg's exactness assumption. The correct split: the adapter decides plain-vs-regex deterministically (and routes regex to rg entirely — fff is not a better regex engine), while the **model is given the one choice it's actually good at and that adds capability: exact (default) vs fuzzy-discovery (opt-in)**. This is the honest middle path — neither hiding fff's power (lobotomizing) nor forcing the model to micro-manage strategy (fff's author deliberately avoided that, and he's right that LLMs choose plain-vs-regex badly).

---

## 5. Final architecture: additive-first → earn the swap

Two phases of _capability_, independent of the build phases in §15:

**Stage 1 — Additive discovery (ship this first).**

- rg is the default Grep backend. Everything works exactly as today.
- New `fuzzy?: boolean` on the Grep tool. `fuzzy:true` → fff fuzzy/ranked content search (the new capability). `fuzzy` absent/false → rg.
- Rewritten Grep description teaches bare-identifier style + the fuzzy lever.
- Observable: log route decisions (fff vs rg) so we can measure how often the model uses fuzzy and on what.

**Stage 2 — Promote exact ranked search (only after validation).**

- A **shadow-mode equivalence harness** runs fff-exact and rg side-by-side on a query corpus, asserting fff returns the **same set** (not just order) as `rg`, with the same ignore/encoding/limit behavior.
- Only the slices that pass become eligible to route through fff-exact for its **ranking** benefit (right file/line in the top-N → less wasted context). Even then: wrapper falls back to rg on any truncation/uncertainty; `count` and high/unlimited `head_limit` stay on rg permanently until separately proven.

**The invariant (repeat):** CC Grep returns rg-compatible exact results unless `fuzzy:true`. fff is a discovery/optimization backend layered on top, never a silent replacement of the exact contract.

---

## 6. Design consultation record (Codex GPT-5.5 xhigh, 2 rounds)

Kept because the _why_ behind the conservative choices matters for future maintainers.

**My initial lean:** hybrid (C) — tool owns an auto plain/regex + broaden→fuzzy→path cascade by default; expose fuzzy as opt-in; default to exhaustive literal.

**Round 1 — Codex corrected:**

- **No silent fuzzy cascade in Grep output.** In an rg-shaped tool, "no exact → here are approximate" is a semantic type-change the model will treat as evidence during edits/refactors. fff's cascade works because fff's _whole contract_ is discovery; CC's Grep contract is exact. → Fuzzy must be opt-in or advisory-only, never blended into `PATH:LINENO:TEXT`.
- **Any regex metachar → rg.** Don't classify "simple" vs "real" regex. fff isn't a better regex engine; its strength is symbol discovery. Routing simplicity > cleverness.
- **count → rg** until fff counting is proven byte-for-byte vs `rg -F`.
- **`fuzzy:boolean`, not a `mode` enum.** The model shouldn't pick plain-vs-regex (adapter owns it); a full `mode` invites routing mistakes.
- **Invariant:** fff = optimization/discovery backend, not a replacement contract.

**Round 2 — I pushed on four unresolved points; Codex's final calls:**

1. **Value/scope:** ship **additive-first**, not exact-swap-first. The unique value is fuzzy + ranked discovery, not exact literal (rg already matches CC's contract and is fast cold). I had over-corrected into making fff-exact default too early. Make the first feature additive + observable; promote exact behind shadow validation.
2. **Exhaustiveness:** Codex **disagreed with my lean (a)** ("raise caps, exhaustive-but-ranked"). Raising caps just moves the cliff; it doesn't _prove_ the set equals rg's. And reordering can break "audit every occurrence" consumers that scan sequentially expecting path order. → `count`→rg always; `head_limit` 0/high→rg always; fff exact only on a ranked path or after shadow validation; if ever default, require fff to return ≥ head_limit, expose a truncation flag, and fall back to rg on truncation/uncertainty.
3. **Advisory fuzzy:** **agreed to drop it.** CC's colon-parser makes any non-`PATH:LINENO:TEXT` line a footgun (fake evidence). Zero exact = empty (exit 1 → []). Fuzzy purely explicit. A real "suggestions" channel doesn't exist here.
4. **Exposing fuzzy:** **patch the schema + arg-builder, not a query sigil.** A `~`-prefix sigil is brittle exactly where the feature exists to improve (model behavior), collides with real search text, and is invisible to validation. A real optional param is describable, testable, won't leak. Two honest splices against the actual tool contract fit tweakcc better than smuggling semantics through `pattern`.

**Mutual agreement reached** — no open disagreements. This plan implements Codex's final design verbatim.

---

## 7. Routing table (definitive)

The wrapper (`rg-fff`) receives CC's full rg argv and classifies each invocation:

| Invocation                                                             | Backend                                                            | Why                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `--files` / Glob / enumeration / exclusion scan / file-count           | **rg always**                                                      | deterministic exhaustive mtime-sorted; fff can't; no prompt surface |
| `output_mode=count` (`-c -H`)                                          | **rg always** (until proven vs `rg -F`)                            | exact counts gate refactors                                         |
| `head_limit=0` or high/unlimited                                       | **rg always**                                                      | exhaustiveness can't be guaranteed by ranked/capped fff             |
| pattern contains any regex metachar                                    | **rg always**                                                      | fff is not a better regex engine; rg owns regex semantics           |
| `multiline:true` (`-U`)                                                | **rg always**                                                      | fff is single-line                                                  |
| `-o` / context-heavy / `--type` / complex glob                         | **rg always**                                                      | fff has no faithful equivalent on the live path                     |
| path is a single file or outside the workspace/git root                | **rg always**                                                      | fff is git-root-scoped                                              |
| non-ASCII pattern                                                      | **rg always**                                                      | fff Unicode normalization (`ş→s`) overcounts                        |
| **`fuzzy:true`** (new param)                                           | **fff** (Fuzzy mode)                                               | the new discovery capability rg lacks                               |
| simple ASCII literal, workspace-root, content-mode, bounded head_limit | **rg (Stage 1); fff-exact only after shadow validation (Stage 2)** | ranking benefit, but only once set-equivalence is proven            |
| anything uncertain / unparseable                                       | **rg**                                                             | fail safe to the exact contract                                     |

---

## 8. The wrapper / adapter contract

`rg-fff` is a self-contained per-platform executable CC spawns in place of ripgrep. It must:

### 8.1 Output (plain text, no JSON)

- content: `PATH:LINENO:TEXT` (LF-separated, no trailing junk). Use fff's `relative_path`, `line_number`, `line_content`.
- count: `PATH:COUNT`.
- files_with_matches: bare `PATH`.
- Emit **only** valid records. Never emit advisory/diagnostic lines into the result stream (parser footgun).

### 8.2 Exit codes

- `0` = matches, `1` = no matches (NOT error), `≥2` = real error. Map "fff returned nothing" → exit 1.
- Tolerate `-j 1` (EAGAIN retry path).

### 8.3 Version gate

- `--version` must print a line starting `ripgrep ` (e.g. `ripgrep 14.1.0 (fff-wrapped)`), or CC disables Grep. (Cheaper than patching the `startsWith("ripgrep ")` check, and platform-uniform.)

### 8.4 Flag handling

- **Honor (map to fff when routed to fff):** the pattern + path positionals, `-l`, `-n`, `-i`, `--glob`/`-g` → fff inline constraint DSL, the new `--fff-fuzzy` sentinel.
- **Tolerate-and-no-op (must not crash):** `--no-config`, `-j 1`, `--max-columns 500`, `--hidden`, `--color never`, `--with-filename`, and **any unknown future flag** (silently ignore — protects against CC bumps).
- **Force the rg fallback path:** every row in §7 marked "rg" — the wrapper execs real ripgrep and streams its stdout/exit through unchanged.

### 8.5 Fallback rg source

- **Primary:** re-exec CC's embedded ripgrep via the claude binary with `argv0:"rg"` + `--no-config` (zero extra download; literally what CC does in embedded mode). The claude binary path is injected at apply-time (same mechanism as the wrapper path).
- **Safety net:** bundle a standalone `rg` per triple if the embedded re-exec proves fragile across CC versions. **[TO VERIFY]** that `spawn(claudeBin, args, {argv0:'rg'})` reliably dispatches the embedded ripgrep from a _third-party_ process — test in Phase 0.

---

## 9. tweakcc implementation

### 9.1 New patch module

`src/patches/swapRipgrepForFff.ts`, registered in `src/patches/index.ts` under `PatchGroup.FEATURES`. Id `swap-ripgrep-for-fff` (kebab-case). Wiring per CLAUDE.md recipe: import in `index.ts`; `PATCH_DEFINITIONS` entry; `_` map entry `{fn, condition: settings.misc.swapRipgrepForFff}`; `MiscConfig.swapRipgrepForFff: boolean` in `src/types.ts`; **default `false`** in `src/defaultSettings.ts`; toggle + `defaultMisc` in `src/ui/components/MiscView.tsx`. Test `swapRipgrepForFff.test.ts` (assert the splice, idempotency, and that the resolver still **parses/binds** — the `themes.ts` silent-breakage regression class, memory `reference_code_patch_silent_breakage_config_theme`).

### 9.2 Resolver repoint (one literal anchor)

Anchor on the verified literal (NOT minified ids):

```
mode:"embedded",command:process.execPath,args:["--no-config"],argv0:"rg"
```

Splice → `{mode:"system",command:"<absolute wrapper path>",args:[]}` (drop `argv0` + `--no-config` for a clean argv). For robustness, prefer rewriting the **whole resolver body** (match `=Hn(()=>{` … trailing `return{mode:"system",…}}`) to return the fixed object, so the `USE_BUILTIN_RIPGREP` / `Own("rg",[])` branches can't re-derive a system rg. Wrapper path is injected at apply-time → templated splice. Idempotency: if the file already contains the wrapper path/sentinel, return unchanged.

### 9.3 Grep description rewrite (override surface)

Edit the `Ac='Grep'` description string + per-param `.describe()`s (this is a tool-description splice, not `data/prompts`). Following fff's `MCP_INSTRUCTIONS`:

- Lead: prefer **bare identifiers** (`InProgressQuote`), not regex patterns or natural-language phrases.
- "Do not use regex unless regex semantics are required" (regex still works — routed to rg — but de-advertised).
- "Search one stable identifier, then READ the code."
- Add the **`fuzzy`** param: _"Set true for typo-tolerant, relevance-ranked symbol discovery when the exact name is uncertain or you're exploring. Default false = exact search."_
- De-advertise `multiline` and `--type` (still routed to rg, but the model reaches for them less). Keep "NEVER invoke `grep`/`rg` as a Bash command" (still funnels through the tool).

### 9.4 `fuzzy` param plumbing (schema + arg-builder splices)

- **Schema splice:** add `fuzzy: z.boolean().optional().describe("…")` to the Grep params object (`OHp`).
- **Arg-builder splice:** in the arg-builder block, `if(params.fuzzy) T.push("--fff-fuzzy")`. The wrapper reads `--fff-fuzzy` → routes to fff Fuzzy mode (and, because fuzzy always routes to fff, the sentinel never reaches rg).

### 9.5 Platform-minify caveat

`sLt`/`d2i`/`Qie`/`l$e`/`Own`/`Af`/`h2i`/`OHp`/`Ac` are darwin names. **Anchor every splice on string literals** (the embedded descriptor, `"--hidden"`/`"--max-columns","500"`, the Grep description prose, the param `.describe()` strings, `startsWith("ripgrep `). Validate all splices against the linux-arm64 and linux-x64 bundles before shipping.

---

## 10. Cosmetic / user-facing edits (optional)

Doctor TUI `"ripgrep (rg): found/not found"`, ENOENT `"ripgrep not found on PATH…"`, linux preflight `"ripgrep (${command}) not found"` — adjust labels to mention fff only if we want the UI to reflect the swap. Non-functional; can defer.

---

## 11. Backend choice & warm index

- **Backend = fff library, not fff-mcp.** Reasons: (1) we need deliberate `mode:'fuzzy'` (fff-mcp only auto-fuzzy-_falls back_ on zero exact — no force-fuzzy param); (2) the library returns structured `{line_number, col, line_content}` (clean `PATH:LINENO:TEXT`), vs fff-mcp's human text blob we'd have to re-parse; (3) no MCP client/handshake to implement.
- **Library binding options:** `@ff-labs/fff-node` SDK (wrapper = bun-compiled TS, natural for this repo) **[TO VERIFY: package exists + API + that it links libfff_c per-triple]**, or `libfff_c` cdylib from a small Rust/Zig wrapper (heavier CI, fully self-contained), or vendoring the `fff-search` crate into a Rust wrapper (cleanest single static binary, needs Rust in CI). **Recommendation:** verify `@ff-labs/fff-node` first (least friction); fall back to a Rust wrapper linking `libfff_c` if the SDK is unsuitable.
- **Warm index:** fff's speed win requires a resident in-memory index across repeated searches. CC spawns the wrapper fresh per call → cold index each time, which can be _slower_ than rg on large repos. For **Stage 1 (fuzzy, lower volume, discovery latency-tolerant)**, cold-boot is acceptable. A **per-repo broker daemon** (our ~150 lines: holds one resident fff index, listens on `~/.tweakcc/fff/sock-<repohash>`, idles out after N min, wrapper connects-or-starts) is a **Stage-2 optimization**, gated on measured latency. Do not build the daemon until Stage 1 data shows it's warranted.

---

## 12. Distribution

- Wrapper built in CI (`.github/workflows/release.yml`) for darwin-arm64, linux-arm64, linux-x64 (bun `--compile` matrix if TS wrapper; cross-compile if Rust), published as release assets.
- At `--apply`: resolve triple → download the wrapper + the matching fff library artifact into `~/.tweakcc/fff/<triple>/`, **verify pinned SHA256** (mirror the prompts-JSON network-fetch path; npx installs ship no `data/`). Inject the absolute wrapper path into the resolver splice.
- **VPS legs:** linux-arm64 (hermes) + linux-x64 (tencent) both covered; works over `npx -y tweakcc-fixed@X --apply` — **publish-first** as always (push main → bump package.json → tag → release.yml → wait for `npm view`).
- **Missing triple:** patch **no-ops gracefully** — leave rg in place, log `patch: swap-ripgrep-for-fff: no fff artifact for <triple>, keeping ripgrep`. Never half-apply (resolver pointing at a missing wrapper = Grep disabled = silent search death).

---

## 13. Correctness, smoke, showtime

- **Shadow-mode equivalence harness (gates Stage 2):** corpus of queries; run fff-exact and `rg` (and `rg -F` for count); assert **set equality** (paths + line numbers), ignore-rule parity, encoding parity, limit/truncation parity. A query class only graduates to fff-exact when it passes. Record route-rate + miss-rate.
- **Smoke (every apply / showtime):** real PTY TUI turn exercising (1) a default Grep (→ rg), (2) a `fuzzy:true` Grep (→ fff, returns valid rows), (3) a Glob/`--files` turn (→ rg, deterministic), (4) `/config` `/theme` `/help` (lazy-path regression class). `--print` is insufficient.
- **Showtime integration:** fold the resolver-anchor check + routing assertions into the pipeline so each CC bump re-verifies the literal anchors survived and routing still holds. Byte-diff patched vs pristine (no introduced non-ASCII, no literal identifier-map leakage) per memory `reference_silent_binary_corruption_invisible_to_four_zeros`.

---

## 14. Every scenario / edge case (zero-assumptions catalog)

| Scenario                                                      | Handling                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Default exact content search                                  | rg (Stage 1); fff-exact only post-validation (Stage 2)                                       |
| `fuzzy:true`                                                  | fff Fuzzy; valid `PATH:LINENO:TEXT` rows only                                                |
| Zero matches (exact)                                          | empty output, exit 1 → `[]`; **no advisory line**                                            |
| Zero matches (fuzzy)                                          | empty; the model asked for fuzzy and got nothing — honest                                    |
| `count` mode                                                  | rg always (Stage 1+)                                                                         |
| `files_with_matches`                                          | rg (Stage 1); fff later only if proven                                                       |
| `head_limit=0`/high                                           | rg always                                                                                    |
| Regex pattern (any metachar)                                  | rg always                                                                                    |
| Multiline (`-U`)                                              | rg always                                                                                    |
| `-o` only-matching / heavy context / `--type`                 | rg always                                                                                    |
| Single file / path outside git root                           | rg always                                                                                    |
| Non-ASCII pattern                                             | rg always                                                                                    |
| Glob `--files` / enumeration / exclusion / file-count         | rg always                                                                                    |
| EAGAIN (`-j 1` retry)                                         | wrapper tolerates `-j 1`; passes through                                                     |
| `--no-config`, `--max-columns 500`, `--hidden`, unknown flags | tolerate/no-op; never crash                                                                  |
| Version self-test                                             | wrapper `--version` → `ripgrep …` banner                                                     |
| Non-git directory / empty repo                                | fff requires a git/index root → if absent, route to rg                                       |
| Concurrent searches                                           | Stage 1 cold-boot: independent processes (safe). Stage 2 daemon: socket serialization + lock |
| Daemon crash/stale socket (Stage 2)                           | wrapper detects, restarts, falls back to rg on failure                                       |
| Index staleness                                               | fff watcher (daemon) or fresh scan (cold) ; rg has no such issue                             |
| Very large repo (e.g. linux kernel)                           | cold-boot indexing slow → measure; daemon or rg-route by size threshold                      |
| Binary / huge files                                           | fff `max_file_size` (10MB) skips; matches rg ignore-ish behavior — verify in harness         |
| CC version bump changes resolver/arg-builder shape            | literal anchors + showtime re-verify; graceful patch-fail if anchor gone                     |
| fff artifact missing for triple                               | graceful no-op, keep rg                                                                      |
| Wrapper missing/corrupt at runtime                            | resolver should detect-and-fallback; never leave Grep pointing at a dead binary              |
| Windows                                                       | out of scope for now (no VPS/dev target); fff has prebuilts if ever needed                   |

---

## 15. Phased build plan & effort

| Phase                                          | Deliverable                                                                                                                                                                                                                                                                              | Size  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **0 — Plumbing PoC**                           | Wrapper as pure rg pass-through (re-exec embedded rg) + resolver repoint + version-banner. Prove Grep/Glob/`--files` round-trip identically on darwin-arm64, then linux-arm64/x64. **No fff yet.** Validates the splice, the embedded-rg re-exec, the version gate, the output contract. | **S** |
| **1 — Additive fuzzy**                         | Library backend (verify `@ff-labs/fff-node` or Rust+libfff_c) for fff Fuzzy mode; `fuzzy` schema+arg-builder splices; description rewrite; routing table; cold-boot index. Route logging. Smoke incl. a `fuzzy:true` PTY turn.                                                           | **L** |
| **2 — tweakcc wiring + dist**                  | MiscConfig toggle, defaults off, MiscView; CI build matrix; apply-time download + pinned SHAs; VPS legs; graceful no-op.                                                                                                                                                                 | **M** |
| **3 — Shadow validation**                      | Equivalence harness (set/ignore/encoding/limit parity vs rg, count vs `rg -F`); route/miss metrics. Gate for any exact-promotion.                                                                                                                                                        | **M** |
| **4 — (optional) Promote exact + warm daemon** | Per-repo broker daemon (if latency warrants); enable fff-exact for validated query classes with rg fallback on truncation/uncertainty.                                                                                                                                                   | **L** |

**Realistic total to a shippable Stage 1 (Phases 0–2): ~1–1.5 weeks.** Phase 0 is small and de-risks everything — do it first.

### Build status (session 2026-06-23)

**Built + verified (darwin-arm64):**

- `tools/rg-fff/` — the Rust wrapper (statically links `fff-search 0.9.6`): arg parse, routing table (§7), fff plain (exhaustive paginated) + fff fuzzy, glob translation, embedded-rg re-exec fallback, plain-text output contract, exit codes, `ripgrep ` version banner. Builds clean.
- `src/patches/swapRipgrepForFff.ts` — resolver-repoint splice (literal anchor + regex fallback, idempotent, parse-neutral). Passes `process.execPath` so the wrapper re-execs the live claude binary (survives `claude update`).
- `src/ripgrepFff.ts` — `getFffTriple()` + `ensureRgFffWrapper()` (installed → repo-local build → GH-release download with SHA256 verify; graceful null = keep rg).
- Wiring: `MiscConfig.swapRipgrepForFff` (default **false**), `index.ts` (import, PATCH_DEFINITIONS, install-before-patch, implementation), `MiscView.tsx` toggle.
- `.github/workflows/rg-fff.yml` — cargo-zigbuild cross-build for the 3 triples → attaches `rg-fff-<triple>` + `.sha256` to the release.
- Tests: `src/patches/swapRipgrepForFff.test.ts` (5 cases, in vitest — all 80 files / 729 tests green); `tools/rg-fff/equivalence-test.mjs` (manual harness: patch parse-neutrality + 17 wrapper-vs-rg cases). **fff == rg set-equivalence verified on `showDiff`/`PatchGroup`/`export`/`const`(4847 keys)/`function`/`writeMaxEffortDefault` — zero recall hole.** `pnpm lint` + `pnpm test` green.

**Remaining (next increments):**

- **`fuzzy:true` model lever** — schema splice (`OHp`) + arg-builder sentinel (`if(fuzzy)T.push("--fff-fuzzy")` after `"--max-columns","500"`) + Grep description rewrite. The wrapper already honors `--fff-fuzzy`; this exposes it to the model. 3 coordinated minified splices — do with unit tests per the patch-creation skill.
- **Warm-index daemon** (§11 Stage-2 perf) — cold-boot works today; daemon only if latency warrants.
- **Live-CC verification** — Bun boot of the repacked binary + an interactive Grep turn through the wrapper (offline harness can't repack the native binary; see report).

---

## 16. Risks & failure modes

1. **Silent wrong results** (release-blocker class) — mitigated by: exact contract stays on rg by default; fuzzy is explicit and labeled; Stage-2 promotion gated on set-equivalence harness; valid-rows-only output.
2. **Resolver blast radius** — Glob + internal enumeration share the resolver; mitigated by routing all `--files`/enumeration to rg unconditionally.
3. **Embedded-rg re-exec fragility** across CC versions — mitigated by the bundled-rg safety net + Phase 0 verification.
4. **Cold-boot latency** worse than rg on big repos — mitigated by Stage-1 fuzzy-only (latency-tolerant) + size-threshold rg-routing + Stage-2 daemon only if measured.
5. **Upgrade fragility** — literal anchors + showtime re-verify + accept-and-ignore unknown flags.
6. **Not the "Expected CommonJS wrapper" class** — the wrapper is a separate binary; it can't break cli.js template parity. The danger is silent wrong results, addressed above.

---

## 17. Resolved investigations (was: open questions) — ALL settled, zero open

Every prior `[TO VERIFY]` is now resolved against primary sources. No open questions remain.

- **RESOLVED — backend binding.** `fff-core`'s package name is **`fff-search`**, published on **crates.io** at stable **`0.9.6`** (crate-type includes `rlib`), git tag `v0.9.6` also present. The public Rust API is confirmed from the crate's own lib.rs doctest: `SharedFilePicker::default()` → `FilePicker::new_with_shared_state(picker, frecency, FilePickerOptions{base_path, mode: FFFMode::Ai, ..})` → `shared_picker.wait_for_scan(Duration)` → `picker.grep(&parser.parse(q), &GrepSearchOptions{..})`. **Decision: the wrapper is a Rust binary that statically links `fff-search = "0.9.6"`** (see §11). `@ff-labs/fff-node` (npm SDK, `FileFinder.create`, per-triple native packages) and `libfff_c` (C-ABI cdylib) both exist and are viable fallbacks but are **not used** — the Rust crate gives one self-contained static binary with no Node runtime and no native-addon bundling.
- **RESOLVED — no fff artifact download / no SHA pinning of fff releases.** Because we statically link `fff-search` into our own `rg-fff` binary, there is nothing of fff's to download at apply-time. We pin the SHA256 of **our own** per-triple binary (a CI-emitted `.sha256` attached to the tweakcc GH release). The library-artifact-SHA question is moot.
- **RESOLVED — embedded-rg re-exec works.** Empirically verified on this machine (darwin-arm64): `spawn("/Users/batricperovic/.local/share/claude/versions/2.1.186", ["--version"], {argv0:"rg"})` → `ripgrep 14.1.1 (rev 324c5f012a)`, exit 0; and `spawn(claudeBin, ["--no-config","-n","showDiff","src/patches/index.ts"], {argv0:"rg"})` → exit 0 with the correct match. **The rg fallback re-execs CC's own embedded ripgrep — zero bundled rg.** The wrapper learns the claude binary path via a `--fff-claude-bin=<abs path>` flag injected into the resolver's `args` at apply-time (see §9.2).
- **RESOLVED — fff plain-mode recall.** The "keyword" code in `fff-core/src/grep.rs` is `is_definition_keyword` / `DEF_KEYWORDS`, used only for `classify_definitions` (ranking/`[def]` marking), **not** to exclude tokens from search. Plain-mode (`GrepMode::PlainText`, SIMD `memchr::memmem`) is exhaustive literal substring matching. The third-party `opencode-fff-search` "keyword hole" is not a fff-core limitation. Residual risk: the **bigram prefilter** can behave oddly for very short patterns (no 2-byte bigram) — so the routing (§7) sends patterns shorter than 3 bytes to rg, and the shadow harness (§13) proves set-equivalence for everything else.
- **RESOLVED — cross-build.** fff's own `release.yaml` cross-builds these exact targets with **`cargo-zigbuild`** (`mlugg/setup-zig@v2` + `cargo install cargo-zigbuild`) on ubuntu for linux gnu/musl, and macOS runners for darwin. We copy that: ubuntu + cargo-zigbuild for `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` (static, portable for the VPS legs), and a `macos-14` runner for `aarch64-apple-darwin`.
- **RESOLVED — product direction.** Per the maintainer's explicit override: build the **full feature** (fff-primary with rg fallback + `fuzzy:true` discovery), all stages, testing between stages — not additive-then-stop. The shadow-equivalence harness (§13) is a **CI correctness gate** (blocks shipping a query class whose fff results diverge from rg), not a reason to ship a subset. fff is primary for its eligible slice from day one; the harness governs how wide that slice is.

---

## 18. Appendix — verified anchors (CC 2.1.186, darwin bundle)

- Resolver descriptor: `mode:"embedded",command:process.execPath,args:["--no-config"],argv0:"rg"`
- Gate: `USE_BUILTIN_RIPGREP` (3×) · `Own("rg",[])` (`"rg"` literal 3× in resolver)
- Version self-test: `t.stdout.startsWith("ripgrep ")`
- Arg-builder: `["--hidden"]` … `T.push("--glob",`!${O}`)` … `T.push("--max-columns","500")`
- Output split: `.trim().split("\n").map(g=>g.replace(/\r$/,"")).filter(Boolean)`
- Grep params object `OHp`; tool name `Ac='Grep'`
- Telemetry `tengu_ripgrep_availability` · ENOENT `ripgrep not found on PATH` · sandbox-only `Custom ripgrep configuration`
- **All minified ids (`sLt`/`d2i`/`Qie`/`OHp`/`Ac`) are darwin-specific — anchor on the string literals above, validate on linux bundles.**

---

## 19. PIVOT (2026-06-23) — Bash-world fff (supersedes the Grep-tool architecture above for the main agent)

**Why.** CC 2.1.186 removes the **Grep and Glob tools from the model entirely by default** — the `Ait()`/`rv()` "search-tools" gate (hardcoded-on via `ot("true")`, on macOS via `zc()`; **independent of `ENABLE_TOOL_SEARCH`; not introduced by tweakcc** — identical bytes pristine vs patched). Proven authoritatively: a MITM proxy captured the real API `tools[]` (no Grep/Glob), and forcing a Grep call returns the harness error _"No such tool available: Grep … search file contents with `grep` via the Bash tool instead."_ The agent searches via **Bash `grep`/`rg`**. Grep/Glob return only when `searchToolsOptIn` is set (a prompt names them) or `entrypoint==="local-agent"` (subagents).

**Consequence.** The Grep-tool-backed design in §1–16 (resolver repoint + Grep-description guidance) is **bypassed for the main agent** (it still fires for subagents, which keep the Grep tool). The model-facing Grep description is never delivered to the main agent, so guidance appended there is never seen.

**Decision (user, 2026-06-23): do NOT bring Grep back. Stay in the Bash world.**

**New architecture:**

1. **Ship `fff` as a Bash-invokable CLI** — our Rust wrapper (statically links `fff-search`), evolved from a pure rg-resolver drop-in into an optimal agent CLI: positional `fff <pattern> [path]` + rg-compatible flags (so the agent's rg habits transfer) + `--fuzzy`; agent-friendly ranked output; **falls back to system `rg`/`grep`** for what fff can't do. (Exact spec from the optimal-command research.)
2. **Install `fff` globally on toggle-on** — `--apply` symlinks `~/.tweakcc/fff/<triple>/rg-fff` → `~/.local/bin/fff` (sibling of the `claude` symlink, already on PATH; reachable by CC's Bash tool and the user's terminal). Installing a _new_ command hijacks nothing (unlike shimming `grep`/`rg`). Toggle-off → `rm` the symlink.
3. **Append best-practice "prefer fff for content search" guidance at DURABLE instruction sites across ALL agent scopes** — main agent (Bash desc), explore, plan-mode, clarifying-research, and every other scope that searches. **NOT** the fragile stripped `lol()` content-search slot (sunset risk — the user flagged this). Exact sites + wording from the placement/best-practices research.
4. **Retire** the cli.js resolver-repoint + Grep-description append from §9 (or keep only as a belt-and-suspenders net for subagent Grep-tool usage).

**Roadmap — PLANNED, do not skip (user, 2026-06-23):**

- **fuzzy exposure** — `--fuzzy` is in the CLI; the model opts in via the appended guidance. (The old Grep-tool `fuzzy:true` schema param is moot — no Grep tool.)
- **warm-index daemon** — a per-repo lazy fff daemon behind the same `fff` CLI (e.g. `--daemon`/socket mode) for fff's real warm-index speed. Cold-boot is v1; the daemon lands when cold-boot proves slow. Designed so the CLI contract doesn't change when it's added.

**Pending:** the exhaustive per-scope placement-site list + the optimal `fff` command spec (research workflow `wf_a489fef7-e5c` in flight).
