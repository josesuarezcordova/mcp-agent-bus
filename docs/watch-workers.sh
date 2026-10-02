#!/usr/bin/env bash
# watch-workers.sh — live multiplexed viewer for Agent Bus worker logs.
#
# Each worker launched via `busworker` / bus-worker-launch.sh writes a logfile
# to $AGENT_BUS_DIR/run/<name>.log. This script tails them ALL at once, prefixes
# every line with the worker name, and auto-attaches to workers launched *after*
# you start it — so you get one terminal pane showing everything.
#
# Compatible with macOS /bin/bash 3.2 (no associative arrays).
#
# Usage:
#   ./docs/watch-workers.sh                 # tail all current + future worker logs
#   ./docs/watch-workers.sh --new           # only workers launched from now on
#   AGENT_BUS_DIR=/path/.bus ./docs/watch-workers.sh
#
# Stop: Ctrl-C
#
# Env vars (all optional):
#   AGENT_BUS_HOME     path to this repo         (default: parent of this script)
#   AGENT_BUS_DIR      shared mailbox            (default: $AGENT_BUS_HOME/.bus)
#   AGENT_BUS_RUN_DIR  where pidfiles/logs live  (default: $AGENT_BUS_DIR/run)
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_BUS_HOME="${AGENT_BUS_HOME:-$(cd "$HERE/.." && pwd)}"
BUS_ROOT="${MCP_AGENT_BUS_DIR:-${AGENT_BUS_DIR:-$AGENT_BUS_HOME/bus}}"
RUN_DIR="${AGENT_BUS_RUN_DIR:-${MCP_AGENT_BUS_RUN_DIR:-$BUS_ROOT/run}}"

NEW_ONLY=0
[ "${1:-}" = "--new" ] && NEW_ONLY=1

mkdir -p "$RUN_DIR"

STATE="$(mktemp -d "${TMPDIR:-/tmp}/watch-workers.XXXXXX")"
mkdir -p "$STATE/seen" "$STATE/pids"

worker_key() {
  basename "$1" .log
}

mark_seen() {
  touch "$STATE/seen/$(worker_key "$1")"
}

is_seen() {
  [ -f "$STATE/seen/$(worker_key "$1")" ]
}

is_attached() {
  local key pidfile
  key="$(worker_key "$1")"
  pidfile="$STATE/pids/$key"
  [ -f "$pidfile" ] || return 1
  kill -0 "$(cat "$pidfile")" 2>/dev/null
}

# ANSI: give each worker a stable-ish color by hashing its name.
color_for() {
  local sum=0 c i
  for (( i=0; i<${#1}; i++ )); do
    printf -v c '%d' "'${1:$i:1}"
    sum=$(( (sum + c) % 6 ))
  done
  printf '3%d' $(( sum + 1 ))   # 31..36
}

# In --new mode, mark existing logs as already-seen so we skip their history.
if [ "$NEW_ONLY" = 1 ]; then
  for f in "$RUN_DIR"/*.log; do
    [ -e "$f" ] || continue
    mark_seen "$f"
  done
  echo "▶ Watching for NEW workers only (drop --new to include current ones)."
else
  echo "▶ Watching ALL worker logs in $RUN_DIR (Ctrl-C to stop)."
fi

cleanup() {
  local pf
  for pf in "$STATE/pids"/*; do
    [ -f "$pf" ] || continue
    kill "$(cat "$pf")" 2>/dev/null
  done
  rm -rf "$STATE"
  exit 0
}
trap cleanup INT TERM

attach() {
  local f="$1" name col key tailargs pid prefix
  key="$(worker_key "$f")"
  name="$key"
  col="$(color_for "$name")"
  tailargs="-n +1"
  if is_seen "$f"; then
    tailargs="-n 0"
  fi
  prefix="$(printf '\033[%sm[%s]\033[0m ' "$col" "$name")"
  # macOS sed has no -u; line buffering is fine for log tailing.
  ( tail $tailargs -F "$f" 2>/dev/null | sed "s/^/${prefix}/" ) &
  pid=$!
  echo "$pid" >"$STATE/pids/$key"
  echo "── attached $name ──"
}

# Attach to whatever exists now (respecting seen markers for --new).
for f in "$RUN_DIR"/*.log; do
  [ -e "$f" ] || continue
  attach "$f"
done

# Poll for newly-created logs and attach to them on the fly.
while true; do
  for f in "$RUN_DIR"/*.log; do
    [ -e "$f" ] || continue
    if ! is_attached "$f"; then
      mark_seen "$f"
      attach "$f"
    fi
  done
  sleep 2
done
