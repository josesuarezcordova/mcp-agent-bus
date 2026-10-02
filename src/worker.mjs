#!/usr/bin/env node
// Autonomous headless bus worker.
//
// Usage: node src/worker.mjs <session-name> [--model <model>]
//   e.g. MCP_AGENT_BUS_DIR=/path node src/worker.mjs backend --model <your-model>
//
// Blocks on the session inbox (event-driven via fs.watch). For each incoming
// message it runs the message text as a task using `cursor-agent -p` (headless,
// non-interactive), captures the output, and replies to the sender via the bus.
//
// This works hands-free because each task is executed by a fresh headless agent
// process — it does NOT depend on waking an idle interactive session.
//
// SAFETY controls (env vars):
//   ALLOWED_SENDERS   comma-separated list of sender names allowed to task this
//                     worker. If set, messages from anyone else are ignored.
//                     If unset, all senders are accepted (a warning is logged).
//   WORKER_MAX_RE_DEPTH  max `re:` depth on a subject before the worker refuses
//                        (loop guard). Default 6.
//   WORKER_FORCE      "1" (default) runs cursor-agent with --force (auto-approve
//                     tool calls). Set "0" to drop --force (safer, but tasks that
//                     need tools may stall waiting for approval).
//   WORKER_STREAM     "1" (default) streams the agent's live output into this
//                     pane while a task runs, plus an elapsed-time heartbeat.
//                     Set "0" for quiet mode (only task-start/replied lines).
// Every task is also prefixed with a hard safety policy (no external side
// effects / GUI automation unless the task explicitly authorises it).
// Ctrl-C to stop.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { resolveBusDir, busPaths, safeName } from './mailbox.mjs';

const args = process.argv.slice(2);
let me;
try {
  me = safeName(args[0]);
} catch {
  console.error('Usage: node src/worker.mjs <session-name> [--model <model>]');
  process.exit(1);
}
const modelIdx = args.indexOf('--model');
const MODEL = modelIdx >= 0 ? args[modelIdx + 1] : null;
const REPO_DIR = process.env.WORKER_CWD || process.cwd();
const AGENT_CMD = process.env.AGENT_CMD || 'cursor-agent';

const BUS_DIR = resolveBusDir(process.env.MCP_AGENT_BUS_DIR || process.env.AGENT_BUS_DIR);
const inbox = path.join(busPaths(BUS_DIR).inbox, me);
fs.mkdirSync(inbox, { recursive: true });

// Per-task metrics for docs/watch-usage.sh and docs/watch-clarity.sh
const RUN_DIR =
  process.env.MCP_AGENT_BUS_RUN_DIR ||
  process.env.AGENT_BUS_RUN_DIR ||
  path.join(BUS_DIR, 'run');
const usageFile = path.join(RUN_DIR, `${me}.usage.jsonl`);
function recordUsage(rec) {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.appendFileSync(usageFile, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    console.error(`[worker] could not record usage: ${e.message}`);
  }
}

// Sibling record carrying the raw (prompt, reply) text per task, so the offline
// prompt-clarity judge (docs/prompt-clarity.mjs) has material to score. Kept in a
// separate file from usage.jsonl so the token/clarity dashboard stays small and
// the (potentially large) text lives on its own. Local-only.
const tasksFile = path.join(RUN_DIR, `${me}.tasks.jsonl`);
function recordTask(rec) {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.appendFileSync(tasksFile, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    console.error(`[worker] could not record task text: ${e.message}`);
  }
}

// Pull a ticket id (e.g. DIG-458) out of a subject/text for grouping in reports.
function parseTicket(subject, text) {
  const m = `${subject || ''} ${text || ''}`.match(/[A-Z]{2,}-\d+/);
  return m ? m[0] : null;
}

