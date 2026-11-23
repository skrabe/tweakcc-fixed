# Comparison with upstream

Checked 4 November 2026 against Piebald-AI/tweakcc [`925d13fd`](https://github.com/Piebald-AI/tweakcc/tree/925d13fd513bc86659ae395c647674cd0d57e6da). Fork source: [`13b46f57`](https://github.com/skrabe/tweakcc-fixed/tree/13b46f57e1392386db48040808db842a3532e269).

| Source inventory        | tweakcc-fixed main | npm v2.9.23 | Upstream |
| ----------------------- | -----------------: | ----------: | -------: |
| Claude Code catalogue   |            2.1.317 |     2.1.317 |  2.1.317 |
| Prompt sites            |             16,355 |      16,355 |    1,084 |
| Unique prompt IDs       |             15,141 |      15,141 |    1,084 |
| Registered code patches |                 82 |          81 |       61 |

A site is one entry in `data/prompts/prompts-2.1.317.json`; one ID can occur at several sites. Patch counts come from `PATCH_DEFINITIONS`. Some patches are optional, platform-specific or no-ops after a native feature ships. These counts don't measure active context or model quality.

## Shared features

Both projects edit prompts in npm and native installations. Both have themes, spinners, thinking text, toolsets, subagent model selection, read limits, input highlighting, statusline controls, keybindings and worktree support.

The fork's [README](../README.md#fork-additions) lists its additional features. Its extractor also catalogues shorter fragments and more prompt families. A larger catalogue doesn't establish that extraction is complete.

## Upstream controls absent here

The registries share 56 patch IDs. This fork has 26 additional IDs; upstream has these five without an equivalent control here:

| Upstream patch                | Behavior                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `auto-accept-plan-env`        | Auto-accept plans when `TWEAKCC_AUTO_ACCEPT_PLAN` is set; separate from the ordinary auto-accept switch shared by both projects |
| `skip-dev-channels-dialog`    | Skip the warning for development channels                                                                                       |
| `skip-trust-dialog`           | Accept workspace trust automatically                                                                                            |
| `prevent-unsupported-updates` | Require a published prompt snapshot before updating                                                                             |
| `keep-patched-binary`         | Keep the patched native binary during installer verification                                                                    |

The [pinned upstream registry](https://github.com/Piebald-AI/tweakcc/blob/925d13fd513bc86659ae395c647674cd0d57e6da/src/patches/index.ts) and [fork registry](https://github.com/skrabe/tweakcc-fixed/blob/13b46f57e1392386db48040808db842a3532e269/src/patches/index.ts) define the comparison.

## Main and npm

[npm v2.9.23](https://github.com/skrabe/tweakcc-fixed/tree/86d7ba6ab4a9b3feaad65ef531be73d878a25d52) supports the same Claude Code catalogue. Main adds the `empty-environment` patch, moves FFF guidance from the system prompt to the final Bash description, and cleans stale copies from restored prompts. It has no new package version yet.

## Refreshing the README counts

```sh
git fetch upstream main
node tools/readmeStats.mjs 2.1.317
node tools/readmeStats.mjs 2.1.317 --write
```

Use a version present in both repositories. The generator rejects an older upstream catalogue instead of comparing it under a newer version label. It records the fetched upstream commit alongside the counts. Feature comparisons above need a source review when either registry changes.
