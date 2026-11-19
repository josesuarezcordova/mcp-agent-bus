# Changelog

All notable changes to this project are documented here.  
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**Deployments:** each section is one merge to [`main`](https://github.com/josesuarezcordova/mcp-agent-bus) (pull request = deployment).

## [Unreleased]

## [1.4.0] - 2026-11-18 — [#4](https://github.com/josesuarezcordova/mcp-agent-bus/pull/4)

### Added

- **`WORKER_MAX_LIFETIME_MS`** (default 24h) — headless worker exits cleanly when idle after a wall-clock cap; set `0` for no limit.

### Changed

- **`README.md`**, **`examples/mcp-agent-bus.mdc`** — document wall-clock worker cap.

## [1.3.0] - 2026-11-12 — [#3](https://github.com/josesuarezcordova/mcp-agent-bus/pull/3)

### Changed

- **`WORKER_FORCE` default off**; refuse start if force on without **`ALLOWED_SENDERS`**.
- Startup warning about global **`~/.cursor/mcp.json`** inheritance.
- **`README.md`**, **`examples/mcp-agent-bus.mdc`**.

## [1.2.0] - 2026-10-09 — [#2](https://github.com/josesuarezcordova/mcp-agent-bus/pull/2)

### Added

- **Microsoft Teams notifications** (`TEAMS_WEBHOOK_URL`, `TEAMS_NOTIFY_EVENTS`).
- **`docs/teams-notify.md`** — Teams Workflows setup and troubleshooting.

### Changed

- **`src/worker.mjs`** — Adaptive Cards on done / fail / alarm (best-effort).

## [1.1.0] - 2026-10-02 — [#1](https://github.com/josesuarezcordova/mcp-agent-bus/pull/1)

### Added

- **`docs/watch-usage.sh`**, **`docs/watch-clarity.sh`**, **`docs/watch-workers.sh`**, **`docs/prompt-clarity.mjs`**.
- Worker metrics: **`$MCP_AGENT_BUS_DIR/run/<name>.usage.jsonl`** and **`*.tasks.jsonl`**.

### Changed

- **`src/worker.mjs`** — stream-json usage, safety/runaway guards, clarity metrics.

## [1.0.0] - 2026-10-01

### Added

- Initial public release: MCP server, mailbox core, setup script, Quick start **README**.

[1.4.0]: https://github.com/josesuarezcordova/mcp-agent-bus/releases/tag/v1.4.0
[1.3.0]: https://github.com/josesuarezcordova/mcp-agent-bus/releases/tag/v1.3.0
[1.2.0]: https://github.com/josesuarezcordova/mcp-agent-bus/releases/tag/v1.2.0
[1.1.0]: https://github.com/josesuarezcordova/mcp-agent-bus/releases/tag/v1.1.0
[1.0.0]: https://github.com/josesuarezcordova/mcp-agent-bus/releases/tag/v1.0.0