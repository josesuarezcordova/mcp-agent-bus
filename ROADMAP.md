# MCP Agent Bus — Roadmap & Decisions

A running record of architectural decisions so we can revisit them later.

## Decision (2026-09-01): v1 ships the "hub-orchestrated" model

**Decision:** The first solid/public version uses **one interactive hub + N headless
workers**. The human drives a single interactive session (the hub), which dispatches
tasks to headless workers by name; workers auto-run each task and reply; the hub
collects the results.

**Why:**
- Simple, predictable, observable — the right bar for a *first* (and public) version.
- One clear human control seat (the hub); on-demand receive is fine there because the
  human is present.
- Workers provide autonomous parallel execution without loop/runaway risk.
- No inbox contention (each worker drains only its own inbox).

**Status:** current behavior of `worker.mjs` + the interactive `bus_receive`/`bus_send`
flow. Considered the baseline for v1.

## Known limitation to fix before publishing (v1.x)

- **Per-task timeout in the worker.** Today a hung `cursor-agent -p` run makes the
  worker wait forever: no reply is sent, the consumed message is lost, and the worker
  stays "busy" so queued tasks don't process. Fix: add a per-task timeout that kills a
  stuck run and replies with an error, so a bad task can't silently stall the pipeline.

## v2 vision (future — NOT built yet): peer-to-peer worker network

**Goal (Jose, 2026-09-01):** *"A network of headless workers that can send commands to
each other and route the result back to the original sender."*

This is a genuinely different tier from v1. Why it's not trivial with today's design:
- A worker's inbox is monopolized by its own drain loop, so a reply addressed to a
  worker is mistaken for a **new task** (loop/confusion).
- A worker replies to its original sender with its **own** output, not a downstream
  worker's result — so A→B→hub chains don't route cleanly.

**What v2 needs to be safe/reliable:**
- **Separate task vs. reply channels** (so a worker awaiting a subtask's reply isn't
  eaten by its own task-drain loop).
- **Correlation IDs** to match each reply to the request that spawned it.
- **Loop + timeout guards** so peer chains can't run away.
- Builds on the v1.x **per-task timeout**.
- Verify headless `cursor-agent -p` runs actually have the `bus_*` MCP tools available
  (needed for a worker to send at all).

**Decision:** Defer v2 until v1 is shipped and proven. Documented here so the direction
isn't lost.
