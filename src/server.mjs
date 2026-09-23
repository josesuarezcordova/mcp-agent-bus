#!/usr/bin/env node
// MCP Agent Bus — a local, event-driven MCP message bus for coordinating multiple
// AI coding-agent sessions on the same machine.
//
// Transport: stdio. Each agent session spawns its own copy of this process, but
// all copies share state through the filesystem mailbox dir, so sessions can
// talk to each other. All message logic lives in ./mailbox.mjs.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  resolveBusDir,
  busPaths,
  ensureDir,
  sendDirect,
  receive,
  peek,
  broadcast,
  readBroadcasts,
  listSessions,
} from './mailbox.mjs';

const BUS_DIR = resolveBusDir();

const server = new McpServer({ name: 'mcp-agent-bus', version: '1.0.0' });

const asJson = value => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});
const asText = text => ({ content: [{ type: 'text', text }] });

server.registerTool(
  'bus_send',
  {
    title: 'Send a direct message to another session',
    description:
      'Send a message to a specific session inbox. The recipient sees it on their next bus_receive. Use for handoffs and requests between agent sessions.',
    inputSchema: {
      to: z.string().describe('Recipient session name, e.g. "backend"'),
      from: z.string().describe('Your own session name, e.g. "frontend"'),
      text: z.string().describe('Message body'),
      subject: z.string().optional().describe('Optional short subject'),
    },
  },
  async ({ to, from, text, subject }) => {
    const msg = await sendDirect(BUS_DIR, { to, from, text, subject });
    return asText(`sent to ${msg.to} (id ${msg.id})`);
  }
);

server.registerTool(
  'bus_receive',
  {
    title: 'Receive messages (blocks until one arrives or timeout)',
    description:
      'Fetch and CONSUME pending messages for your session. If none are waiting and block=true, this blocks (event-driven) until a message arrives or timeout_ms elapses. Returns a JSON array of messages (may be empty on timeout).',
    inputSchema: {
      me: z.string().describe('Your own session name, e.g. "backend"'),
      block: z.boolean().optional().describe('Block until a message arrives (default true)'),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(600000)
        .optional()
        .describe('Max time to block in ms (default 60000, max 600000)'),
    },
  },
  async ({ me, block = true, timeout_ms = 60000 }) => {
    const msgs = await receive(BUS_DIR, me, { block, timeoutMs: timeout_ms });
    return asJson(msgs);
  }
);

server.registerTool(
  'bus_peek',
  {
    title: 'Peek inbox without consuming',
    description: 'Return pending messages for your session WITHOUT removing them.',
    inputSchema: { me: z.string().describe('Your own session name') },
  },
  async ({ me }) => asJson(await peek(BUS_DIR, me))
);

server.registerTool(
  'bus_broadcast',
  {
    title: 'Broadcast a message to all sessions',
    description:
      'Post a message visible to every session via bus_read_broadcasts. Use for global announcements (e.g. "deploying now", "main is frozen").',
    inputSchema: {
      from: z.string().describe('Your own session name'),
      text: z.string().describe('Message body'),
    },
  },
  async ({ from, text }) => {
    const msg = await broadcast(BUS_DIR, { from, text });
    return asText(`broadcast posted (id ${msg.id})`);
  }
);

server.registerTool(
  'bus_read_broadcasts',
  {
    title: 'Read new broadcasts since you last checked',
    description:
      'Return broadcasts newer than your last read, then advance your read cursor. Non-consuming for other sessions.',
    inputSchema: { me: z.string().describe('Your own session name') },
  },
  async ({ me }) => asJson(await readBroadcasts(BUS_DIR, me))
);

server.registerTool(
  'bus_list_sessions',
  {
    title: 'List sessions that have an inbox',
    description: 'List known session names (those with an inbox directory).',
    inputSchema: {},
  },
  async () => asJson(await listSessions(BUS_DIR))
);

async function main() {
  const { inbox, broadcast: broadcastDir, cursors } = busPaths(BUS_DIR);
  await ensureDir(inbox);
  await ensureDir(broadcastDir);
  await ensureDir(cursors);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('mcp-agent-bus failed to start:', err);
  process.exit(1);
});
