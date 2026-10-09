#!/usr/bin/env bash
# Install Termux:Widget home-screen shortcuts that run start.sh / stop.sh.
# Termux:Widget only runs files that live under ~/.shortcuts, so these are
# small wrappers pointing back into the repo rather than symlinks.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
TASKS="$HOME/.shortcuts/tasks"
ICONS="$HOME/.shortcuts/icons"
mkdir -p "$TASKS" "$ICONS"

wrapper() {
  printf '#!/data/data/com.termux/files/usr/bin/bash\nexec bash "%s"\n' "$2" >"$TASKS/$1"
  chmod 700 "$TASKS/$1"
}

wrapper "Reader" "$ROOT/termux/start.sh"
wrapper "Reader stop" "$ROOT/termux/stop.sh"
cp "$ROOT/client/public/icon-192.png" "$ICONS/Reader.png"

echo "Installed shortcuts in $TASKS. Add them via the Termux:Widget home-screen widget."
