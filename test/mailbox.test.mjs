import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  safeName,
  msgId,
  busPaths,
  resolveBusDir,
  sendDirect,
  receive,
  peek,
  broadcast,
  readBroadcasts,
  listSessions,
  atomicWriteJson,
  waitForMessage,
} from '../src/mailbox.mjs';

/** Create a fresh throwaway bus directory for each test. */
async function tmpBus() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-agent-bus-test-'));
  return dir;
}

test('safeName normalises to a filesystem-safe handle', () => {
  assert.equal(safeName('  MyName '), 'myname');
  assert.equal(safeName('Web App!'), 'web-app-');
  assert.equal(safeName('a/b\\c'), 'a-b-c');
});

test('safeName rejects empty/invalid names', () => {
  assert.throws(() => safeName(''));
  assert.throws(() => safeName('   '));
  assert.throws(() => safeName(null));
});

test('msgId is time-prefixed and unique', () => {
  const a = msgId();
  const b = msgId();
  assert.notEqual(a, b);
  assert.match(a, /^\d+-[0-9a-f]{8}$/);
});

test('busPaths derives the expected subdirectories', () => {
  const p = busPaths('/tmp/bus');
  assert.equal(p.inbox, path.join('/tmp/bus', 'inbox'));
  assert.equal(p.broadcast, path.join('/tmp/bus', 'broadcast'));
  assert.equal(p.cursors, path.join('/tmp/bus', 'cursors'));
});

test('resolveBusDir prefers explicit value, then env, then default', () => {
  assert.equal(resolveBusDir('/explicit'), '/explicit');
  const prev = process.env.MCP_AGENT_BUS_DIR;
  process.env.MCP_AGENT_BUS_DIR = '/from-env';
  assert.equal(resolveBusDir(), '/from-env');
  delete process.env.MCP_AGENT_BUS_DIR;
  assert.ok(resolveBusDir().includes('.cursor'));
  if (prev !== undefined) process.env.MCP_AGENT_BUS_DIR = prev;
});

test('send then receive delivers and consumes the message', async () => {
  const bus = await tmpBus();
  const sent = await sendDirect(bus, {
    to: 'backend',
    from: 'frontend',
    text: 'run the tests',
    subject: 'handoff',
  });
  assert.equal(sent.to, 'backend');
  assert.equal(sent.from, 'frontend');
  assert.equal(sent.type, 'direct');

  const got = await receive(bus, 'backend', { block: false });
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'run the tests');
  assert.equal(got[0].subject, 'handoff');

  // consumed: a second receive is empty
  const again = await receive(bus, 'backend', { block: false });
  assert.equal(again.length, 0);
});

test('peek returns messages without consuming them', async () => {
  const bus = await tmpBus();
  await sendDirect(bus, { to: 'backend', from: 'frontend', text: 'hi' });
  const peeked = await peek(bus, 'backend');
  assert.equal(peeked.length, 1);
  const peekedAgain = await peek(bus, 'backend');
  assert.equal(peekedAgain.length, 1, 'peek must not consume');
});

test('messages are returned in chronological order', async () => {
  const bus = await tmpBus();
  await sendDirect(bus, { to: 'backend', from: 'a', text: 'first' });
  await new Promise(r => setTimeout(r, 5));
  await sendDirect(bus, { to: 'backend', from: 'b', text: 'second' });
  const got = await receive(bus, 'backend', { block: false });
  assert.deepEqual(got.map(m => m.text), ['first', 'second']);
});

test('recipient name is sanitised on send and receive', async () => {
  const bus = await tmpBus();
  await sendDirect(bus, { to: 'Back End', from: 'x', text: 'y' });
  const got = await receive(bus, 'back-end', { block: false });
  assert.equal(got.length, 1);
});

test('broadcast is read once per session via a moving cursor', async () => {
  const bus = await tmpBus();
  await broadcast(bus, { from: 'ops', text: 'deploying now' });

  const first = await readBroadcasts(bus, 'backend');
  assert.equal(first.length, 1);
  assert.equal(first[0].text, 'deploying now');

  // same session does not see it again
  const second = await readBroadcasts(bus, 'backend');
  assert.equal(second.length, 0);

  // a different session still sees it
  const other = await readBroadcasts(bus, 'frontend');
  assert.equal(other.length, 1);
});

test('listSessions reports sessions that have an inbox', async () => {
  const bus = await tmpBus();
  await sendDirect(bus, { to: 'backend', from: 'frontend', text: 'x' });
  await sendDirect(bus, { to: 'qa', from: 'frontend', text: 'y' });
  const sessions = (await listSessions(bus)).sort();
  assert.deepEqual(sessions, ['backend', 'qa']);
});

test('atomicWriteJson does not leave partial/temp files behind', async () => {
  const bus = await tmpBus();
  const dir = path.join(busPaths(bus).inbox, 'backend');
  await atomicWriteJson(dir, { id: 'fixed-id', text: 'hello' });
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['fixed-id.json']);
});

test('waitForMessage resolves "message" when one arrives', async () => {
  const bus = await tmpBus();
  const dir = path.join(busPaths(bus).inbox, 'backend');
  await fsp.mkdir(dir, { recursive: true });
  const waiting = waitForMessage(dir, 2000, { pollMs: 50 });
  setTimeout(() => {
    sendDirect(bus, { to: 'backend', from: 'x', text: 'ping' });
  }, 100);
  assert.equal(await waiting, 'message');
});

test('waitForMessage resolves "timeout" when nothing arrives', async () => {
  const bus = await tmpBus();
  const dir = path.join(busPaths(bus).inbox, 'idle');
  await fsp.mkdir(dir, { recursive: true });
  assert.equal(await waitForMessage(dir, 150, { pollMs: 50 }), 'timeout');
});

test('receive with block resolves after a delayed send', async () => {
  const bus = await tmpBus();
  const pending = receive(bus, 'backend', { block: true, timeoutMs: 2000 });
  setTimeout(() => {
    sendDirect(bus, { to: 'backend', from: 'frontend', text: 'delayed' });
  }, 100);
  const got = await pending;
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'delayed');
});
