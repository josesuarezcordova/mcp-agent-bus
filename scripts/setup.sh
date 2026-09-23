#!/usr/bin/env bash
# One-command install for MCP Agent Bus.
#
# Installs dependencies and writes a project-local .cursor/mcp.json that points
# at this checkout, plus the always-on rule so every session knows how to use
# the bus. Re-runnable and safe.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CURSOR_DIR="$ROOT/.cursor"

echo "==> Installing dependencies..."
( cd "$ROOT" && npm install --omit=dev )

echo "==> Writing $CURSOR_DIR/mcp.json for this machine..."
mkdir -p "$CURSOR_DIR" "$CURSOR_DIR/rules"
cat > "$CURSOR_DIR/mcp.json" <<JSON
{
  "mcpServers": {
    "mcp-agent-bus": {
      "command": "node",
      "args": ["$ROOT/src/server.mjs"],
      "env": { "MCP_AGENT_BUS_DIR": "$ROOT/bus" }
    }
  }
}
JSON

echo "==> Installing the always-on rule..."
cp "$ROOT/examples/mcp-agent-bus.mdc" "$CURSOR_DIR/rules/mcp-agent-bus.mdc"

cat <<'DONE'

Done ✅
Next steps:
  1. Reload Cursor so it picks up the new MCP server.
  2. Set AGENT_SESSION_NAME per session (e.g. export AGENT_SESSION_NAME=backend).
  3. Verify with: bus_list_sessions()

Optional (autonomous worker in a plain terminal):
  MCP_AGENT_BUS_DIR="$PWD/bus" WORKER_CWD="$PWD" node src/worker.mjs <name> --model <your-model>
DONE
