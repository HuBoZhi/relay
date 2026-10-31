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
    return { info: { id: 'owned-session', title: 'Relay 专用 · WorkBuddy', transport: 'local' },
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
