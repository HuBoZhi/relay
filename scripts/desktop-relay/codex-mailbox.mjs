import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// This is a mailbox for an existing desktop chat, not another model executor.
const [action, threadId, runtimeArg = 'D:/Programs/AgentRelay'] = process.argv.slice(2);
if (!['register', 'inbox'].includes(action) || !/^[a-f0-9-]{36}$/i.test(threadId ?? '')) {
  throw Error('Usage: codex-mailbox.mjs register|inbox <Codex thread UUID> [runtime root]');
}
const root = await realpath(resolve(runtimeArg));
if (/^c:/i.test(root)) throw Error('Runtime must stay off C:');
const state = JSON.parse(await readFile(join(root, 'data/workspace.private.json'), 'utf8'));
if (!state.workspaceKey) throw Error('Existing Relay workspace is required');
const { AgentRelay } = await import(pathToFileURL(join(root, 'node_modules/@agent-relay/sdk/dist/index.js')));
const relay = new AgentRelay({ workspaceKey: state.workspaceKey });
const directory = join(root, 'data/codex-mailboxes');
await mkdir(directory, { recursive: true });
if (/^c:/i.test(await realpath(directory))) throw Error('Mailbox directory must stay off C:');
const file = join(directory, `${threadId.toLowerCase()}.private.json`);
const name = `codex-desktop-${threadId.toLowerCase()}`;
let binding;
try { binding = JSON.parse(await readFile(file, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
let agent;
if (binding) {
  if (binding.threadId !== threadId.toLowerCase() || binding.name !== name) throw Error('Mailbox binding mismatch');
  agent = await relay.workspace.reconnect({ apiToken: binding.token });
  if (agent.name !== name) throw Error('Relay identity mismatch');
} else {
  if (action !== 'register') throw Error('Register this Codex chat before reading its inbox');
  // Strict registration never rotates another running receiver's token.
  agent = await relay.workspace.register({ name, type: 'agent', strict: true });
  await writeFile(file, JSON.stringify({ threadId: threadId.toLowerCase(), name, token: agent.token }, null, 2), { flag: 'wx', mode: 0o600 });
}
const result = { threadId: threadId.toLowerCase(), recipient: name, mode: 'manual-inbox', autoWake: false };
if (action === 'inbox') {
  result.inbox = await agent.inbox.get({ limit: 50 });
  result.deliveries = await agent.inbox.list({ limit: 50 });
}
// Never include the registration token or workspace key in stdout.
console.log(JSON.stringify(result, null, 2));
