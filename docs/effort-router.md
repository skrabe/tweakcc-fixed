# Effort router

The experimental router chooses reasoning effort once per user message while
one of these entries is selected in Claude Code's `/model` picker:

- **Opus 5.5 + Effort Router** (`opusrouter`)
- **Fable 5.1 + Effort Router** (`fablerouter`)

These resolve to the explicit verified model versions `claude-opus-5-5` and
`claude-fable-5-1`. Entries appear only when their underlying native model choice
is available. Ordinary models and Fable Plan mode retain normal effort behavior.
Selecting a normal model stops routing and background summaries immediately;
late results cannot change the new selection. Concise context remains available
if you switch back, and intervening conversation is picked up on the next turn.

The configuration toggle makes the entries available after applying; selecting
an entry activates routing. There is no global always-on mode. The provider
setting and securely stored API key apply to both router entries.

## Jev with asynchronous Haiku summaries

Jev receives the current message, the latest completed conversation summary,
recent conversation that has not yet been summarized, and the configured effort
tiers. Haiku maintains a concise summary in the background. It summarizes
observed conversation and tool results; it does not independently explore files.
If a summary is still running, routing uses the available summary and recent
context without waiting for Haiku. Background summaries never change the effort
of an already running turn.

Haiku is instructed to maintain a very concise account of the conversation's
progression: what the user requested, what the assistant attempted or changed,
what happened, and which issues were resolved. It retains meaningful scope and
decisions across topics rather than replacing history with a current-task brief.
Repeated details are collapsed; suggestions are distinguished from completed
actions. This compression is lossy and its factual accuracy is not guaranteed.
Jev receives the newest user message separately and judges the new work required.

## Setup

1. Open `tweakcc-fixed` and select **Complexity effort router [experimental]**.
2. Select Jev as the provider. This shares the current message and selected
   conversation context with TypeSafe, whose API is billed separately from Claude.
3. Store a TypeSafe API key through the masked credential input, or supply
   `TYPESAFE_API_KEY` to the process that launches Claude using your secret manager.
4. Enable **Router model entries**, save your settings, and apply. For
   unpublished checkout changes, build with `pnpm build` and run
   `node dist/index.mjs --apply`.
5. Restart Claude, then select an **Effort Router** entry in `/model`, or launch
   with `claude --model opusrouter` / `claude --model fablerouter`. The picker
   displays automatic effort instead of manual effort arrows for these entries.

The API key is read at runtime. It is never included in router configuration,
patched JavaScript, backups, routing summaries, or debug output. Native storage
uses macOS Keychain or Linux Secret Service where available. On Windows and
headless systems without a usable credential store, use a secret-managed
`TYPESAFE_API_KEY`. There is no automatic plaintext-file fallback. The environment
variable takes precedence over a stored key; removing a stored key does not unset
the environment variable in an already running process.

## Effort and failure behavior

The configured tiers map to the selected model's supported effort levels. Unsupported levels
are normalized by the existing model capability guards. Explicit environment and
session effort overrides retain their precedence over automatic routing.

Every structurally valid Jev choice applies on that turn in either direction.
Confidence is recorded for diagnostics and never gates or replaces the choice.
Jev routing does not use the legacy Haiku session pin or any automatic effort
floor. Truncated or missing context is disclosed to Jev for semantic assessment;
it does not mechanically force a higher level. Native explicit user effort
overrides retain their precedence.

A missing, malformed, timed-out or otherwise unusable response falls back to
medium. An old high choice is not carried into a new turn. A request deadline
prevents routing failures from indefinitely holding up the main turn.

The rubric asks Jev to judge the meaning of the current request and the work
still required. Its tiers distinguish how much remains to be decided, how
uncertainties interact, what verification is needed and whether additional work
would materially improve the result. No task-category examples, trigger-word
lists, keyword scores or content-matching rules select effort. Haiku separates
completed work from remaining work without assigning an effort label.

