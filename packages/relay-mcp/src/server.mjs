#!/usr/bin/env node
/**
 * Relay MCP server.
 *
 * This is the "out" direction: an agent (ZCode, Codex, WorkBuddy, Droid) calls
 * these tools to speak into a Relay group. Dispatch is the other direction and does
 * not go through here — an agent is driven by its own headless interface, and talks
 * back with these tools.
 *
 * Transport: MCP stdio, one JSON-RPC 2.0 message per line, exactly as the protocol
 * specifies. Nothing is written to stdout except protocol messages; diagnostics go
 * to stderr, because a stray `console.log` breaks the client's parser.
 */

import readline from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'relay', version: '14.0.0' };

const APP_URL = (process.env.RELAY_APP_URL || 'http://127.0.0.1:4320').replace(/\/+$/, '');
const TOKEN = process.env.RELAY_ASYNC_TOKEN || null;

const log = (message) => process.stderr.write(`[relay-mcp] ${message}\n`);

async function call(method, path, body) {
  const response = await fetch(`${APP_URL}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(TOKEN ? { 'X-Relay-Async-Token': TOKEN } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const detail = parsed && parsed.error ? parsed.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return parsed;
}

/* -------------------------------------------------------------------- tools */

const SENDER_HINT = {
  agent_id: { type: 'string', description: 'Your agent id in the group, e.g. zcode / codex / workbuddy.' },
  display_name: { type: 'string', description: 'Optional display name shown in the group.' },
  chat_id: { type: 'string', description: 'Optional id of your own chat, kept for traceability.' },
};

const TOOLS = [
  {
    name: 'relay_groups',
    description:
      'List the Relay groups (topic conversations) on this machine, with member counts and in-flight requests.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'relay_read',
    description:
      'Read recent messages of one group, including requests that were dispatched and results that came back.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group id (grp_...).' },
        limit: { type: 'number', description: 'How many recent messages to return, default 20.' },
      },
      required: ['group_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'relay_send',
    description:
      'Send a message into a group. With `to` + `model` + `project` the message is a work request and Relay dispatches it to that agent; without them it is a plain message. Use this to hand work to another agent or to report progress.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string' },
        body: { type: 'string', description: 'What to say, or what to ask for.' },
        ...SENDER_HINT,
        to: { type: 'string', description: 'Agent id to address, e.g. workbuddy.' },
        model: {
          type: 'object',
          description: 'Required when `to` is dispatched.',
          properties: {
            account: { type: 'string' },
            provider: { type: 'string' },
            model_id: { type: 'string' },
            reasoning: { type: 'string' },
          },
          required: ['model_id', 'reasoning'],
        },
        project: {
          type: 'object',
          description: 'Required when `to` is dispatched: which project the work happens in.',
          properties: { id: { type: 'string' }, path: { type: 'string' } },
          required: ['id', 'path'],
        },
      },
      required: ['group_id', 'body', 'agent_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'relay_result',
    description:
      'Report the outcome of a request you received (completed / failed / blocked). Relay routes it to the chat that asked and shows it in the group.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string' },
        agent_id: { type: 'string' },
        display_name: { type: 'string' },
        task_id: { type: 'string', description: 'Task id from the request message (task_...).' },
        outcome: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
        summary: { type: 'string', description: 'What happened, in a sentence or two.' },
      },
      required: ['group_id', 'agent_id', 'task_id', 'outcome', 'summary'],
      additionalProperties: false,
    },
  },
];

function senderFor(args) {
  const agentId = String(args.agent_id || '');
  return {
    agentId,
    displayName: String(args.display_name || '') || agentId,
    app: agentId,
    device: 'local',
    chatId: String(args.chat_id || ''),
  };
}

async function runTool(name, args) {
  if (name === 'relay_groups') {
    const data = await call('GET', '/api/groups');
    return data.groups || [];
  }

  if (name === 'relay_read') {
    const view = await call('GET', `/api/groups/${encodeURIComponent(args.group_id)}`);
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Number(args.limit))) : 20;
    return {
      group: { id: view.group.id, name: view.group.name },
      members: view.members.map((member) => ({
        agent: member.agentId,
        role: member.role,
        session: member.sessionId,
      })),
      messages: view.messages.slice(-limit).map((message) => ({
        kind: message.kind,
        from: message.sender.agentId,
        body: message.body,
        state: message.state,
        outcome: message.outcome,
        task_id: message.taskId,
        at: message.createdAt,
      })),
    };
  }

  if (name === 'relay_send') {
    const mention = args.to
      ? {
          target: String(args.to),
          client: String(args.to),
          ...(args.model
            ? {
                model: {
                  account: String(args.model.account || args.model.provider || ''),
                  provider: String(args.model.provider || args.model.account || ''),
                  modelId: String(args.model.model_id || ''),
                  reasoning: String(args.model.reasoning || ''),
                },
              }
            : {}),
          ...(args.project
            ? { project: { id: String(args.project.id), path: String(args.project.path) } }
            : {}),
        }
      : null;
    const result = await call('POST', `/api/groups/${encodeURIComponent(args.group_id)}/messages`, {
      sender: senderFor(args),
      body: args.body,
      mentions: mention ? [mention] : [],
    });
    return {
      message_id: result.message && result.message.id,
      kind: result.message && result.message.kind,
      state: result.message && result.message.state,
      task_id: result.message && result.message.taskId,
      reason: result.message && result.message.reason,
    };
  }

  if (name === 'relay_result') {
    const result = await call('POST', `/api/groups/${encodeURIComponent(args.group_id)}/results`, {
      sender: senderFor(args),
      taskId: args.task_id,
      outcome: args.outcome,
      summary: args.summary,
    });
    return {
      message_id: result.message && result.message.id,
      delivery: result.message && result.message.state,
      reason: result.message && result.message.reason,
    };
  }

  throw new Error(`未知工具：${name}`);
}

/* ------------------------------------------------------------------- server */

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  // Notifications carry no id and must not be answered.
  if (id === undefined) return;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: `Relay 群聊。用 relay_groups 找群，relay_read 看消息，relay_send 发言或派活，relay_result 回报结果。服务地址 ${APP_URL}。`,
    });
    return;
  }
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const data = await runTool(name, args);
      reply(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
    } catch (error) {
      reply(id, {
        content: [{ type: 'text', text: `调用失败：${error.message}` }],
        isError: true,
      });
    }
    return;
  }
  replyError(id, -32601, `不支持的方法：${method}`);
}

export function startServer({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })}\n`);
      return;
    }
    // Never let one bad message take the server down; the client would lose the
    // whole session.
    void handle(message).catch((error) => log(`处理失败：${error.message}`));
  });
  rl.on('close', () => process.exit(0));
  log(`已启动 · 引擎 ${APP_URL}`);
  return rl;
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('/server.mjs') === true;
if (invokedDirectly) startServer();
