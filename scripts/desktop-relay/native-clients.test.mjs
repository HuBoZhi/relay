import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { WorkBuddyDesktop, ZCodeDesktop } from './native-clients.mjs';

for (const Client of [WorkBuddyDesktop, ZCodeDesktop]) {
  test(`${Client.name} rejects a task addressed to another session before IPC`, async () => {
    const client = new Client({ evaluate() { throw Error('Must not call IPC'); } }, 'owned-session');
    await assert.rejects(() => client.submit('other-session', 'A task'), /Dedicated session mismatch/);
  });
}

test('WorkBuddy SDK submission preserves quoted multiline input and returns its correlated response', async () => {
  const text = 'Relay 的 "任务"\n不要执行工具';
  let received;
  const context = vm.createContext({ wb: { conversations: { async get() {
    return { info: { id: 'owned-session', title: '模型自动生成的新标题', transport: 'local', state: 'idle', space: { cwd: 'D:/Programs/AgentRelay/desktop-workspace' } },
      async runPrompt(content) { received = content[0].text; return { state: 'completed', requestId: 'native-1', content: [{ type: 'text', text: '结果\n437' }] }; } };
  } } } });
  const client = new WorkBuddyDesktop({ evaluate(expression) { return vm.runInContext(expression, context); } }, 'owned-session');
  assert.equal((await client.submit('owned-session', text, 'nonce-1')).accepted, true);
  const result = await client.poll('owned-session', 'nonce-1');
  assert.equal(received, text);
  assert.equal(result.status, 'completed');
  assert.equal(result.response, '结果\n437');
  assert.equal(result.nativeRequestId, 'native-1');
});

test('ZCode session reuse returns only new assistant messages', async () => {
  const client = new ZCodeDesktop({}, 'owned-session');
  let submitted = false;
  client.call = async (_service, method) => {
    if (method === 'sendPrompt') { submitted = true; return; }
    return { session: { workspace: { workspacePath: 'D:/Programs/AgentRelay/desktop-workspace' }, title: 'Relay 专用 · ZCode', status: 'idle' },
      messages: [{ info: { messageId: 'old', role: 'assistant' }, parts: [{ type: 'text', text: 'old answer' }] },
        ...(submitted ? [{ info: { messageId: 'new', role: 'assistant' }, parts: [{ type: 'text', text: 'new answer' }] }] : [])] };
  };
  await client.submit('owned-session', 'Next task', 'next-request');
  assert.equal((await client.poll('owned-session', 'next-request')).response, 'new answer');
});

test('ZCode resumes an inactive saved session before sending a new task', async () => {
  const client = new ZCodeDesktop({}, 'owned-session');
  const calls = [];
  let active = false;
  client.call = async (_service, method) => {
    calls.push(method);
    if (method === 'readSession' && !active) throw Error('Session is not active: owned-session');
    if (method === 'resumeTask') { active = true; return; }
    return { session: { workspace: { workspacePath: 'D:/Programs/AgentRelay/desktop-workspace' }, status: 'idle' }, messages: [] };
  };
  await client.submit('owned-session', 'Next task');
  assert.deepEqual(calls, ['readSession', 'resumeTask', 'readSession', 'sendPrompt']);
});

test('ZCode can recover a response by command ID without confusing an older turn', async () => {
  const client = new ZCodeDesktop({}, 'owned-session');
  client.call = async () => ({ session: { status: 'idle', title: 'Relay 专用 · ZCode' }, messages: [
    { info: { messageId: 'old', role: 'assistant' }, parts: [{ type: 'text', text: 'old answer' }] },
    { info: { messageId: 'user', role: 'user', metadata: { inputIntent: { sourceCommandId: 'nonce1' } } }, parts: [] },
    { info: { messageId: 'reply', parentMessageId: 'user', role: 'assistant' }, parts: [{ type: 'text', text: 'new answer' }] },
  ] });
  assert.equal((await client.poll('owned-session', 'nonce-1')).response, 'new answer');
  assert.equal((await client.poll('owned-session', 'other')).response, '');
});
