import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopIpcTransport } from './cdp.mjs';

test('refuses a target outside the requested desktop app', async () => {
  await assert.rejects(() => DesktopIpcTransport.connect({ port: 19371, client: 'workbuddy',
    fetch: async () => ({ ok: true, json: async () => [{ type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:19371/devtools/page/1' }] }) }), /desktop target/);
});

test('refuses a debugger advertised on another host before connecting', async () => {
  await assert.rejects(() => DesktopIpcTransport.connect({ port: 19371, client: 'workbuddy',
    fetch: async () => ({ ok: true, json: async () => [{ type: 'page',
      url: 'file:///D:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html',
      webSocketDebuggerUrl: 'ws://example.com:19371/devtools/page/1' }] }) }), /Untrusted/);
});

test('evaluates SDK calls and rejects a lost connection with a request pending', async () => {
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) {
      const request = JSON.parse(raw);
      assert.equal(request.method, 'Runtime.evaluate');
      if (request.params.expression === 'lost') { this.close(); return; }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        id: request.id, result: { result: { value: { state: 'idle' } } },
      }) })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const client = await DesktopIpcTransport.connect({ port: 19371, client: 'workbuddy', WebSocket: Socket,
    fetch: async () => ({ ok: true, json: async () => [{ type: 'page',
      url: 'file:///D:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:19371/devtools/page/1' }] }) });
  assert.deepEqual(await client.evaluate('wb.conversations.list()'), { state: 'idle' });
  await assert.rejects(() => client.request('Input.dispatchKeyEvent', {}), /Unsupported/);
  await assert.rejects(() => client.request('DOM.getDocument', {}), /Unsupported/);
  await assert.rejects(() => client.evaluate('lost'), /connection closed/);
});
