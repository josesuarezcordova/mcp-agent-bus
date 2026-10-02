#!/usr/bin/env bash
# watch-clarity.sh — PROMPT CLARITY report for Agent Bus workers.
#
# Shows, per sender / prompt-template / ticket, how CLEAR the incoming prompts
# were — i.e. did the agent understand the ask immediately, or did it waste
# effort interpreting / hunting for context? It merges TWO sources:
#
#   1. Automatic per-task signals from $AGENT_BUS_DIR/run/<name>.usage.jsonl
#      (written by worker.mjs): interpretationOverhead, explorationToolCalls,
#      ttftMs, ambiguityFlags, outcome, turns.
#   2. Optional LLM "judge" scores from $AGENT_BUS_DIR/run/clarity/*.clarity.jsonl
#      (written by docs/prompt-clarity.mjs): clarityScore 1-5, understood.
#
# There are NO cost/$ columns anywhere — this is about prompt quality, not spend.
#
# Usage:
#   ./docs/watch-clarity.sh                       # live, group by sender
#   ./docs/watch-clarity.sh --once                # one snapshot, then exit
#   ./docs/watch-clarity.sh --group-by template   # from|ticket|template|worker
#   ./docs/watch-clarity.sh --interval 5
#
# Env: AGENT_BUS_HOME, AGENT_BUS_DIR, AGENT_BUS_RUN_DIR.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_BUS_HOME="${AGENT_BUS_HOME:-$(cd "$HERE/.." && pwd)}"
BUS_ROOT="${MCP_AGENT_BUS_DIR:-${AGENT_BUS_DIR:-$AGENT_BUS_HOME/bus}}"
RUN_DIR="${AGENT_BUS_RUN_DIR:-${MCP_AGENT_BUS_RUN_DIR:-$BUS_ROOT/run}}"

ONCE=0
INTERVAL=2
GROUP_BY=from
while [ $# -gt 0 ]; do
  case "$1" in
    --once) ONCE=1 ;;
    --interval) shift; INTERVAL="${1:-2}" ;;
    --group-by) shift; GROUP_BY="${1:-from}" ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
  esac
  shift
done

mkdir -p "$RUN_DIR"

RUN_DIR="$RUN_DIR" ONCE="$ONCE" INTERVAL="$INTERVAL" GROUP_BY="$GROUP_BY" exec node -e '
const fs = require("fs");
const path = require("path");
const RUN_DIR = process.env.RUN_DIR;
const ONCE = process.env.ONCE === "1";
const INTERVAL = Math.max(1, parseInt(process.env.INTERVAL || "2", 10)) * 1000;
const GROUP_BY = process.env.GROUP_BY || "from";

