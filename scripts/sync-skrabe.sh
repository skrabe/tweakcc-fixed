#!/usr/bin/env bash
# sync-skrabe.sh <ssh-host> — ship the Mac's already-woven skrabe staging dir to a
# Linux box and bake it (the Layer-1 personal overlay). Run FROM the Mac.
#
# Bake-once model: the block-placement JUDGMENT happens exactly once per CC
# version, on the Mac (the /skrabe skill: apply.sh stage -> place blocks by hand
# -> the staging dir is the artifact). The woven `system-prompts-opus-4-8/` is
# platform-independent (tweakcc remaps minified names per binary at apply time),
# so the identical bytes are shipped to every box rather than re-judged N times.
#
#   bash scripts/sync-skrabe.sh hermes
#   bash scripts/sync-skrabe.sh ubuntu@tencent-vps
set -euo pipefail

HOST="${1:?usage: sync-skrabe.sh <ssh-host>}"
STAGE="$HOME/.tweakcc/skrabe-staging/system-prompts-opus-4-8"
[ -d "$STAGE" ] || {
  echo "ERROR: no woven staging on the Mac ($STAGE)."
  echo "Run the /skrabe judgment pass first (apply.sh stage -> place blocks -> bake) so the staging dir exists."
  exit 1
}

echo "[skrabe -> $HOST] rsync skrabe repo (private) + woven staging"
rsync -az --delete "$HOME/dev/skrabes-claude-code/" "$HOST:dev/skrabes-claude-code/"
rsync -az --delete "$HOME/.tweakcc/skrabe-staging/"  "$HOST:.tweakcc/skrabe-staging/"

echo "[skrabe -> $HOST] bake (symlink->staging, tweakcc --apply, restore symlink, smoke)"
ssh -o ConnectTimeout=45 "$HOST" 'export PATH="$HOME/.local/bin:$PATH"; bash ~/dev/skrabes-claude-code/apply.sh bake'
