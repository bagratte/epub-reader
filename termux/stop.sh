#!/usr/bin/env bash
# Stop the API and the Vite dev server started by start.sh.
# tsx runs the server in a child node process; this matches both.
pkill -f "server/index.ts" || true
pkill -f "vite/bin/vite.js" || true
termux-wake-unlock
