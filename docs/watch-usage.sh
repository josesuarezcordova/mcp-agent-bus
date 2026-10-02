#!/usr/bin/env bash
# watch-usage.sh — live token-usage dashboard for Agent Bus workers.
#
# Each worker (worker.mjs) now runs cursor-agent with --output-format stream-json
# and appends the per-task token usage to $AGENT_BUS_DIR/run/<name>.usage.jsonl.
# This script tails those files and prints a live, aggregated table:
#
#   WORKER   TASKS   INPUT   OUTPUT   CACHE-R   CACHE-W   TOKENS(in+out)   LAST
#
# plus a TOTAL row across all workers. It refreshes in place until Ctrl-C.
#
# Usage:
#   ./docs/watch-usage.sh                 # live dashboard (refresh every 2s)
#   ./docs/watch-usage.sh --once          # print one snapshot and exit
#   ./docs/watch-usage.sh --interval 5    # refresh every 5s
#   AGENT_BUS_DIR=/path/.bus ./docs/watch-usage.sh
#
# Env vars (all optional):
#   AGENT_BUS_HOME     path to this repo         (default: parent of this script)
#   AGENT_BUS_DIR      shared mailbox            (default: $AGENT_BUS_HOME/.bus)
#   AGENT_BUS_RUN_DIR  where usage files live    (default: $AGENT_BUS_DIR/run)
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_BUS_HOME="${AGENT_BUS_HOME:-$(cd "$HERE/.." && pwd)}"
# MCP_AGENT_BUS_DIR (open-source) or AGENT_BUS_DIR (Therapie agent-bus) — same mailbox.
BUS_ROOT="${MCP_AGENT_BUS_DIR:-${AGENT_BUS_DIR:-$AGENT_BUS_HOME/bus}}"
RUN_DIR="${AGENT_BUS_RUN_DIR:-${MCP_AGENT_BUS_RUN_DIR:-$BUS_ROOT/run}}"

ONCE=0
INTERVAL=2
while [ $# -gt 0 ]; do
  case "$1" in
    --once) ONCE=1 ;;
    --interval) shift; INTERVAL="${1:-2}" ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
  esac
  shift
done

mkdir -p "$RUN_DIR"

RUN_DIR="$RUN_DIR" ONCE="$ONCE" INTERVAL="$INTERVAL" exec node -e '
const fs = require("fs");
const path = require("path");
const RUN_DIR = process.env.RUN_DIR;
const ONCE = process.env.ONCE === "1";
const INTERVAL = Math.max(1, parseInt(process.env.INTERVAL || "2", 10)) * 1000;

const fmt = n => (n || 0).toLocaleString("en-US");
const pad = (s, w, right = false) => {
  s = String(s);
  if (s.length > w) s = s.slice(0, w - 1) + "…";
  return right ? s.padStart(w) : s.padEnd(w);
};
const ago = ts => {
  if (!ts) return "-";
  const s = Math.round((Date.now() - Date.parse(ts)) / 1000);
  if (isNaN(s)) return "-";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60) + "s";
  return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
};

function collect() {
  const rows = {};
  let files = [];
  try { files = fs.readdirSync(RUN_DIR).filter(f => f.endsWith(".usage.jsonl")); } catch {}
  for (const f of files) {
    const name = f.replace(/\.usage\.jsonl$/, "");
    const r = rows[name] || (rows[name] = { name, tasks: 0, in: 0, out: 0, cr: 0, cw: 0, last: null });
    let text = "";
    try { text = fs.readFileSync(path.join(RUN_DIR, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let e; try { e = JSON.parse(t); } catch { continue; }
      r.tasks++;
      r.in += e.inputTokens || 0;
      r.out += e.outputTokens || 0;
      r.cr += e.cacheReadTokens || 0;
      r.cw += e.cacheWriteTokens || 0;
      if (e.ts && (!r.last || Date.parse(e.ts) > Date.parse(r.last))) r.last = e.ts;
    }
  }
  return Object.values(rows);
}

function render() {
  const rows = collect().sort((a, b) => (b.in + b.out) - (a.in + a.out));
  const tot = rows.reduce((a, r) => {
    a.tasks += r.tasks; a.in += r.in; a.out += r.out; a.cr += r.cr; a.cw += r.cw;
    if (r.last && (!a.last || Date.parse(r.last) > Date.parse(a.last))) a.last = r.last;
    return a;
  }, { tasks: 0, in: 0, out: 0, cr: 0, cw: 0, last: null });

  const W = { name: 16, tasks: 6, num: 12, last: 8 };
  const head =
    pad("WORKER", W.name) + pad("TASKS", W.tasks, true) + " " +
    pad("INPUT", W.num, true) + pad("OUTPUT", W.num, true) +
    pad("CACHE-R", W.num, true) + pad("CACHE-W", W.num, true) +
    pad("IN+OUT", W.num, true) + "  " + pad("LAST", W.last, true);
  const rule = "─".repeat(head.length);

  const line = r =>
    pad(r.name, W.name) + pad(fmt(r.tasks), W.tasks, true) + " " +
    pad(fmt(r.in), W.num, true) + pad(fmt(r.out), W.num, true) +
    pad(fmt(r.cr), W.num, true) + pad(fmt(r.cw), W.num, true) +
    pad(fmt(r.in + r.out), W.num, true) + "  " + pad(ago(r.last), W.last, true);

  let s = "";
  if (!ONCE) s += "\x1b[H\x1b[2J"; // home + clear
  s += "\x1b[1mAgent Bus — live token usage\x1b[0m  (" + RUN_DIR + ")\n";
  s += new Date().toLocaleTimeString() + "   " + rows.length + " worker(s)   refresh " + (INTERVAL / 1000) + "s   Ctrl-C to stop\n\n";
  s += "\x1b[1m" + head + "\x1b[0m\n" + rule + "\n";
  if (!rows.length) s += "  (no usage yet — launch a worker and give it a task)\n";
  for (const r of rows) s += line(r) + "\n";
  s += rule + "\n";
  s += "\x1b[1m" + line({ ...tot, name: "TOTAL" }) + "\x1b[0m\n";
  process.stdout.write(s);
}

render();
if (!ONCE) setInterval(render, INTERVAL);
'
