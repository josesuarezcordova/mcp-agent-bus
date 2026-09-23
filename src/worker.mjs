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
// SAFETY: runs `cursor-agent -p ... --force` (auto-approves tool calls incl.
// shell/write). Only run this for senders you trust and tasks you're OK being
// executed automatically. Ctrl-C to stop.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  resolveBusDir,
  busPaths,
  safeName,
  atomicWriteJson,
  msgId,
} from './mailbox.mjs';

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

const BUS_DIR = resolveBusDir();
const inbox = path.join(busPaths(BUS_DIR).inbox, me);
fs.mkdirSync(inbox, { recursive: true });

async function reply(to, text, subject) {
  await atomicWriteJson(path.join(busPaths(BUS_DIR).inbox, to), {
    id: msgId(),
    type: 'direct',
    to,
    from: me,
    subject: subject ? `re: ${subject}` : 'reply',
    text,
    ts: new Date().toISOString(),
  });
}

function runAgent(prompt) {
  return new Promise(resolve => {
    const cliArgs = ['-p', prompt, '--force', '--output-format', 'text'];
    if (MODEL) cliArgs.push('--model', MODEL);
    const child = spawn(AGENT_CMD, cliArgs, { cwd: REPO_DIR, env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', d => (out += d.toString()));
    child.stderr.on('data', d => (err += d.toString()));
    child.on('error', e => resolve(`[worker error spawning ${AGENT_CMD}: ${e.message}]`));
    child.on('close', code => {
      if (code === 0) resolve(out.trim() || '[worker: empty output]');
      else resolve(`[worker: ${AGENT_CMD} exited ${code}]\n${(err || out).trim()}`);
    });
  });
}

async function drainAndProcess() {
  let files;
  try {
    files = fs.readdirSync(inbox).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return;
  }
  files.sort();
  for (const f of files) {
    const full = path.join(inbox, f);
    let msg;
    try {
      const raw = fs.readFileSync(full, 'utf8');
      fs.unlinkSync(full);
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    console.error(`[worker] task from ${msg.from}: ${JSON.stringify(msg.text).slice(0, 120)}`);
    const result = await runAgent(msg.text);
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

console.error(`[worker] "${me}" ready. model=${MODEL || 'default'} cwd=${REPO_DIR}`);
console.error(`[worker] watching ${inbox}`);
await schedule(); // process anything already queued

try {
  fs.watch(inbox, () => schedule());
} catch (e) {
  console.error('[worker] fs.watch failed, polling only:', e.message);
}
setInterval(() => schedule(), 3000); // safety-net poll
