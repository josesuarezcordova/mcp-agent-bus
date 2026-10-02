# Changelog

All notable changes to this project are documented here.  
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.0] - 2026-10-02

### Added

- **`docs/watch-usage.sh`** — live token-usage dashboard (per worker + total).
- **`docs/watch-clarity.sh`** — prompt-quality report (TTFT, hedging %, interpretation overhead).
- **`docs/watch-workers.sh`** — multiplexed worker log viewer (macOS bash 3.2 compatible).
- **`docs/prompt-clarity.mjs`** — optional offline LLM judge for clarity scores.
- **Worker metrics** — headless worker records `stream-json` usage and clarity signals to
  `$MCP_AGENT_BUS_DIR/run/<name>.usage.jsonl` and `*.tasks.jsonl`.

### Changed

- **`src/worker.mjs`** — richer task execution (stream-json, safety/runaway guards, metrics).
  Uses `MCP_AGENT_BUS_DIR` via `mailbox.mjs` (Therapie-internal Teams/triage not included).

## [1.0.0] - 2026-10-01

### Added

- Initial public release: MCP server, mailbox core, setup script, Quick start README.
- Cross-region referrer-style mailbox behaviour documented for MCP consumers.

[1.1.0]: https://github.com/josesuarezcordova/mcp-agent-bus/releases/tag/v1.1.0
[1.0.0]: https://github.com/josesuarezcordova/mcp-agent-bus/releases/tag/v1.0.0
