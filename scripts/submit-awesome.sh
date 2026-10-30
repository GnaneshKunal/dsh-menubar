#!/bin/bash
# Submit dsh-menubar to awesome-dsh-plugin.
#
# The list requires the repository to be at least one day old, checked
# automatically by CI, so this is meant to run ~25 hours after the repo was
# created (created 2026-10-29 12:26 IST → armed for 2026-10-30 13:30).
#
# It is idempotent: if the entry file is already on the fork or a PR is already
# open from this branch, it stops instead of duplicating work.
#
# Requires: gh authenticated (an account that can fork the list and open a PR).
set -euo pipefail
# launchd starts agents with a bare PATH; gh lives under /opt/homebrew on macOS.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

UPSTREAM="awesome-dsh-plugin/awesome-dsh-plugin"
FORK_OWNER="${FORK_OWNER:-GnaneshKunal}"
REPO="GnaneshKunal/dsh-menubar"
BRANCH="add-dsh-menubar"
ENTRY="data/plugins/GnaneshKunal__dsh-menubar.yml"
WORKDIR="${WORKDIR:-$HOME/.dsh/menubar-awesome-submission}"

log() { printf '[submit-awesome] %s\n' "$*"; }

command -v gh >/dev/null || { log "gh is not installed"; exit 1; }
gh auth status >/dev/null 2>&1 || { log "gh is not authenticated"; exit 1; }

# 1. Fork (idempotent; --clone=false just creates/updates the remote fork).
log "ensuring fork of $UPSTREAM under $FORK_OWNER"
gh repo fork "$UPSTREAM" --clone=false >/dev/null 2>&1 || true

# 2. Working clone of the fork.
rm -rf "$WORKDIR"
mkdir -p "$(dirname "$WORKDIR")"
# gh is authenticated over SSH here; an HTTPS clone has no credential to offer.
git clone --depth 1 "git@github.com:$FORK_OWNER/$(basename "$UPSTREAM").git" "$WORKDIR"
cd "$WORKDIR"
git remote add upstream "git@github.com:$UPSTREAM.git"
git fetch --depth 1 upstream main >/dev/null 2>&1
git reset --hard upstream/main >/dev/null

if [ -f "$ENTRY" ]; then
  log "$ENTRY already exists upstream; nothing to submit"
  exit 0
fi

# 3. The entry. One file, no README edits (the list regenerates them).
mkdir -p "$(dirname "$ENTRY")"
cat > "$ENTRY" <<'YAML'
url: https://github.com/GnaneshKunal/dsh-menubar
name: GnaneshKunal/dsh-menubar
category: ui
description:
  en: 'DeepSeek Harness in the macOS menu bar: a ⌃⌥Q window that boots the real dsh interface through a pre-authenticated URL, backed by a host plugin that projects a token-authenticated bridge onto the host session APIs, so asks made from the menu bar become tracked sessions. Includes ⌘F find-on-page, a compact fallback window, streaming answers, session titles, text paste, and a bundle config page that starts, restarts or quits the app.'
  zh: '把 DeepSeek Harness 放进 macOS 菜单栏：⌃⌥Q 唤出的窗口通过一次性预授权链接直接加载真正的 dsh 界面；配套宿主插件把带令牌的桥接投射到宿主的会话接口上，菜单栏里的提问因此成为可追踪的会话。另含 ⌘F 页内查找、精简窗口、流式回答、会话标题、文本粘贴，以及可启动 / 重启 / 退出应用的插件配置页。'
YAML

# 4. Branch, commit, push, PR.
git checkout -q -B "$BRANCH"
git add "$ENTRY"
git -c user.name="Gnanesh" -c user.email="gnaneshkunal@outlook.com" \
  commit -q -m "plugins: add GnaneshKunal/dsh-menubar"
git push -q -f origin "$BRANCH"

if gh pr list --repo "$UPSTREAM" --head "$FORK_OWNER:$BRANCH" --state open --json number --jq '.[0].number' | grep -q .; then
  log "a PR from $BRANCH is already open; leaving it alone"
  exit 0
fi

gh pr create --repo "$UPSTREAM" \
  --head "$FORK_OWNER:$BRANCH" --base main \
  --title "plugins: add GnaneshKunal/dsh-menubar" \
  --body "$(cat <<'BODY'
Adds \`$ENTRY\` — one file, no generated README edits.

- [x] One file at \`data/plugins/<owner>__<repo>.yml\`; READMEs left untouched for the post-merge regeneration
- [x] \`plugin/package.json\` declares **\`dsh.bundle\`** (\`{\"patch\": \"./cordis.patch.yml\"}\`) so the plugin installs with \`dsh plugin add\`
- [x] Repository is older than the one-day bar this round (created 2026-10-29, submitted on the next day)
- [x] Host plugin only: the macOS app in \`app/\` is a client of the bridge, not required to install it

\`category: ui\` — the plugin adds a Settings page and the app is a client surface for sessions.

Installable as `@gnanesh/dsh-menubar` on npm (tag → OIDC publish, provenance).

Latest release: https://github.com/GnaneshKunal/dsh-menubar/releases/tag/v0.1.7
BODY
)"

log "PR opened: $(gh pr view --repo "$UPSTREAM" --head "$FORK_OWNER:$BRANCH" --json url --jq .url)"
