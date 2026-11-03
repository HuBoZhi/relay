import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { FactoryDesktop } from './factory.mjs';

const workspace = 'D:/Programs/AgentRelay/desktop-workspace';
function fixture(handle) {
  const listeners = new Set();
  const sent = [];
  const transport = { evaluate: expression => runInNewContext(expression, { setTimeout, clearTimeout,
    electronAPI: {
      auth: { getAuthData: async () => ({ accessToken: 'fixture-only-token' }) },
      daemon: {
        isAvailable: async () => true,
        onMessage: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        sendMessage: async raw => {
          const request = JSON.parse(raw); sent.push(request);
          const result = await handle(request);
          const response = JSON.stringify({ type: 'response', id: request.id, result });
          for (const listener of [...listeners]) listener(response);
        },
      },
    },
  }) };
  return { desktop: new FactoryDesktop(transport, 'dedicated'), sent, listeners };
}

test('Factory uses native IPC and keeps sign-in tokens inside the renderer', async () => {
  const { desktop, sent, listeners } = fixture(request => {
    assert.equal(request.method, 'daemon.initialize_session');
    assert.equal(request.params.token, 'fixture-only-token');
    assert.equal(request.params.cwd, workspace);
    assert.equal(request.params.autonomyLevel, 'off');
    return { sessionId: request.params.sessionId };
  });
  const binding = await desktop.createSession();
  assert.equal(binding.transport, 'local');
  assert.equal(JSON.stringify(binding).includes('fixture-only-token'), false);
  assert.equal(sent.length, 1);
  assert.equal(listeners.size, 0);
  await assert.rejects(() => desktop.call('execute_shell', {}), /Unsupported/);
});

test('Factory resumes only its dedicated session and sends exact multiline text once', async () => {
  let loaded = false;
  const { desktop, sent } = fixture(request => {
    switch (request.method) {
      case 'daemon.list_opened_sessions': return { sessions: loaded ? [{ sessionId: 'dedicated', cwd: workspace, workingState: 'idle' }] : [] };
      case 'daemon.load_session': loaded = true; assert.equal(request.params.sessionId, 'dedicated'); return {};
      case 'daemon.add_user_message': return {};
      default: throw new Error('Unexpected method');
    }
  });
  const text = '# Task\nReturn "ready"; $literal \\ path';
  await desktop.submit('dedicated', text, 'nonce');
  const prompts = sent.filter(s => s.method === 'daemon.add_user_message');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].params.text, text);
  assert.equal(prompts[0].params.messageId, 'nonce');
  await assert.rejects(() => desktop.submit('another', text), /session mismatch/);
});

test('Factory refuses busy sessions and sessions outside the Relay workspace', async () => {
  for (const session of [
    { sessionId: 'dedicated', cwd: workspace, workingState: 'thinking' },
    { sessionId: 'dedicated', cwd: 'D:/other', workingState: 'idle' },
  ]) {
    const { desktop, sent } = fixture(() => ({ sessions: [session] }));
    await assert.rejects(() => desktop.submit('dedicated', 'task'), /busy|workspace mismatch/);
    assert.equal(sent.some(s => s.method === 'daemon.add_user_message'), false);
  }
});

test('Factory requires a completed outcome for the exact session and turn', async () => {
  let result = { status: 'unavailable', sessionId: 'dedicated', turnId: 'nonce' };
  const { desktop } = fixture(() => result);
  assert.equal((await desktop.poll('dedicated', 'nonce')).status, 'running');
  result = { status: 'available', sessionId: 'dedicated', turnId: 'nonce', outcome: { turnId: 'nonce', reason: 'completed' }, finalOutput: '437' };
  assert.equal((await desktop.poll('dedicated', 'nonce')).response, '437');
  result.outcome.turnId = 'old-turn';
  await assert.rejects(() => desktop.poll('dedicated', 'nonce'), /outcome identity/);
  result.turnId = 'old-turn';
  await assert.rejects(() => desktop.poll('dedicated', 'nonce'), /turn identity/);
});

test('Factory reports model failures even when an output string exists', async () => {
  const { desktop } = fixture(() => ({ status: 'available', sessionId: 'dedicated', turnId: 'nonce',
    outcome: { turnId: 'nonce', reason: 'model_usage_exhausted' }, finalOutput: 'error text' }));
  assert.equal((await desktop.poll('dedicated', 'nonce')).status, 'error');
});