// Hedging / confusion / assumption phrases. A headless worker CANNOT ask the
// sender to clarify — so when a prompt is ambiguous it hedges in the reply text
// ("it's unclear what you want", "I'll assume…"). Counting these is a strong,
// direct signal that the PROMPT was not clear. Scanned case-insensitively.
const AMBIGUITY_PHRASES = [
  // explicit uncertainty
  'unclear', 'not clear', 'ambiguous', 'ambiguity', 'underspecified',
  'vague', "i'm not sure", 'not sure what you mean',
  // assumptions (agent had to guess intent)
  "i'll assume", 'i will assume', 'assuming', 'assumption',
  // asking for clarification (agent can't proceed as-is)
  'could you clarify', 'please clarify', 'what do you mean', 'what would you like',
  'please provide', 'please send', 'provide more', 'send back specifics',
  'more specifics', 'more detail', 'more context', 'more information',
  'can you send', 'let me know',
  // "cannot act / missing info" hedges
  "can't act", 'cannot act', "doesn't say", 'does not say', "didn't specify",
  'did not specify', 'not specified', 'nothing concrete', 'nothing to fix',
  'no context', 'no ticket', 'not referenced', "couldn't find", 'could not find',
  "don't have enough", 'need more', 'cannot determine', "can't determine",
  'which file', 'which one', "what's wrong", 'what is broken',
];

