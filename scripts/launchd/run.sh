#!/bin/bash
# Started by the launchd agent (io.github.hermesfllm) instead of node itself, to fix two failure
# modes of a long-lived service:
#
# 1. Node moves. install.sh used to pin the absolute path of the Node that ran it; with nvm that path
#    disappears on the next `nvm install`/`nvm uninstall`, and the service died on every restart.
#    Here the Node is chosen at each start: the one recorded at install (HERMESFLLM_NODE), then nvm's
#    default, then whatever is on PATH (Homebrew included). Each candidate must load better-sqlite3,
#    the native module built for one Node ABI, so a Node that would crash on start is skipped.
# 2. The log grew forever. Output now goes through a writer that rotates the log by size
#    (HERMESFLLM_LOG_MAX_BYTES, default 10 MB, keeping HERMESFLLM_LOG_KEEP=3 old files).
#
# If no candidate can run the server, the reason is written to the log and the script waits before
# exiting, so launchd's KeepAlive does not turn a broken install into a restart loop.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${HERMESFLLM_REPO:-$(cd "$HERE/../.." && pwd)}"
LOG="${HERMESFLLM_LOG:-$HOME/Library/Logs/HermesFLLM/hermesfllm.log}"
MAX_BYTES="${HERMESFLLM_LOG_MAX_BYTES:-10485760}"
KEEP="${HERMESFLLM_LOG_KEEP:-3}"
CHECK_EVERY="${HERMESFLLM_LOG_CHECK_EVERY:-200}"
NO_NODE_WAIT="${HERMESFLLM_NO_NODE_WAIT_S:-300}"

mkdir -p "$(dirname "$LOG")"

say() { printf '%s [run.sh] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"; }

rotate_if_big() {
  [ -f "$LOG" ] || return 0
  local size
  size=$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')
  [ "${size:-0}" -ge "$MAX_BYTES" ] || return 0
  local i
  rm -f "$LOG.$KEEP"
  for ((i = KEEP - 1; i >= 1; i--)); do
    [ -f "$LOG.$i" ] && mv -f "$LOG.$i" "$LOG.$((i + 1))"
  done
  mv -f "$LOG" "$LOG.1"
}

# Every line goes through here, so the log can be rotated while the server runs.
write_log() {
  local line n=0
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line" >> "$LOG"
    n=$((n + 1))
    if [ "$n" -ge "$CHECK_EVERY" ]; then
      n=0
      rotate_if_big
    fi
  done
}

nvm_default_node() {
  local dir="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$dir/nvm.sh" ] || return 0
  # shellcheck disable=SC1091
  ( . "$dir/nvm.sh" >/dev/null 2>&1 && nvm which default 2>/dev/null ) || true
}

can_run() {
  local node="$1"
  [ -n "$node" ] && [ -x "$node" ] || return 1
  ( cd "$REPO/server" && "$node" -e "require('better-sqlite3')" ) >/dev/null 2>&1
}

pick_node() {
  local candidate
  for candidate in "${HERMESFLLM_NODE:-}" "$(nvm_default_node)" \
    "$(PATH="${HERMESFLLM_EXTRA_PATH-/opt/homebrew/bin:/usr/local/bin}:$PATH" command -v node 2>/dev/null)"; do
    if can_run "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
    [ -n "$candidate" ] && say "skipping $candidate: missing, or it cannot load better-sqlite3 (built for another Node)"
  done
  return 1
}

rotate_if_big

if ! NODE="$(pick_node)"; then
  say "no Node can run the server. Fix: in $REPO run 'npm rebuild better-sqlite3' with the Node you want, then 'scripts/launchd/install.sh'. Waiting ${NO_NODE_WAIT}s before exiting."
  sleep "$NO_NODE_WAIT"
  exit 1
fi

[ "$NODE" != "${HERMESFLLM_NODE:-}" ] && say "using $NODE ($("$NODE" -v 2>/dev/null)) instead of the install-time Node ${HERMESFLLM_NODE:-unset}"

cd "$REPO/server" || { say "missing $REPO/server"; exit 1; }
# Output is piped through write_log; launchd stops the whole process group on bootout.
"$NODE" dist/index.js 2>&1 | write_log
exit "${PIPESTATUS[0]}"
