# Microsoft Teams notifications (headless worker)

Optional push notifications when the **headless worker** (`src/worker.mjs`) finishes a task, fails, or trips the runaway/loop guard. No code changes — only environment variables and a Teams **Workflow** webhook.

**What you need**

- Microsoft Teams (work or school account is fine).
- A **Standard** channel you can add a workflow to (see pitfalls below).
- The worker already running with `cursor-agent` (see [README](../README.md#5-optional--autonomous-worker-terminal)).

**What you do *not* need**

- Azure subscriptions, bots registered in Entra, or app secrets in this repo.
- Teams enabled for MCP sessions — only the **terminal worker** sends cards.

---

## Step 1 — Create the workflow in Teams

1. Open **Microsoft Teams** (desktop or web).
2. Go to the **team** and **channel** where you want alerts (e.g. `#dev-automation`).
3. At the top of the channel, open **Workflows** (or **More** → **Workflows**).
4. Choose a template such as **“Post to a channel when a webhook request is received”** or **“Send webhook alerts to a channel”**.
   - Pick a flow that ends with **posting to this channel**, not “send to a chat”.
5. Complete the wizard and **turn the workflow on**.
6. Copy the **HTTP POST URL** Teams gives you. It is long and usually contains `sig=` — treat it as a **password**.

> **Channel type:** Prefer a **Standard** channel. Some **Private** channels reject the Flow bot (“not a ChatThread”). If posting fails with that error, use a Standard channel.

> **Wrong template:** Flows that target **a personal chat** or **“self”** often fail. Always choose **channel** delivery.

---

## Step 2 — Store the URL safely (never commit it)

Do **not** put the URL in git, README, or `.env` files that might be committed.

**Option A — shell profile (recommended for one machine)**

Add to `~/.zshrc` or `~/.bashrc`:

```bash
export TEAMS_WEBHOOK_URL='https://...paste-your-full-url...'
# optional: only some events (default is all three)
# export TEAMS_NOTIFY_EVENTS='done,fail,alarm'
```

Reload: `source ~/.zshrc`

**Option B — one-off in the same terminal where you start the worker**

```bash
export TEAMS_WEBHOOK_URL='https://...'
```

---

## Step 3 — Start the worker with the same env as the bus

Use the **same** `MCP_AGENT_BUS_DIR` as your Cursor MCP config. Example:

```bash
cd /path/to/mcp-agent-bus

export MCP_AGENT_BUS_DIR="/path/to/mcp-agent-bus/bus"
export WORKER_CWD="/path/to/your/project"
export TEAMS_WEBHOOK_URL='https://...'   # if not already in ~/.zshrc

# optional: lock worker to tasks from one hub only
# export ALLOWED_SENDERS=hub

node src/worker.mjs wkr-01 --model composer-2.5-fast
```

On startup you should see:

```text
[worker] Teams notify: ON (events: done,fail,alarm)
```

If you see `off — see docs/teams-notify.md`, `TEAMS_WEBHOOK_URL` is empty in that shell.

---

## Step 4 — Send a small test task

From a Cursor session on the **same** mailbox, ask the agent to run MCP tools, for example:

- `bus_send(to="wkr-01", from="hub", subject="teams smoke test", text="Reply with exactly: OK")`

Wait until the worker finishes. You should get:

1. A **bus reply** to `hub` with the agent output.
2. An **Adaptive Card** in the Teams channel (✅ finished, with From / Subject / Duration and a short result preview).

To test **fail** notifications only (optional), send a task that makes the worker return an error marker — or set `TEAMS_NOTIFY_EVENTS=fail` and trigger a known failure. Most users leave the default `done,fail,alarm`.

---

## Environment variables

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `TEAMS_WEBHOOK_URL` | Yes, to enable | (empty) | Full POST URL from the Teams workflow. |
| `TEAMS_NOTIFY_EVENTS` | No | `done,fail,alarm` | Comma-separated subset: `done`, `fail`, `alarm`. |

- **`done`** — worker replied successfully after a task.
- **`fail`** — worker output looks like a worker error (e.g. `[worker: ...]`).
- **`alarm`** — runaway/loop guard fired (same moment as the bus alert to `WORKER_ALERT_TO`).

Notifications are **best-effort**: if Teams is down or the URL is wrong, the worker still processes tasks; errors are logged to stderr only.

---

## Mobile push (optional)

Teams mobile will notify you if:

1. The channel notification setting is **All activity** (or similar, not “mentions only”).
2. Teams mobile → **Settings** → notifications → something like **When active on other devices** → **Always** (wording varies by app version).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|----------------|-----|
| Startup says `Teams notify: off` | URL not exported in **this** terminal | `echo $TEAMS_WEBHOOK_URL` — set and restart worker. |
| `Teams notify failed: HTTP 401/403` | URL rotated, wrong workflow, or revoked `sig=` | Create a new workflow URL; update env; never commit old URL. |
| Error about **ChatThread** / not a chat | Private channel or “post to chat” workflow | Use a **Standard** channel + “post to channel” workflow. |
| Card never appears, HTTP 200 | Wrong channel selected in wizard | Edit workflow destination or recreate. |
| Too many cards | Every task notifies | Set `TEAMS_NOTIFY_EVENTS=fail,alarm` or use `ALLOWED_SENDERS` to reduce traffic. |
| MCP session expected Teams | Only **worker** notifies | Interactive Cursor sessions do not send Teams cards. |

Worker stderr lines starting with `[worker] Teams notify failed:` include a short HTTP body snippet — use that in Teams admin / workflow run history if needed.

---

## Security notes

- Anyone with the webhook URL can post to your channel — rotate it if leaked.
- The card includes up to **800 characters** of task **result** text; avoid sending secrets in bus task bodies if the channel is broad.
- Pair with **`ALLOWED_SENDERS`** so only your hub session can task the worker.