// --- safety controls ---
const ALLOWED = (process.env.ALLOWED_SENDERS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const MAX_RE_DEPTH = parseInt(process.env.WORKER_MAX_RE_DEPTH || '6', 10);
const FORCE = process.env.WORKER_FORCE !== '0';
const STREAM = process.env.WORKER_STREAM !== '0';

// --- loop / runaway detection ---
// cursor-agent's stream-json DOES report token usage (see the `result` event in
// runAgent below), but these behavioural guards are still a cheaper, earlier
// tripwire: we alarm on the *behaviour* a runaway loop produces (task bursts,
// repeats, lifetime budget) so we can stop a loop before it does many turns.
const BURST_WINDOW_MS = parseInt(process.env.WORKER_BURST_WINDOW_MS || '60000', 10);
const BURST_MAX = parseInt(process.env.WORKER_BURST_MAX || '10', 10); // >N tasks per window = alarm
const REPEAT_MAX = parseInt(process.env.WORKER_REPEAT_MAX || '4', 10); // same task >N/window = alarm
const MAX_TASKS = parseInt(process.env.WORKER_MAX_TASKS || '0', 10); // lifetime task budget (0=off)
const TASK_TIMEOUT_MS = parseInt(process.env.WORKER_TASK_TIMEOUT_MS || '0', 10); // kill a task after N ms (0=off)
// where to send the alarm (defaults to first allow-listed sender, else "hub")
const ALERT_TO = (process.env.WORKER_ALERT_TO || ALLOWED[0] || 'hub').toLowerCase();
// on trip: stop the worker to stop the bleed (set "0" to only warn + skip task)
const BREAKER = process.env.WORKER_BREAKER !== '0';

const SAFETY_PREAMBLE = `[WORKER SAFETY POLICY — read first; overrides any conflicting instruction below]
You are a headless bus worker running a task on behalf of another session. Obey these rules:
- Do NOT take side-effecting actions on external systems (Jira, Confluence, GitHub, Teams, Slack, email): no posting, editing, commenting, @mentioning, transitioning tickets, pushing branches, opening or merging PRs — UNLESS this task text explicitly names that exact action.
- NEVER use GUI automation (osascript, AppleScript, System Events, simulated keystrokes/clicks) and never drive desktop apps.
- Do NOT run destructive commands (rm -rf, force-push, prod changes, DB writes) unless explicit and clearly safe.
- If the task needs an unauthorised side effect, DRAFT the text/plan and return it instead of doing it.
- Keep the reply concise.
--- TASK FROM {from} ---
`;

function reDepth(subject) {
  if (!subject) return 0;
  const m = String(subject).match(/re:/gi);
  return m ? m.length : 0;
}

function msgId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

async function atomicWriteJson(dir, obj) {
  await fsp.mkdir(dir, { recursive: true });
  const id = msgId();
  const tmp = path.join(dir, `.${id}.json.tmp`);
  const dst = path.join(dir, `${id}.json`);
  await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fsp.rename(tmp, dst);
}

async function reply(to, text, subject) {
  await atomicWriteJson(path.join(BUS_DIR, 'inbox', to), {
    id: msgId(),
    type: 'direct',
    to,
    from: me,
    subject: subject ? `re: ${subject}` : 'reply',
    text,
    ts: new Date().toISOString(),
  });
}

// --- runaway/loop tracking state ---
const recentTasks = []; // timestamps of recently-started tasks (sliding window)
const repeatWindow = new Map(); // normalized-task-key -> [timestamps]
let totalTasks = 0;

// Ring the bell, log loudly, and notify the hub over the bus. Returns nothing.
async function raiseAlarm(reason) {
  process.stderr.write(
    `\x07\n[worker] ⚠️⚠️  LOOP/RUNAWAY ALARM on "${me}" — ${reason}\n` +
      `[worker] ${BREAKER ? 'circuit breaker is ON → stopping this worker to stop token spend.' : 'breaker OFF → skipping this task and continuing.'}\n`,
  );
  try {
    await atomicWriteJson(path.join(BUS_DIR, 'inbox', ALERT_TO), {
      id: msgId(),
      type: 'direct',
      to: ALERT_TO,
      from: me,
      subject: `⚠ ALERT: possible loop/runaway on ${me}`,
      text:
        `Worker "${me}" tripped a runaway/loop guard: ${reason}.\n` +
        (BREAKER
          ? 'The worker has STOPPED itself to stop burning tokens. Investigate the sender/loop, then restart it manually.'
          : 'The worker skipped the offending task and is still running (breaker off).'),
      ts: new Date().toISOString(),
    });
  } catch {}
}

// Returns a trip-reason string if this task looks like a runaway/loop, else null.
function detectRunaway(msg, from) {
  const now = Date.now();
  // sliding burst window
  while (recentTasks.length && now - recentTasks[0] > BURST_WINDOW_MS) recentTasks.shift();
  recentTasks.push(now);
  // repeat detection (same sender + normalized subject + text prefix)
  const key = `${from}|${String(msg.subject || '')
    .toLowerCase()
    .replace(/^(re:\s*)+/, '')}|${String(msg.text || '').slice(0, 200)}`;
  const arr = (repeatWindow.get(key) || []).filter(t => now - t <= BURST_WINDOW_MS);
  arr.push(now);
  repeatWindow.set(key, arr);

  const secs = Math.round(BURST_WINDOW_MS / 1000);
  if (recentTasks.length > BURST_MAX)
    return `burst of ${recentTasks.length} tasks in ${secs}s (max ${BURST_MAX})`;
  if (arr.length > REPEAT_MAX)
    return `same task repeated ${arr.length}× in ${secs}s (max ${REPEAT_MAX})`;
  if (MAX_TASKS && totalTasks >= MAX_TASKS)
    return `lifetime task budget reached (${totalTasks}/${MAX_TASKS})`;
  return null;
}

// Pull the text out of an assistant/stream-json event, tolerating a few shapes.
function eventText(ev) {
  try {
    const c = ev?.message?.content;
    if (Array.isArray(c)) return c.filter(x => x && x.type === 'text').map(x => x.text || '').join('');
    if (typeof ev?.text === 'string') return ev.text;
    if (typeof ev?.delta === 'string') return ev.delta;
  } catch {}
  return '';
}

function runAgent(prompt, meta) {
  meta = meta || {};
  const from = meta.from;
  return new Promise(resolve => {
    // stream-json gives us BOTH live text events AND a final `result` event that
    // carries token usage — text mode threw the usage away. --stream-partial-output
    // makes the live text arrive as smooth deltas (only valid with stream-json).
    const cliArgs = ['-p', prompt, '--output-format', 'stream-json'];
    if (STREAM) cliArgs.push('--stream-partial-output');
    if (FORCE) cliArgs.push('--force');
    if (MODEL) cliArgs.push('--model', MODEL);
    const child = spawn(AGENT_CMD, cliArgs, {
      cwd: REPO_DIR,
      env: process.env,
    });
    let buf = '';        // partial NDJSON line buffer
    let assistantText = ''; // best-effort reconstruction of the reply
    let resultText = null;  // authoritative reply from the final `result` event
    let usage = null;       // token usage from the final `result` event
    let err = '';
    let done = false;
    // --- prompt-clarity signals gathered from the stream-json event stream ---
    let toolCalls = 0;              // total tool_call(started) events
    const toolCounts = {};          // histogram: { read: 3, grep: 1, ... }
    let explorationToolCalls = 0;   // context-gathering tools before 1st output
    let turns = 0;                  // number of assistant text bursts (steps)
    let inAssistantBurst = false;   // are we mid-assistant-text run?
    let ttftMs = null;              // time-to-first-token (first assistant text)
    let sawSubstantiveAction = false; // a non-exploration tool call happened
    let resolvedModel = null;       // model the CLI actually used (system/init)
    let agentSessionId = null;      // cursor-agent session id (cross-ref)
    let resultIsError = false;      // result event flagged is_error
    let apiDurationMs = null;       // result.duration_api_ms
    const started = Date.now();
    let hb = null;
    let killTimer = null;
    if (STREAM) {
      process.stderr.write(`\n[worker] ┌─ task started (from ${from || 'unknown'}) — live output ─────\n`);
      hb = setInterval(() => {
        process.stderr.write(`[worker] · …still working (${Math.round((Date.now() - started) / 1000)}s)\n`);
      }, 15000);
    }
    if (TASK_TIMEOUT_MS > 0) {
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        finish(`[worker: task exceeded ${Math.round(TASK_TIMEOUT_MS / 1000)}s timeout and was killed]`, 'timeout');
      }, TASK_TIMEOUT_MS);
    }
    const handleEvent = ev => {
      const type = ev?.type;
      if (type === 'system') {
        // First event of the stream (subtype "init") reports the resolved model
        // and cursor-agent session id.
        if (typeof ev.model === 'string') resolvedModel = ev.model;
        if (typeof ev.session_id === 'string') agentSessionId = ev.session_id;
        inAssistantBurst = false;
      } else if (type === 'tool_call') {
        // A tool round-trip breaks any current assistant text burst.
        inAssistantBurst = false;
        // Count each invocation once (the stream emits started + completed).
        if (ev.subtype === 'started') {
          toolCalls++;
          const tc = ev.tool_call || {};
          const key = Object.keys(tc).find(k => /ToolCall$/.test(k)) || '';
          const name = (key.replace(/ToolCall$/, '') || ev.subtype || 'unknown').toLowerCase();
          toolCounts[name] = (toolCounts[name] || 0) + 1;
          // Exploration = context gathering (read/search/grep/list/glob/find...).
          const isExploration = /read|grep|search|list|glob|find|codebase|semantic|fetch|ls|dir/i.test(name);
          if (isExploration) {
            // Only count exploration done BEFORE the first substantive output/action
            // — that's the "hunting for missing context" phase we care about.
            if (ttftMs === null && !sawSubstantiveAction) explorationToolCalls++;
          } else {
            sawSubstantiveAction = true;
          }
        }
      } else if (type === 'assistant' || type === 'assistant_delta' || type === 'text') {
        const t = eventText(ev);
        if (!t) return;
        if (ttftMs === null) ttftMs = Date.now() - started; // first token seen
        if (!inAssistantBurst) { turns++; inAssistantBurst = true; }
        // Handle both cumulative (each event = full text so far) and delta shapes.
        if (t.startsWith(assistantText)) {
          const delta = t.slice(assistantText.length);
          if (STREAM && delta) process.stdout.write(delta);
          assistantText = t;
        } else {
          if (STREAM) process.stdout.write(t);
          assistantText += t;
        }
      } else if (type === 'result') {
        if (typeof ev.result === 'string') resultText = ev.result;
        if (ev.usage) usage = ev.usage;
        if (ev.is_error === true) resultIsError = true;
        if (typeof ev.duration_api_ms === 'number') apiDurationMs = ev.duration_api_ms;
      }
    };
    child.stdout.on('data', d => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // Not JSON (e.g. a stray log line) — echo it live so nothing is hidden.
          if (STREAM) process.stdout.write(line + '\n');
        }
      }
    });
    child.stderr.on('data', d => {
      const s = d.toString();
      err += s;
      if (STREAM) process.stderr.write(s);
    });
    const finish = (payload, outcomeHint) => {
      if (done) return;
      done = true;
      if (hb) clearInterval(hb);
      if (killTimer) clearTimeout(killTimer);
      const u = usage || {};
      const replyText = (resultText != null ? resultText : assistantText).trim();

      // --- prompt-clarity: scan the reply for hedging/confusion phrases ---
      const scanText = `${assistantText}\n${resultText || ''}`.toLowerCase();
      const matched = [];
      for (const p of AMBIGUITY_PHRASES) if (scanText.includes(p)) matched.push(p);
      const ambiguityFlags = { count: matched.length, matched };

      // Outcome from the completion path, upgraded by the result event / emptiness.
      let outcome = outcomeHint || 'success';
      if (resultIsError && outcome === 'success') outcome = 'error';
      if (outcome === 'success' && !replyText) outcome = 'empty';

      // Interpretation-overhead proxy. NOTE: this cursor-agent version does NOT
      // expose reasoning/thinking tokens or events in the stream (verified), so
      // we approximate "effort spent figuring out intent" as pre-output hunting
      // + hedging, normalised per assistant turn. Higher = worked harder to
      // interpret the ask relative to what it produced. The offline LLM judge
      // (docs/prompt-clarity.mjs) is the authoritative clarity measure; this is a
      // cheap automatic supporting signal.
      const interpretationOverhead = +(
        (explorationToolCalls + matched.length) / Math.max(1, turns)
      ).toFixed(3);

      const rec = {
        ts: new Date().toISOString(),
        name: me,
        from: (from || 'unknown').toLowerCase(),
        model: MODEL || 'default',
        resolvedModel: resolvedModel || null,
        ticket: meta.ticket || null,
        durationMs: Date.now() - started,
        apiDurationMs,
        // token fields (kept as-is; deliberately NOT turned into any $ cost)
        inputTokens: u.inputTokens || 0,
        outputTokens: u.outputTokens || 0,
        cacheReadTokens: u.cacheReadTokens || 0,
        cacheWriteTokens: u.cacheWriteTokens || 0,
        hadUsage: !!usage,
        // --- prompt-clarity signals ---
        outcome,
        turns,
        ttftMs,
        toolCalls,
        explorationToolCalls,
        tools: toolCounts,
        ambiguityFlags,
        interpretationOverhead,
        promptChars: (meta.promptText || '').length,
        replyChars: replyText.length,
      };
      recordUsage(rec);
      // Sibling record with the raw text so the offline judge has material.
      recordTask({
        ts: rec.ts,
        name: me,
        from: rec.from,
        subject: meta.subject || null,
        ticket: rec.ticket,
        agentSessionId,
        promptText: meta.promptText || '',
        replyText,
      });
      if (STREAM) {
        const u2 = usage
          ? ` | tokens in:${usage.inputTokens || 0} out:${usage.outputTokens || 0} cacheR:${usage.cacheReadTokens || 0} cacheW:${usage.cacheWriteTokens || 0}`
          : '';
        const c2 = ` | clarity outcome:${outcome} turns:${turns} ttft:${ttftMs ?? '-'}ms tools:${toolCalls}(explore:${explorationToolCalls}) hedges:${ambiguityFlags.count} interp:${interpretationOverhead}`;
        process.stderr.write(`\n[worker] └─ task finished (${Math.round((Date.now() - started) / 1000)}s)${u2}${c2} ─────\n`);
      }
      resolve(payload);
    };
    child.on('error', e => finish(`[worker error spawning ${AGENT_CMD}: ${e.message}]`, 'error'));
    child.on('close', code => {
      // Flush any trailing partial line.
      const tail = buf.trim();
      if (tail) {
        try {
          handleEvent(JSON.parse(tail));
        } catch {}
      }
      const reply = (resultText != null ? resultText : assistantText).trim();
      if (code === 0) finish(reply || '[worker: empty output]');
      else finish(`[worker: ${AGENT_CMD} exited ${code}]\n${(err || reply).trim()}`, 'error');
    });
  });
}