const pad = (s, w, right = false) => {
  s = String(s);
  if (s.length > w) s = s.slice(0, w - 1) + "\u2026";
  return right ? s.padStart(w) : s.padEnd(w);
};
const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
const readJsonl = f => {
  let t = ""; try { t = fs.readFileSync(f, "utf8"); } catch { return []; }
  const o = [];
  for (const l of t.split("\n")) { const s = l.trim(); if (!s) continue; try { o.push(JSON.parse(s)); } catch {} }
  return o;
};
const templateKey = p => String(p || "").toLowerCase()
  .replace(/[A-Z]{2,}-\d+/gi, "").replace(/\d+/g, "#")
  .replace(/[^a-z0-9#]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

function collect() {
  // judge scores keyed by ts|name
  const clarity = new Map();
  let cfiles = [];
  try { cfiles = fs.readdirSync(path.join(RUN_DIR, "clarity")).filter(f => f.endsWith(".clarity.jsonl")); } catch {}
  for (const f of cfiles) for (const r of readJsonl(path.join(RUN_DIR, "clarity", f))) clarity.set(`${r.ts}|${r.name}`, r);

  // task text keyed by ts|name (for example prompts + template grouping)
  const texts = new Map();
  let tfiles = [];
  try { tfiles = fs.readdirSync(RUN_DIR).filter(f => f.endsWith(".tasks.jsonl")); } catch {}
  for (const f of tfiles) { const name = f.replace(/\.tasks\.jsonl$/, ""); for (const r of readJsonl(path.join(RUN_DIR, f))) texts.set(`${r.ts}|${name}`, r); }

  // usage records = the automatic signals (one per task)
  const recs = [];
  let ufiles = [];
  try { ufiles = fs.readdirSync(RUN_DIR).filter(f => f.endsWith(".usage.jsonl")); } catch {}
  for (const f of ufiles) {
    const name = f.replace(/\.usage\.jsonl$/, "");
    for (const e of readJsonl(path.join(RUN_DIR, f))) {
      const key = `${e.ts}|${name}`;
      const c = clarity.get(key);
      const tx = texts.get(key);
      const prompt = tx ? tx.promptText : "";
      recs.push({
        name, from: e.from || "unknown", ticket: e.ticket || null,
        template: templateKey(prompt), prompt,
        interp: e.interpretationOverhead || 0,
        explore: e.explorationToolCalls || 0,
        ttft: e.ttftMs || 0,
        hedge: e.ambiguityFlags ? (e.ambiguityFlags.count || 0) : 0,
        outcome: e.outcome || "success",
        clarityScore: c && c.clarityScore != null ? c.clarityScore : null,
        understood: c ? c.understood : null,
        missing: c ? c.missingContext : null,
        reason: c ? c.reason : null,
      });
    }
  }
  return recs;
}

function keyFn(r) {
  if (GROUP_BY === "ticket") return r.ticket || "(none)";
  if (GROUP_BY === "template") return r.template || "(empty)";
  if (GROUP_BY === "worker") return r.name;
  return r.from;
}
function label(k, rows) {
  if (GROUP_BY === "template") { const ex = rows.find(x => x.template === k); return ex && ex.prompt ? ex.prompt.replace(/\s+/g, " ").slice(0, 30) : k; }
  return k;
}

function render() {
  const recs = collect();
  const groups = new Map();
  for (const r of recs) { const k = keyFn(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }

  const W = { g: 24, n: 4, cl: 7, iv: 7, ex: 7, tf: 8, hg: 7, er: 7 };
  const head =
    pad("GROUP (" + GROUP_BY + ")", W.g) + pad("N", W.n, true) +
    pad("CLARITY", W.cl, true) + pad("INTERP", W.iv, true) +
    pad("EXPLORE", W.ex, true) + pad("TTFT", W.tf, true) +
    pad("HEDGE%", W.hg, true) + pad("ERR%", W.er, true);
  const rule = "\u2500".repeat(head.length);

  const rows = [...groups.entries()].map(([k, rs]) => {
    const scores = rs.map(r => r.clarityScore).filter(n => n != null);
    return {
      k, label: label(k, rs), n: rs.length,
      clarity: scores.length ? avg(scores) : null,
      interp: avg(rs.map(r => r.interp)),
      explore: avg(rs.map(r => r.explore)),
      ttft: avg(rs.map(r => r.ttft)),
      hedgeRate: pct(rs.filter(r => r.hedge > 0).length, rs.length),
      errRate: pct(rs.filter(r => r.outcome === "error" || r.outcome === "empty" || r.outcome === "timeout").length, rs.length),
    };
  }).sort((a, b) => (a.clarity ?? 99) - (b.clarity ?? 99) || b.hedgeRate - a.hedgeRate);

  const color = r => {
    // red-flag a group with low clarity / high hedging / errors
    if ((r.clarity != null && r.clarity <= 2.5) || r.hedgeRate >= 50 || r.errRate >= 50) return "\x1b[31m";
    if ((r.clarity != null && r.clarity <= 3.5) || r.hedgeRate >= 25) return "\x1b[33m";
    return "\x1b[32m";
  };
  const line = r =>
    color(r) +
    pad(r.label, W.g) + pad(r.n, W.n, true) +
    pad(r.clarity != null ? r.clarity.toFixed(2) : "-", W.cl, true) +
    pad(r.interp.toFixed(2), W.iv, true) +
    pad(r.explore.toFixed(1), W.ex, true) +
    pad(Math.round(r.ttft) + "ms", W.tf, true) +
    pad(r.hedgeRate + "%", W.hg, true) +
    pad(r.errRate + "%", W.er, true) +
    "\x1b[0m";

  let s = "";
  if (!ONCE) s += "\x1b[H\x1b[2J";
  s += "\x1b[1mAgent Bus \u2014 prompt clarity\x1b[0m  (" + RUN_DIR + ")\n";
  s += new Date().toLocaleTimeString() + "   " + recs.length + " task(s)   group by " + GROUP_BY + "   refresh " + (INTERVAL / 1000) + "s   Ctrl-C to stop\n";
  s += "CLARITY=judge 1-5 (higher=clearer)  INTERP=interpretation-overhead  EXPLORE=avg context tool-calls  TTFT=time-to-first-token  HEDGE%=tasks with hedging  ERR%=error/empty/timeout\n\n";
  s += "\x1b[1m" + head + "\x1b[0m\n" + rule + "\n";
  if (!rows.length) s += "  (no tasks yet \u2014 launch a worker + send it a task)\n";
  for (const r of rows) s += line(r) + "\n";

  // example low-clarity prompts to improve
  const worst = recs
    .filter(r => (r.clarityScore != null && r.clarityScore <= 2) || r.hedge > 0 || r.outcome === "error" || r.outcome === "empty")
    .sort((a, b) => (a.clarityScore ?? 9) - (b.clarityScore ?? 9) || b.hedge - a.hedge)
    .slice(0, 5);
  if (worst.length) {
    s += "\n\x1b[1mExample low-clarity prompts to improve\x1b[0m\n";
    for (const r of worst) {
      const tag = r.clarityScore != null ? `[${r.clarityScore}/5 ${r.understood}]` : `[hedges:${r.hedge} ${r.outcome}]`;
      s += `  \x1b[33m${tag}\x1b[0m from=${r.from}${r.ticket ? " " + r.ticket : ""}\n`;
      s += `    prompt : ${(r.prompt || "(text not logged)").replace(/\s+/g, " ").slice(0, 80)}\n`;
      if (r.missing && r.missing.length) s += `    missing: ${r.missing.join("; ")}\n`;
    }
  }
  process.stdout.write(s);
}

render();
if (!ONCE) setInterval(render, INTERVAL);
'
