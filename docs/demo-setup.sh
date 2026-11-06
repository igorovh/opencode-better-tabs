#!/usr/bin/env bash
# Builds a throwaway OpenCode home with made-up repositories and sessions for docs/demo.tape.
# Usage: bash docs/demo-setup.sh <empty-dir>   (OPENCODE=<path to the V2 binary> if `opencode` is not V2)
set -euo pipefail

dir=${1:?usage: demo-setup.sh <empty-dir>}
repo=$(cd "$(dirname "$0")/.." && pwd)
opencode=${OPENCODE:-opencode}
mkdir -p "$dir"
# Git Bash paths (/e/...) mean nothing to the native Windows binary.
native() { if command -v cygpath > /dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
dir=$(native "$(cd "$dir" && pwd)")
repo=$(native "$repo")

export HOME="$dir/home" USERPROFILE="$dir/home"
export XDG_CONFIG_HOME="$dir/xdg/config" XDG_DATA_HOME="$dir/xdg/data"
export XDG_STATE_HOME="$dir/xdg/state" XDG_CACHE_HOME="$dir/xdg/cache"
unset OPENCODE_CONFIG_DIR OPENCODE_CLI_CONFIG_CONTENT
export MSYS_NO_PATHCONV=1

# OpenCode keys a project by its first commit, so every repository needs a different one.
mkdir -p "$HOME/demo/notes"
for name in acme-api acme-web acme-mobile; do
  mkdir -p "$HOME/demo/$name"
  git -C "$HOME/demo/$name" init -q
  echo "# $name" > "$HOME/demo/$name/README.md"
  git -C "$HOME/demo/$name" add README.md
  git -C "$HOME/demo/$name" -c user.name=demo -c user.email=demo@example.com commit -q -m "Start $name"
done

session() {
  (cd "$HOME/demo/$1" && "$opencode" --standalone api session.create -d "{\"title\":\"$2\"}") |
    grep -o '"id":"ses_[^"]*"' | cut -d'"' -f4
}
ids=(
  "$(session acme-api "Add rate limiting to orders")"
  "$(session acme-web "Dark mode for the settings page")"
  "$(session acme-api "Fix flaky checkout test")"
  "$(session acme-mobile "Retry failed push notifications")"
  "$(session acme-web "Migrate forms to the new validator")"
  "$(session acme-api "Document the webhooks API")"
  "$(session notes "Plan the Q3 roadmap")"
  "$(session acme-web "Speed up the landing page")"
)

# Tabs open in mixed order; the plugin groups them by repository.
tabs=$(printf '{"sessionID":"%s"},' "${ids[@]}")
for channel in latest beta; do
  mkdir -p "$XDG_STATE_HOME/opencode/$channel/tui"
  echo "{\"global\":{\"tabs\":[${tabs%,}],\"unread\":{}},\"cwd\":{}}" > "$XDG_STATE_HOME/opencode/$channel/tui/tabs.json"
done

mkdir -p "$XDG_CONFIG_HOME/opencode"
cat > "$XDG_CONFIG_HOME/opencode/cli.json" <<EOF
{
  "\$schema": "https://opencode.ai/v2/cli.json",
  "tabs": { "scope": "global", "layout": "vertical", "mode": "on" },
  "plugins": ["$repo"]
}
EOF
echo "Demo home ready in $dir"
