#!/usr/bin/env bash
# Start the API and the Vite dev server (each only if not already running),
# wait until both answer, then open the reader.
# Pass --no-open to skip opening the browser.
set -euo pipefail

# Termux:Widget runs scripts without the shell's usual setup, and Android has
# no /usr/bin/env, so put Termux's bin on PATH and call node explicitly.
export PATH="${PREFIX:-/data/data/com.termux/files/usr}/bin:$PATH"

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
LOGS="$HOME/.cache/epub-reader"
API_URL="http://127.0.0.1:8787/api/books"
APP_URL="http://localhost:5180/"
mkdir -p "$LOGS"

up() { curl -sf -o /dev/null "$1"; }

termux-wake-lock

cd "$ROOT"

# No `tsx watch`: nothing is edited on the phone, and watching costs battery.
if ! up "$API_URL"; then
  nohup node node_modules/tsx/dist/cli.mjs server/index.ts >"$LOGS/api.log" 2>&1 &
fi

if ! up "$APP_URL"; then
  nohup node node_modules/vite/bin/vite.js >"$LOGS/vite.log" 2>&1 &
fi

for _ in $(seq 1 120); do
  if up "$API_URL" && up "$APP_URL"; then
    [ "${1:-}" = "--no-open" ] || termux-open-url "$APP_URL"
    exit 0
  fi
  sleep 0.5
done

echo "epub-reader did not start within 60s; see $LOGS/api.log and $LOGS/vite.log" >&2
termux-toast "Reader failed to start" 2>/dev/null || true
exit 1