Jev is a semantic classifier, not an extended-reasoning generative model. The
[TypeSafe workflow guidance](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
favors focused semantic questions and relevant context; its
[documented limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
include literal readings and difficulty with indirection. The evaluation suite
therefore tests meaning-preserving paraphrases and similar wording with different
remaining work, in addition to coverage across domains.

Jev confidence is TypeSafe's distribution concentration statistic, not a
probability of task correctness. It is informational only. Obsolete confidence
threshold settings are removed when configuration is normalized; valid choices
are accepted regardless of confidence. Invalid distributions still fall back.

Completed turns show their actual routed effort beside the duration, for example
`Router → medium (confidence 27%)`. Jev confidence is rounded to a whole percentage
and saved alongside the effort for that turn. It remains informational and does
not change routing. Fallbacks retain their fallback label without confidence;
older turns lacking confidence metadata retain their existing labels.
The value is saved on that turn rather than recomputed from the
current selection. Fallbacks are marked. Ordinary model turns and explicit native effort overrides are not labeled
as router decisions. Historical turns from before this feature have no invented
routing label.

A single configured tier fixes the effort without calling Jev. More than 255
tiers exceed Jev's choice limit, so the router skips that request and uses its
conservative fallback; reduce the configured tier list to enable decisions.

Haiku summary failures leave the existing summary and recent context available.
Session, rewind, clear, and compaction boundaries invalidate obsolete background
work so a late result cannot restore discarded context.

## Subagents and background requests

Routing applies to the main conversation's requests. Subagents inheriting the
parent's Opus or Fable model use the same ordinary concrete model with native
effort resolution, not the parent's routed effort. Explicit subagent model,
turn-effort and hook choices keep their native precedence. Other background
request types also use native effort resolution. Children do not classify their
own messages through Jev or change the parent's router baseline or turn label.

## Conversation compaction

Claude Code's committed compaction document is retained separately as pending
source material. Haiku condenses it semantically before replacing the router's
completed summary; the document is not head-and-tail truncated to the output
limit. Long documents are processed in contiguous 12,000-character parts, with
the accumulated digest passed into the next part. Every accepted digest must fit
the configured summary limit (6,000 characters by default).

Routing remains asynchronous. Until all parts finish, Jev uses the last completed
summary and pending recent events, with an omission flag. Partial compaction
digests are not exposed to Jev. A failed or oversized summary retains the source
and progress for retry on later activity. Events arriving during condensation
remain queued for the ordinary chronological-summary update afterward.

Pending source and progress are stored with session state for resume, subject to
an 8 MB serialized-source limit. Larger sources remain in memory and are recovered
from the committed transcript after restart rather than silently truncated.
Clear and rewind invalidate obsolete jobs; model changes abort jobs while keeping
reusable context. Ordinary transcript event collection still has its separate
size and lookback bounds, so this is concise, lossy context rather than a complete
conversation archive.

## Context, cost, and privacy

The initial Jev model is pinned to `jev-1.13.0`. Its documented limits are 64k
tokens for the whole request and 32k for state plus the longest question. The
router uses a much smaller aggregate UTF-8 request budget, including the rubric,
rather than assuming a fixed number of characters per token. Oversized context is
bounded before sending; omission flags inform Jev without automatically changing
the effort level.

Jev is a text decision model: images and other binary attachments are not sent.
Conversation text and tool results can contain private information. Enable the
provider only where sharing that selected context with TypeSafe is appropriate.
Keeping the credential secure does not make the request contents local.

Routing context is cached in private per-session files under
`~/.tweakcc/router-state/`. Writes are atomic, and files older than 14 days are
pruned when a Jev session next persists context. Set `TWEAKCC_ROUTER_DEBUG=1` for
effort, proposed choice, confidence and fallback-reason diagnostics without logging
request content or credentials. The latest decision metadata is also stored with
the private session state.

## Prompt caching and usage

“Per user message” describes when Jev chooses effort: once when you submit a
message, with that choice used for the turn. “Top-level effort” describes the
API request field `output_config.effort`. Claude Code also records effort changes
as per-message markers in the conversation. These are compatible: the current
request can carry the new effort while earlier messages retain their original
markers. The live controls below changed the top-level value and still reused
the cached prefix on both models.

Changing effort in these router modes does **not inherently force a full prompt
cache rebuild**. Claude Code uses per-message effort markers, keeping the earlier
conversation unchanged. The old warning about full cache recreation was based on
CC 2.1.191 and does not describe the verified Opus 5.5 / Fable 5.1 modes.

Live controls on Claude Code 2.1.282 (2026-09-26) compared unchanged effort against
low-to-high and high-to-low changes with identical system/tool prefixes
([recorded measurements](effort-router-cache-verification.json)):

| Model     | Same-effort cached tokens | Changed-effort cached tokens |
| --------- | ------------------------: | ---------------------------: |
| Opus 5.5  |                    58,730 |                       58,730 |
| Fable 5.1 |                    58,305 |                       58,305 |

Cache writes grew with the additional conversation in both cases. These results
verify cache reuse across effort changes, not zero cache writes or guaranteed
savings on every workload. Changing the underlying model, system prompt, tools,
or other cache-relevant content can still invalidate cached prefixes.

Jev requests and Haiku summaries still incur usage. Lower main-model effort may
reduce work, but total savings depend on the task. Provider probabilities and
confidence are not guarantees of a correct effort choice; routing quality should
be evaluated on your workload.

References: [Jev models and limits](https://docs.typesafe.ai/models),
[known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[confidence](https://docs.typesafe.ai/confidence),
[per-message effort and caching](https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation),
and [Spending your effort](https://claude.dev/blog/spending-your-effort/).

## Evaluating routing

The [router evaluation harness](../tools/routerEval.md) exercises the actual
request construction, response parser and effort-selection policy with synthetic
coding, administrative, writing and research scenarios, including changes of
phase within a conversation. Offline fixtures check policy behavior; opt-in live
runs measure Jev decisions against declared acceptable ranges. These labels are
engineering expectations, not proof of equal answer quality or optimal cost.

The [2026-09-26 measurements](../data/router-evals-verification.json) record the
baseline and each evaluated revision, including errors. Cases cover multiple
domains, context transitions and meaning-preserving paraphrases. Sets reused
during rubric revisions are identified as validation, not unseen holdouts.
Live Jev routing latency was about 300 ms median on this machine. These
measurements mock Haiku summaries and do not establish downstream task quality.

Anthropic's [effort tutorial](https://academy.claude.com/tutorials/choosing-the-right-effort-level-in-claude-code)
recommends comparing completed results and usage, not just reasoning labels.
The rubric explicitly uses medium as Opus 5.5's daily-driver baseline, while
allowing simpler turns to go lower and deeper verification to go higher.
Opus 5.5's native default is medium; Fable 5.1's is high, with lower efforts appropriate
for routine work when evaluation preserves quality. In particular, Fable low can
retrieve less often, so tasks requiring substantive lookup are normally medium.
See the [Opus guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5)
and [Fable guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1).

[Plugin evals](https://code.claude.com/docs/en/plugin-evals) can help grade completed
work with fixtures and repeated trials. Their default plugin/no-plugin comparison
does not isolate a native binary patch: the router would remain installed in both
arms. For downstream quality and cost, compare fixed medium, fixed high and
router modes on identical isolated tasks, with independently defined correctness
checks and total main-model plus side-call usage. No such task-outcome equivalence
is implied by the routing-label tests.

## Chronological-summary trials

On 2026-09-26, live headless Haiku 4.5 trials used three modest real conversation
excerpts and one synthetic long compaction document. Sixteen calls across prompt
revisions reused these cases for tuning; this was not independent validation.
The final source/summary character counts were 5,291/600, 7,611/546,
10,344/1,070, and 11,355/462. Private excerpts and outputs were kept outside the
repository. Excerpts contained narrative messages, not tool blocks or hidden
reasoning; the compaction case was synthetic, not a native end-to-end run.

The compaction case retained consequential middle and end events. Real cases
still exposed factual compression errors: an implied action, a dropped deployment
condition, and a superseded estimate retained alongside corrected results.
These trials demonstrate concise output on the selected cases, not lossless
history or guaranteed attribution. Summary quality needs continued evaluation.