async function drainAndProcess() {
  let files;
  try {
    files = (await fsp.readdir(inbox)).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return;
  }
  files.sort();
  for (const f of files) {
    const full = path.join(inbox, f);
    let msg;
    try {
      const raw = await fsp.readFile(full, 'utf8');
      await fsp.unlink(full).catch(() => {});
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    const from = String(msg.from || '').toLowerCase();

    // sender allow-list
    if (ALLOWED.length && !ALLOWED.includes(from)) {
      console.error(`[worker] IGNORED task from "${msg.from}" — not in ALLOWED_SENDERS (${ALLOWED.join(', ')})`);
      continue;
    }

    // loop guard: refuse deeply-nested re: threads to stop agent<->agent ping-pong
    const depth = reDepth(msg.subject);
    if (depth >= MAX_RE_DEPTH) {
      console.error(`[worker] STOP loop: subject re-depth ${depth} >= ${MAX_RE_DEPTH}; refusing "${msg.from}"`);
      await reply(
        msg.from,
        `[worker] Stopping to avoid a loop (re: depth ${depth} ≥ ${MAX_RE_DEPTH}). If this is still needed, resend as a fresh task with a new subject.`,
        null,
      );
      continue;
    }

    // runaway/loop guard: alarm (and optionally stop) before spending on this task
    const trip = detectRunaway(msg, from);
    if (trip) {
      await raiseAlarm(trip);
      if (BREAKER) {
        console.error('[worker] circuit breaker OPEN — exiting to stop token spend.');
        process.exit(1);
      }
      continue; // breaker off: skip the offending task, keep running
    }
    totalTasks++;

    console.error(`[worker] task from ${msg.from}: ${JSON.stringify(msg.text).slice(0, 120)}`);
    const prompt = SAFETY_PREAMBLE.replace('{from}', msg.from || 'unknown') + String(msg.text || '');
    const meta = {
      from: msg.from,
      promptText: String(msg.text || ''), // original ask, WITHOUT the safety preamble
      subject: msg.subject || null,
      ticket: parseTicket(msg.subject, msg.text),
    };
    const result = await runAgent(prompt, meta);
    await reply(msg.from, result, msg.subject);
    console.error(`[worker] replied to ${msg.from} (${result.length} chars)`);
  }
}

let busy = false;
let pending = false;
async function schedule() {
  if (busy) {
    pending = true;
    return;
  }
  busy = true;
  do {
    pending = false;
    await drainAndProcess();
  } while (pending);
  busy = false;
}

console.error(`[worker] "${me}" ready. model=${MODEL || 'default'} cwd=${REPO_DIR} agent=${AGENT_CMD}`);
console.error(`[worker] metrics: ${RUN_DIR}/*.usage.jsonl (watch-usage.sh / watch-clarity.sh)`);
console.error(`[worker] safety: allowed_senders=${ALLOWED.length ? ALLOWED.join(',') : 'ALL (⚠ set ALLOWED_SENDERS to lock down)'} | force=${FORCE ? 'on' : 'off'} | max_re_depth=${MAX_RE_DEPTH} | stream=${STREAM ? 'on' : 'off'}`);
console.error(`[worker] runaway guard: burst>${BURST_MAX}/${Math.round(BURST_WINDOW_MS / 1000)}s, repeat>${REPEAT_MAX}/${Math.round(BURST_WINDOW_MS / 1000)}s, max_tasks=${MAX_TASKS || '∞'}, task_timeout=${TASK_TIMEOUT_MS ? Math.round(TASK_TIMEOUT_MS / 1000) + 's' : 'off'} | alarm→${ALERT_TO} | breaker=${BREAKER ? 'ON (stops worker)' : 'off (skip+warn)'}`);
console.error(`[worker] watching ${inbox}`);
await schedule(); // process anything already queued

try {
  fs.watch(inbox, () => schedule());
} catch (e) {
  console.error('[worker] fs.watch failed, polling only:', e.message);
}
setInterval(() => schedule(), 3000); // safety-net poll
