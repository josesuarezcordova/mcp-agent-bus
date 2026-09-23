// Core mailbox logic for the MCP Agent Bus.
//
// This module is deliberately free of any MCP / transport concerns so it can be
// unit-tested in isolation. It implements a maildir-style mailbox on the local
// filesystem:
//
//   <busDir>/inbox/<recipient>/<id>.json   -> direct messages
//   <busDir>/broadcast/<id>.json           -> broadcast to everyone
//   <busDir>/cursors/<session>.broadcast   -> per-session broadcast read cursor

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** Resolve the bus directory from an explicit value, env, or a sensible default. */
export function resolveBusDir(explicit) {
  return (
    explicit ||
    process.env.MCP_AGENT_BUS_DIR ||
    path.join(os.homedir(), '.cursor', 'mcp-agent-bus')
  );
}

/** Compute the standard sub-directory paths for a given bus directory. */
export function busPaths(busDir) {
  return {
    root: busDir,
    inbox: path.join(busDir, 'inbox'),
    broadcast: path.join(busDir, 'broadcast'),
    cursors: path.join(busDir, 'cursors'),
  };
}

/** Restrict session/recipient names to a filesystem-safe charset. */
export function safeName(name) {
  const cleaned = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-');
  if (!cleaned) throw new Error('Invalid session name');
  return cleaned;
}

/** Generate a time-prefixed, collision-resistant id (also used as filename). */
export function msgId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/** Write JSON atomically (tmp file + rename) so readers never see a partial file. */
export async function atomicWriteJson(dir, obj) {
  await ensureDir(dir);
  const id = obj.id && typeof obj.id === 'string' ? obj.id : msgId();
  const finalPath = path.join(dir, `${id}.json`);
  const tmpPath = path.join(dir, `.${id}.json.tmp`);
  await fsp.writeFile(tmpPath, JSON.stringify(obj), 'utf8');
  await fsp.rename(tmpPath, finalPath);
  return id;
}

/** Read (and optionally consume) all messages waiting in a recipient's inbox. */
export async function drainInbox(busDir, recipient, { consume = true } = {}) {
  const dir = path.join(busPaths(busDir).inbox, recipient);
  await ensureDir(dir);
  let files;
  try {
    files = (await fsp.readdir(dir)).filter(
      f => f.endsWith('.json') && !f.startsWith('.')
    );
  } catch {
    return [];
  }
  files.sort(); // ids are time-prefixed, so this is chronological
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const raw = await fsp.readFile(full, 'utf8');
      out.push(JSON.parse(raw));
      if (consume) await fsp.unlink(full).catch(() => {});
    } catch {
      // partially-written or already-consumed; skip
    }
  }
  return out;
}

/**
 * Block until at least one message file appears in `dir` (or `timeoutMs`
 * elapses). Uses fs.watch for event-driven wakeups with a slow poll as a
 * dropped-event safety net. Resolves 'message' or 'timeout'.
 */
export function waitForMessage(dir, timeoutMs, { pollMs = 1000 } = {}) {
  return new Promise(resolve => {
    let done = false;
    let watcher = null;
    let poll = null;
    let timer = null;

    const cleanup = () => {
      if (done) return;
      done = true;
      if (watcher) watcher.close();
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
    };

    const hasMsg = () => {
      try {
        return fs
          .readdirSync(dir)
          .some(f => f.endsWith('.json') && !f.startsWith('.'));
      } catch {
        return false;
      }
    };

    const finish = result => {
      cleanup();
      resolve(result);
    };

    if (hasMsg()) return finish('message');

    try {
      watcher = fs.watch(dir, () => {
        if (hasMsg()) finish('message');
      });
    } catch {
      // fall back to polling only
    }
    poll = setInterval(() => {
      if (hasMsg()) finish('message');
    }, pollMs);
    timer = setTimeout(() => finish('timeout'), timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// High-level operations (used by the MCP server and the worker)
// ---------------------------------------------------------------------------

/** Send a direct message into a recipient's inbox. Returns the stored message. */
export async function sendDirect(busDir, { to, from, text, subject = null }) {
  const recipient = safeName(to);
  const msg = {
    id: msgId(),
    type: 'direct',
    to: recipient,
    from: safeName(from),
    subject: subject ?? null,
    text: String(text ?? ''),
    ts: new Date().toISOString(),
  };
  await atomicWriteJson(path.join(busPaths(busDir).inbox, recipient), msg);
  return msg;
}

/**
 * Fetch and consume a session's messages. If none are waiting and `block` is
 * true, waits (event-driven) up to `timeoutMs` for one to arrive.
 */
export async function receive(busDir, me, { block = true, timeoutMs = 60000 } = {}) {
  const recipient = safeName(me);
  let msgs = await drainInbox(busDir, recipient);
  if (msgs.length === 0 && block) {
    await waitForMessage(path.join(busPaths(busDir).inbox, recipient), timeoutMs);
    msgs = await drainInbox(busDir, recipient);
  }
  return msgs;
}

/** Return a session's messages WITHOUT consuming them. */
export async function peek(busDir, me) {
  return drainInbox(busDir, safeName(me), { consume: false });
}

/** Post a broadcast visible to every session. Returns the stored message. */
export async function broadcast(busDir, { from, text }) {
  const msg = {
    id: msgId(),
    type: 'broadcast',
    from: safeName(from),
    text: String(text ?? ''),
    ts: new Date().toISOString(),
  };
  await atomicWriteJson(busPaths(busDir).broadcast, msg);
  return msg;
}

/** Return broadcasts newer than the caller's last read, then advance the cursor. */
export async function readBroadcasts(busDir, me) {
  const session = safeName(me);
  const { broadcast: broadcastDir, cursors } = busPaths(busDir);
  await ensureDir(broadcastDir);
  await ensureDir(cursors);
  const cursorPath = path.join(cursors, `${session}.broadcast`);
  let since = '';
  try {
    since = (await fsp.readFile(cursorPath, 'utf8')).trim();
  } catch {
    // no cursor yet; read everything
  }
  let files = [];
  try {
    files = (await fsp.readdir(broadcastDir)).filter(
      f => f.endsWith('.json') && !f.startsWith('.')
    );
  } catch {
    return [];
  }
  files.sort();
  const fresh = files.filter(f => f > since);
  const out = [];
  for (const f of fresh) {
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(broadcastDir, f), 'utf8')));
    } catch {
      // skip unreadable
    }
  }
  if (fresh.length) {
    await fsp.writeFile(cursorPath, fresh[fresh.length - 1], 'utf8');
  }
  return out;
}

/** List session names that currently have an inbox directory. */
export async function listSessions(busDir) {
  const { inbox } = busPaths(busDir);
  await ensureDir(inbox);
  try {
    const entries = await fsp.readdir(inbox, { withFileTypes: true });
    return entries.filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return [];
  }
}
