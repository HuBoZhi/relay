/** Opt-in, one-turn desktop MCP experiment. No CLI, credential extraction or polling. */
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { DesktopIpcTransport } from './cdp.mjs';

const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const connect = () => DesktopIpcTransport.connect({ client: 'workbuddy', port: 19371, WebSocket, timeoutMs: 120000 });
const tools = [{ name: 'workbuddy_check', description: 'Check the live WorkBuddy desktop interface without creating a session.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
{ name: 'workbuddy_echo', description: 'Create an isolated desktop conversation and ask it to echo a nonce. One synchronous diagnostic turn only.',
  inputSchema: { type: 'object', properties: { nonce: { type: 'string', pattern: '^[a-zA-Z0-9-]{1,80}$' } }, required: ['nonce'], additionalProperties: false } }];

async function nonC(path) {
  const full = resolve(path);
  if (/^C:[\\/]/i.test(full)) throw Error('Experiment paths must be outside C:');
  let existing = full;
  for (;;) {
    try {
      if (/^C:[\\/]/i.test(await realpath(existing))) throw Error('Experiment ancestor resolves to C:');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(existing) === existing) throw error;
      existing = dirname(existing);
    }
  }
  await mkdir(full, { recursive: true });
  if (/^C:[\\/]/i.test(await realpath(full))) throw Error('Experiment path resolves to C:');
  return full;
}

if (process.argv.includes('--server')) {
  const server = new Server({ name: 'relay-workbuddy-desktop-probe', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!tools.some(t => t.name === params.name)) throw Error('Unknown tool');
    const transport = await connect();
    try {
      if (params.name === 'workbuddy_check') return json(await transport.evaluate(`({
        ready: typeof globalThis.wb?.conversations?.create === 'function' && typeof globalThis.wb?.conversations?.get === 'function',
        backend: 'live-desktop', port: 19371
      })`));
      const nonce = params.arguments?.nonce;
      if (typeof nonce !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(nonce)) throw Error('Invalid nonce');
      const cwd = await nonC(process.env.RELAY_WORKBUDDY_PROBE_WORKSPACE || 'D:/Programs/AgentRelay/test-workspace/workbuddy-mcp');
      // Await the desktop's own completion promise once. A timeout never resubmits
      // or cancels the original task; inspect that dedicated conversation instead.
      return json(await transport.evaluate(`(async () => {
        const created = await wb.conversations.create({cwd:${JSON.stringify(cwd)}, title:'MCP 连通性验证 ${nonce}',
          transport:'local',conversationOrigin:'local',mode:'craft',permissionMode:'default'});
        if(created.errorCode || !created.info?.id || created.info.transport !== 'local') throw Error('Dedicated conversation creation failed');
        const sessionId = created.info.id;
        const conversation = await wb.conversations.get(sessionId);
        if(conversation.info.state !== 'idle' || conversation.info.space?.cwd?.replaceAll('\\\\','/') !== ${JSON.stringify(cwd.replaceAll('\\', '/'))}) throw Error('Dedicated conversation mismatch');
        const result = await conversation.runPrompt([{type:'text',text:${JSON.stringify(`这是用户授权的 MCP 连通性测试。不要调用工具、不要读写文件、不要执行命令。只回复一行：WORKBUDDY_MCP_OK ${nonce}`)}}], {clientRequestId:${JSON.stringify(nonce)}});
        return {sessionId, requestId:result.requestId, state:result.state,
          response:(result.content || []).filter(x=>x.type==='text').map(x=>x.text || '').join('\\n')};
      })()`));
    } finally { transport.close(); }
  });
  await server.connect(new StdioServerTransport());
} else {
  const scratch = await nonC(process.env.TEMP || 'D:/CodexTemp/workbuddy-mcp-probe-20261106');
  const client = new Client({ name: 'relay-workbuddy-probe-client', version: '0.1.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(import.meta.url), '--server'],
    cwd: scratch, env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch }, stderr: 'pipe' });
  transport.stderr?.resume();
  try {
    await client.connect(transport);
    console.log(JSON.stringify({ server: client.getServerVersion(), tools: (await client.listTools()).tools.map(t=>t.name) }));
    const check = await client.callTool({ name: 'workbuddy_check', arguments: {} });
    console.log(JSON.stringify({ check }));
    if (!process.argv.includes('--ask')) process.exitCode = check.isError ? 1 : 0;
    else {
      if (check.isError || !JSON.parse(check.content[0].text).ready) throw Error('Desktop interface unavailable; no prompt sent');
      const nonce = randomUUID();
      const reply = await client.callTool({ name: 'workbuddy_echo', arguments: { nonce } }, undefined, { timeout: 130000 });
      console.log(JSON.stringify({ nonce, reply }));
      const result = reply.isError ? null : JSON.parse(reply.content[0].text);
      if (!result?.response?.includes(`WORKBUDDY_MCP_OK ${nonce}`)) process.exitCode = 1;
    }
  } finally { await client.close(); }
}
