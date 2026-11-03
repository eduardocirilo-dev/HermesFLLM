#!/usr/bin/env bash
# Installs HermesFLLM as a macOS launchd agent: starts at login, restarts if it dies.
# Run from the repo after `npm install && npm run build` and creating `.env`.
#   scripts/launchd/install.sh            install / reinstall
#   scripts/launchd/install.sh uninstall  remove the agent
set -euo pipefail

LABEL="io.github.hermesfllm"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/HermesFLLM/hermesfllm.log"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "uninstall" ]; then
  rm -f "$PLIST"
  echo "HermesFLLM launchd agent removed."
  exit 0
fi

# macOS privacy protection (TCC) blocks launchd agents from reading Documents, Desktop, Downloads and
# iCloud Drive unless the program has been granted access. /bin/bash (which runs run.sh) has not, so
# an install there fails at every start with "Operation not permitted" (exit 126). Refuse up front.
case "$REPO/" in
  "$HOME/Documents/"*|"$HOME/Desktop/"*|"$HOME/Downloads/"*|"$HOME/Library/Mobile Documents/"*)
    echo "HermesFLLM is in a folder macOS protects ($REPO)." >&2
    echo "launchd cannot run it from there. Move it out, then install from the new place, e.g.:" >&2
    echo "  scripts/launchd/install.sh uninstall" >&2
    echo "  mv \"$REPO\" ~/Projects/HermesFLLM && cd ~/Projects/HermesFLLM && scripts/launchd/install.sh" >&2
    exit 1
    ;;
esac

# better-sqlite3 is a native module: record the Node that ran `npm install`. scripts/launchd/run.sh
# checks it at every start and falls back to nvm's default or PATH if this Node later moves.
NODE="${HERMESFLLM_NODE:-$(command -v node)}"
[ -x "$NODE" ] || { echo "node not found; set HERMESFLLM_NODE" >&2; exit 1; }
[ -f "$REPO/server/dist/index.js" ] || { echo "server not built; run npm run build" >&2; exit 1; }
[ -f "$REPO/.env" ] || { echo "missing $REPO/.env (ENCRYPTION_KEY, PORT, HOST=127.0.0.1)" >&2; exit 1; }
grep -q '^HOST=' "$REPO/.env" || echo "warning: no HOST= in .env; the server may listen on all interfaces" >&2

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
# '|' as sed delimiter: paths may contain '/' and spaces.
sed -e "s|__NODE__|$NODE|" -e "s|__REPO__|$REPO|" -e "s|__SERVER_DIR__|$REPO/server|" \
  -e "s|__LAUNCHD_LOG__|$(dirname "$LOG")/launchd.log|" -e "s|__LOG__|$LOG|g" \
  "$HERE/$LABEL.plist.template" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "$DOMAIN" "$PLIST"

PORT="$(grep -E '^PORT=' "$REPO/.env" | cut -d= -f2 || true)"
echo "HermesFLLM installed ($LABEL, node $("$NODE" -v)). Log: $LOG"
echo "Check: curl -s http://127.0.0.1:${PORT:-3001}/api/ping"
