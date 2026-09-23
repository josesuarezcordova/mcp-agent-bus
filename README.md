# MCP Agent Bus

A local, event-driven **MCP message bus** for coordinating multiple AI
coding-agent sessions on the same machine. One session can hand a task to
another — the other runs it and sends the result back — with **zero
infrastructure**: no cloud, no database, no network service. Just Node.js and
the local filesystem.

> A small, self-contained tool I built while working with multiple AI
> coding-agent sessions, shared openly so other teams can adopt the same
> pattern.

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

- **Node.js >= 18**
- An MCP-capable agent client (e.g. Cursor / `cursor-agent`).

## Install

```bash
git clone <this-repo> mcp-agent-bus
cd mcp-agent-bus
./scripts/setup.sh
```

`setup.sh` installs dependencies, writes a project-local `.cursor/mcp.json`
pointing at this checkout, and installs the always-on rule. Then reload your
agent client.

### Manual install

```bash
npm install
```

Then register the server with your MCP client using
[`examples/mcp.json.template`](examples/mcp.json.template) (replace
`<ABSOLUTE_PATH_TO_REPO>` with this checkout's path):

```json
{
  "mcpServers": {
    "mcp-agent-bus": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO_REPO>/src/server.mjs"],
      "env": { "MCP_AGENT_BUS_DIR": "<ABSOLUTE_PATH_TO_REPO>/bus" }
    }
  }
}
```

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

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `MCP_AGENT_BUS_DIR` | `~/.cursor/mcp-agent-bus` | Where the mailbox lives. |
| `AGENT_SESSION_NAME` | — | Convenience: each session's own name. |
| `WORKER_CWD` | current dir | Working directory the worker runs tasks in. |
| `AGENT_CMD` | `cursor-agent` | The agent CLI the worker invokes. |

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
