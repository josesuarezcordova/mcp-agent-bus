# MCP Agent Bus

A local, event-driven **MCP message bus** for coordinating multiple AI
coding-agent sessions on the same machine. One session can hand a task to
another — the other runs it and sends the result back — with **zero
infrastructure**: no cloud, no database, no network service. Just Node.js and
the local filesystem.

> A small, self-contained tool I built while working with multiple AI
> coding-agent sessions, shared openly so other teams can adopt the same
> pattern.

## Releases

This project is **distributed via GitHub only** (no hosted service). Install = clone + `npm install` + MCP setup — see [Quick start](#quick-start-cursor-5-minutes).

| Version | Highlights |
|---------|------------|
| **[v1.1.0](https://github.com/josesuarezcordova/mcp-agent-bus/releases/tag/v1.1.0)** (latest) | Monitoring dashboards (`docs/watch-*.sh`) + worker token/clarity metrics |
| **[v1.0.0](https://github.com/josesuarezcordova/mcp-agent-bus/releases/tag/v1.0.0)** | First public release — MCP bus + Quick start |

Full history: [CHANGELOG.md](CHANGELOG.md) · [All releases](https://github.com/josesuarezcordova/mcp-agent-bus/releases)

**Upgrade v1.0.0 → v1.1.0:** `git pull` (or re-clone), `npm install` unchanged. New optional scripts under `docs/`; worker upgrade only affects you if you use the headless worker.

## Why

When you work with AI coding agents you often have several sessions open at
once (different windows, different models). By default they can't see each other
— you copy-paste between windows by hand. MCP Agent Bus gives them a shared "post
office": any session can drop a message addressed to another, which picks it up
instantly and replies.

## How it works

Everything is local. The "post office" is just a folder of JSON files:

```
<MCP_AGENT_BUS_DIR>/
  inbox/<session>/*.json   # direct messages, one folder per session
  broadcast/*.json         # announcements to everyone
  cursors/<session>...     # per-session "already read" bookmark
```

- **One MCP process per session**, all sharing the same folder.
- **Atomic writes** (temp file + `rename`) so readers never see a partial file.
- **Consume-once**: reading an inbox removes the message.
- **Event-driven** via `fs.watch` (with a slow safety poll), so delivery is
  effectively instant and there's no busy-polling.

## Requirements

- **Node.js >= 18** (`node -v`)
- **[Cursor](https://cursor.com)** (or another MCP-capable client) with MCP enabled
- **Optional — headless worker only:** [Cursor CLI](https://cursor.com/docs/cli) (`cursor-agent` on your `PATH`)

All sessions that should talk to each other must use the **same** `MCP_AGENT_BUS_DIR` (same mailbox folder on disk).

---

## Quick start (Cursor, ~5 minutes)

### 1. Clone and install

```bash
git clone https://github.com/josesuarezcordova/mcp-agent-bus.git
cd mcp-agent-bus
./scripts/setup.sh
```

`setup.sh` runs `npm install`, creates a local `bus/` mailbox under this repo, writes **project-local** `.cursor/mcp.json`, and copies the always-on rule to `.cursor/rules/mcp-agent-bus.mdc`.

Check the server starts (optional):

```bash
npm test
```

### 2. Reload Cursor

1. Open **this folder** (`mcp-agent-bus`) in Cursor, **or** complete [Use with your own project](#use-with-your-own-project) below if you work in another repo.
2. **Cursor Settings → MCP** — confirm `mcp-agent-bus` appears (green / enabled).
3. If you do not see it: **Command Palette → “Developer: Reload Window”**, then check MCP again.

### 3. Give each session a name

Every Cursor window is one “session”. Pick a short handle per window, e.g. `backend` and `reviewer`.

Tell the agent once per window, for example:

> “On the agent bus, my session name is **backend**. Use that for `from` / `me` on bus tools.”

The rule in `.cursor/rules/mcp-agent-bus.mdc` reminds the agent to ask if the name is not set.

**Important:** use **different names** in each window. Do not run a headless worker and interactive `bus_receive` on the **same** name (they share one inbox).

### 4. Smoke test (two windows)

Use the **same workspace** (same `.cursor/mcp.json` and same `MCP_AGENT_BUS_DIR`) in both windows.

| Window | Session name | Example prompt |
|--------|----------------|----------------|
| A | `sender` | “Call `bus_send` to **reviewer** from **sender** with text `hello from sender`.” |
| B | `reviewer` | “Call `bus_receive` with `me=reviewer`, `block=true`, `timeout_ms=30000` and show the result.” |

Window B should return the JSON message. Then B can reply with `bus_send(to="sender", from="reviewer", ...)`.

Quick check in either window: **`bus_list_sessions()`** — after traffic, you should see inbox folders for active names.

### 5. Optional — autonomous worker (terminal)

For a session that runs tasks without you in the loop, in a **plain terminal** (not inside the agent):

```bash
cd /path/to/mcp-agent-bus   # or your project with WORKER_CWD set
MCP_AGENT_BUS_DIR="/path/to/mcp-agent-bus/bus" \
WORKER_CWD="/path/to/your/project" \
node src/worker.mjs reviewer --model <your-model>
```

Requires `cursor-agent` installed and logged in. The worker runs prompts with `--force` (auto-approves tool actions) — only accept tasks from senders you trust.

**Optional — Teams push on your phone:** set `TEAMS_WEBHOOK_URL` to a Microsoft Teams **Workflow** incoming webhook. The worker posts an Adaptive Card when a task **finishes**, **fails**, or trips the **runaway guard**. Full setup (channel choice, env vars, smoke test, troubleshooting): **[docs/teams-notify.md](docs/teams-notify.md)**.

```bash
export TEAMS_WEBHOOK_URL='https://...'   # never commit this URL
node src/worker.mjs wkr-01 --model <your-model>
# startup line: [worker] Teams notify: ON (events: done,fail,alarm)
```

---

## Use with your own project

Most people keep coding in **their app repo**, not inside `mcp-agent-bus`. Point MCP at the cloned server and use one **shared mailbox path** everywhere.

1. Clone `mcp-agent-bus` once, e.g. `~/tools/mcp-agent-bus`, and run `npm install` there.
2. In **your project**, merge into `.cursor/mcp.json` (keep your existing servers):

```json
{
  "mcpServers": {
    "mcp-agent-bus": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-agent-bus/src/server.mjs"],
      "env": {
        "MCP_AGENT_BUS_DIR": "/ABSOLUTE/PATH/TO/mcp-agent-bus/bus"
      }
    }
  }
}
```

Use **absolute paths**. Every window that should share the bus must use the **same** `MCP_AGENT_BUS_DIR`.

3. Copy the rule into your project:

```bash
cp /ABSOLUTE/PATH/TO/mcp-agent-bus/examples/mcp-agent-bus.mdc \
   /ABSOLUTE/PATH/TO/your-project/.cursor/rules/
```

4. Reload Cursor and run the [smoke test](#4-smoke-test-two-windows) with two windows on **your project** folder.

### Global MCP (all projects)

Alternatively, put the same `mcpServers.mcp-agent-bus` block in **`~/.cursor/mcp.json`** and copy `mcp-agent-bus.mdc` to a location Cursor loads globally (or paste the rule into your user rules). Same rule applies: one shared `MCP_AGENT_BUS_DIR` for all participating sessions.

---

## Manual install (no setup script)

```bash
git clone https://github.com/josesuarezcordova/mcp-agent-bus.git
cd mcp-agent-bus
npm install
```

Register the server using [`examples/mcp.json.template`](examples/mcp.json.template) (replace `<ABSOLUTE_PATH_TO_REPO>` with your checkout path), then reload your MCP client.

---

## Troubleshooting

| Problem | What to try |
|--------|-------------|
| MCP server missing in Cursor | Reload window; check `.cursor/mcp.json` syntax; paths must be absolute. |
| Messages never arrive | Both windows must share the **same** `MCP_AGENT_BUS_DIR`; confirm with the same path in each `mcp.json`. |
| `bus_receive` times out empty | Wrong session name (`me` / `to` typo); sender used a different mailbox dir. |
| Worker does nothing | Install CLI: `cursor-agent`; set `MCP_AGENT_BUS_DIR` and `WORKER_CWD`; do not use the same name in Cursor and worker. |
| Teams cards never arrive | Follow [docs/teams-notify.md](docs/teams-notify.md): Standard channel, “post to channel” workflow, `TEAMS_WEBHOOK_URL` in the **same** shell as the worker; check stderr for `Teams notify failed`. |
| Permission errors on `bus/` | Ensure the mailbox directory exists and is writable (`setup.sh` creates `bus/`). |

Run **`npm test`** in the clone to verify the mailbox logic on your machine (no Cursor required).

## Tools

| Tool | Purpose |
|---|---|
| `bus_send(to, from, text, subject?)` | Send a direct message to another session's inbox. |
| `bus_receive(me, block?, timeout_ms?)` | Fetch & consume your messages; optionally block until one arrives. |
| `bus_peek(me)` | Look at your inbox without consuming. |
| `bus_broadcast(from, text)` | Post an announcement visible to all sessions. |
| `bus_read_broadcasts(me)` | Read announcements newer than your last read. |
| `bus_list_sessions()` | List sessions that currently have an inbox. |

### Message shape

```json
{
  "id": "1725183600000-a1b2c3d4",
  "type": "direct",
  "to": "backend",
  "from": "frontend",
  "subject": "handoff",
  "text": "please run the end-to-end tests",
  "ts": "2026-09-01T10:00:00.000Z"
}
```

## Two ways to receive work

- **Interactive (human in the loop):** your active session calls `bus_receive`,
  you see the task, it's done with normal tools, and you reply with `bus_send`.
- **Autonomous (headless worker):** run `src/worker.mjs` in a plain terminal. It
  watches an inbox and, for each task, runs a fresh headless agent
  (`cursor-agent -p`) and replies automatically:

```bash
MCP_AGENT_BUS_DIR="$PWD/bus" WORKER_CWD="$PWD" \
  node src/worker.mjs backend --model <your-model>
```

> **Safety:** the worker runs tasks with `cursor-agent -p ... --force`
> (auto-approves shell/file actions). Only run it for senders you trust.
> The agent command is configurable via the `AGENT_CMD` env var.

## Monitoring workers (optional)

When the headless worker runs with `cursor-agent --output-format stream-json`, it appends per-task metrics under **`$MCP_AGENT_BUS_DIR/run/`** (default: `<repo>/bus/run/`):

| Script | What it shows |
|--------|----------------|
| [`docs/watch-usage.sh`](docs/watch-usage.sh) | Live **token** dashboard (input/output/cache, per worker + total) |
| [`docs/watch-clarity.sh`](docs/watch-clarity.sh) | **Prompt quality** (TTFT, hedging %, interpretation overhead) |
| [`docs/watch-workers.sh`](docs/watch-workers.sh) | Multiplexed **logs** for all workers (macOS-compatible) |

```bash
cd /path/to/mcp-agent-bus
./docs/watch-usage.sh
./docs/watch-clarity.sh
./docs/watch-workers.sh
```

Optional offline LLM judge for clarity scores: `AGENT_BUS_HOME="$PWD" node docs/prompt-clarity.mjs`

These dashboards are the same tooling used in the internal [therapietech/agent-bus](https://github.com/therapietech/agent-bus) repo (Therapie); paths accept both `MCP_AGENT_BUS_DIR` and `AGENT_BUS_DIR`.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `MCP_AGENT_BUS_DIR` | `~/.cursor/mcp-agent-bus` | Where the mailbox lives. |
| `AGENT_SESSION_NAME` | — | Convenience: each session's own name. |
| `WORKER_CWD` | current dir | Working directory the worker runs tasks in. |
| `AGENT_CMD` | `cursor-agent` | The agent CLI the worker invokes. |
| `TEAMS_WEBHOOK_URL` | — | Teams Workflows webhook URL; enables worker push notifications. |
| `TEAMS_NOTIFY_EVENTS` | `done,fail,alarm` | Which worker events post to Teams. |

See [docs/teams-notify.md](docs/teams-notify.md) for worker-only Teams setup.

## Development

```bash
npm test     # unit tests (node:test), no external services
npm run lint # eslint (flat config)
```

The core mailbox logic lives in [`src/mailbox.mjs`](src/mailbox.mjs) and is
fully unit-tested in isolation; [`src/server.mjs`](src/server.mjs) is a thin MCP
wrapper around it.

## Limitations

- **Single machine.** It coordinates sessions on one host; it is not a
  cross-machine or team-wide bus.
- **One receiver per session name** — don't run a headless worker *and* an
  interactive receive on the same name (they'd fight over the inbox).
- **Messages are consumed** — for a durable record, pair the bus with a shared
  notes file.

## License

[MIT](LICENSE)
