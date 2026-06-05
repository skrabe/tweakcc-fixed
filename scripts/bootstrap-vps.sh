#!/usr/bin/env bash
# bootstrap-vps.sh <ssh-host> — one-time greenfield setup of a Linux box to run
# the tweakcc-fixed + lobotomized-claude-code (+ optional skrabe) stack, mirroring
# the Mac. Run FROM the Mac; it orchestrates the remote over ssh + rsync.
#
#   bash scripts/bootstrap-vps.sh hermes
#   bash scripts/bootstrap-vps.sh ubuntu@tencent-vps
#
# Idempotent-ish: re-running re-pulls/re-builds rather than reinstalling. Verified
# on Ubuntu 24.04 aarch64 (Oracle) and x86_64 (Tencent). After this, the box joins
# the per-version sync loop in the /showtime skill (§10, HOSTS list).
#
# What it does NOT do: the skrabe Layer-1 overlay. That's bake-once-on-Mac then
# ship — see scripts/sync-skrabe.sh / the /skrabe skill. Personal config only.
set -euo pipefail

HOST="${1:?usage: bootstrap-vps.sh <ssh-host>   e.g. hermes | ubuntu@tencent-vps}"
NODE_MAJOR=24
PNPM_VER=11.2.2
MAC_CONFIG="$HOME/.tweakcc/config.json"   # canonical config (Mac is source of truth)

say() { printf '\n\033[1;36m[bootstrap %s]\033[0m %s\n' "$HOST" "$*"; }
remote() { ssh -o ConnectTimeout=30 "$HOST" "export PATH=\"\$HOME/.local/bin:\$PATH\"; $*"; }

say "1/8 toolchain: node ${NODE_MAJOR} (NodeSource) + pnpm ${PNPM_VER} (corepack)"
remote "command -v node >/dev/null && [ \"\$(node -v | cut -d. -f1)\" = \"v${NODE_MAJOR}\" ] || {
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y nodejs >/dev/null 2>&1
}; node -v"
remote "command -v pnpm >/dev/null || { sudo corepack enable >/dev/null 2>&1; corepack prepare pnpm@${PNPM_VER} --activate >/dev/null 2>&1; }; pnpm -v"

say "2/8 Claude Code native install"
remote "command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1
  claude --version | head -1"

say "3/8 clone the two public repos"
remote "[ -d ~/dev/tweakcc-fixed ] || git clone https://github.com/skrabe/tweakcc-fixed ~/dev/tweakcc-fixed
  [ -d ~/.tweakcc/lobotomized-claude-code ] || git clone https://github.com/skrabe/lobotomized-claude-code ~/.tweakcc/lobotomized-claude-code
  cd ~/dev/tweakcc-fixed && git pull --ff-only >/dev/null 2>&1 || true
  cd ~/.tweakcc/lobotomized-claude-code && git checkout -- . 2>/dev/null; git pull --ff-only >/dev/null 2>&1 || true
  echo tweakcc=\$(git -C ~/dev/tweakcc-fixed rev-parse --short HEAD) lcc=\$(git -C ~/.tweakcc/lobotomized-claude-code rev-parse --short HEAD)"

say "4/8 install deps + build tweakcc (node-lief prebuild loads per-arch)"
remote "cd ~/dev/tweakcc-fixed && pnpm install >/dev/null 2>&1 && pnpm build >/dev/null 2>&1 && echo built"

say "5/8 symlinks (active per-model override set + reminders)"
remote "ln -sfn ~/.tweakcc/lobotomized-claude-code/system-prompts-opus-4-8 ~/.tweakcc/system-prompts
  ln -sfn ~/.tweakcc/lobotomized-claude-code/system-reminders ~/.tweakcc/system-reminders
  echo system-prompts -\> \$(readlink ~/.tweakcc/system-prompts | sed 's#'\"\$HOME\"'#~#')"

say "6/8 push canonical config.json (Mac is source of truth)"
rsync -az "$MAC_CONFIG" "$HOST:.tweakcc/config.json"
echo "  synced $(wc -c < "$MAC_CONFIG" | tr -d ' ') bytes"

say "7/8 apply Layer-0 (+ all patches: border, reminder-discovery, etc.)"
remote "cd ~/dev/tweakcc-fixed && node dist/index.mjs --apply 2>&1 | tail -3"

say "8/8 smoke test"
remote 'claude --print "say only the word READY"'

say "done — Layer-0 is live. For the skrabe overlay: bash scripts/sync-skrabe.sh $HOST"
