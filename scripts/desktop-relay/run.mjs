import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopIpcTransport } from './cdp.mjs';
import { WorkBuddyDesktop, ZCodeDesktop } from './native-clients.mjs';

const [client, runtimeArg = 'D:/Programs/AgentRelay'] = process.argv.slice(2);
if (!['workbuddy', 'zcode'].includes(client)) throw Error('Usage: node run.mjs workbuddy|zcode [local-relay-installation]');
const root = resolve(runtimeArg);
if (/^c:/i.test(root)) throw Error('Runtime files must stay off C:');
const { AgentRelay } = await import(pathToFileURL(join(root, 'node_modules/@agent-relay/sdk/dist/index.js')));
const { openRelay, ensureAgent } = await import(pathToFileURL(join(root, 'lib/relay.mjs')));
const stateFile = join(root, 'data/workspace.private.json');
await readFile(stateFile); // Never create an unintended new Relay workspace.
const relay = await openRelay();
const identity = await ensureAgent(relay, client + '-desktop-native');
const operator = await ensureAgent(relay, 'operator');
const state = JSON.parse(await readFile(stateFile, 'utf8'));
const worker = new AgentRelay({ workspaceKey: state.workspaceKey, agentToken: state.agents[identity.name] });
const caller = new AgentRelay({ workspaceKey: state.workspaceKey, agentToken: state.agents[operator.name] });
const command = `desktop.${client}.execute`;
const sessionsFile = join(root, 'data/desktop-native.sessions.json');
let transport;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Relay connection timeout')), 20_000);
    worker.messaging.events.on('connected', () => { clearTimeout(timer); resolve(); });
    worker.messaging.events.connect();
  });
  await worker.capabilities.register({ command, handlerAgent: identity.name, availableTo: [operator.name],
    description: `Call the installed ${client} desktop through local CDP to native IPC/SDK. This probe requires an online local adapter; no mouse, keyboard, DOM, or standalone model CLI.`,
    inputSchema: { type: 'object', properties: { requestNonce: { type: 'string' }, task: { type: 'string' } }, required: ['requestNonce','task'], additionalProperties: false } });
  const requestNonce = randomUUID();
  const expected = `RELAY_DESKTOP_${requestNonce}:437`;
  const input = { requestNonce, task: `这是用户授权的 Relay 桌面接口联调。计算 19×23，只回复 ${expected}。不要调用任何工具，不读写文件，不启动子代理。` };
  let ack;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { ack = await caller.capabilities.invoke(command, input); break; }
    catch (error) {
      if (error.rawCode !== 'handler_unavailable' || attempt === 2) throw error;
      await delay(1500);
    }
  }
  const inbound = await worker.capabilities.getInvocation(command, ack.invocationId);
  if (!isDeepStrictEqual(inbound.input, input)) throw Error('Relay input mismatch');
  await mkdir(join(root, 'reports'), { recursive: true });
  await writeFile(join(root, `reports/${client}-desktop-native-pending.json`), JSON.stringify({
    checkedAt: new Date().toISOString(), action: command, invocationId: ack.invocationId,
    requestNonce, state: 'received_by_adapter',
  }, null, 2));
  let sessions;
  try { sessions = JSON.parse(await readFile(sessionsFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; sessions = {}; }
  transport = await DesktopIpcTransport.connect({ client, port: client === 'workbuddy' ? 19371 : 19372 });
  const desktop = client === 'workbuddy' ? new WorkBuddyDesktop(transport, sessions[client]?.sessionId) : new ZCodeDesktop(transport, sessions[client]?.sessionId);
  if (!sessions[client]) {
    sessions[client] = await desktop.createSession();
    await writeFile(sessionsFile, JSON.stringify(sessions, null, 2));
  }
  const sessionId = sessions[client].sessionId;
  await desktop.submit(sessionId, inbound.input.task, requestNonce);
  console.log(JSON.stringify({ client, invocationId: ack.invocationId, sessionId, state: 'submitted_to_desktop_native_api' }));
  const deadline = Date.now() + 180_000;
  let result;
  while (Date.now() < deadline) {
    await delay(2000);
    result = await desktop.poll(sessionId, requestNonce);
    if (['completed','error','cancelled'].includes(result.status)) break;
  }
  const output = { ok: result?.status === 'completed' && result.response?.trim() === expected,
    client, sessionId, requestNonce, transport: 'desktop-ipc-via-cdp', usedMouseKeyboard: false,
    state: result?.status ?? 'unknown', response: result?.response ?? '' };
  if (!output.ok && !['error','cancelled'].includes(output.state)) output.state = 'not_confirmed';
  await worker.capabilities.completeInvocation(command, inbound.invocationId, { output });
  const receipt = await caller.capabilities.getInvocation(command, inbound.invocationId);
  if (!isDeepStrictEqual(receipt.output, output)) throw Error('Relay completion mismatch');
  await mkdir(join(root, 'reports'), { recursive: true });
  const report = { checkedAt: new Date().toISOString(), action: command, invocationId: receipt.invocationId, relayStatus: receipt.status, output: receipt.output };
  await writeFile(join(root, `reports/${client}-desktop-native-via-relay.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!output.ok) process.exitCode = 2;
} finally {
  transport?.close();
  await Promise.allSettled([worker.messaging.events.disconnect(), caller.messaging.events.disconnect()]);
}
