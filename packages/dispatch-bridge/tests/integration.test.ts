/**
 * End to end: group chat → engine → bridge → fake client → back into the group.
 *
 * The desktop app is the only fake part. The engine, the HTTP contract, the
 * adapter, the watcher, and the callback route are the real ones, so this is the
 * evidence that the loop closes once an adapter exists.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AsyncEngine,
  DemoControlRoomSource,
  HttpBridgeAdapter,
  startControlRoom,
} from '@agent-relay/control-room';

import { BridgeStore } from '../src/store.mjs';
import { createBridgeServer } from '../src/server.mjs';

const scratch: string[] = [];

async function scratchDir(prefix) {
  const base = existsSync('D:\\') ? 'D:\\Temp' : tmpdir();
  const dir = await mkdtemp(join(base, prefix));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function fakeClient() {
  const submitted = [];
  let index = 0;
  const polls = [
    () => ({ status: 'running', response: '' }),
    () => ({ status: 'completed', response: '空状态已补，npm test 通过' }),
  ];
  class FakeDesktop {
    constructor(_transport, sessionId) {
      this.sessionId = sessionId ?? null;
    }
    async createSession() {
      this.sessionId = 'session_zcode_real_1';
      return { sessionId: this.sessionId, transport: 'local' };
    }
    async submit(sessionId, text, requestId) {
      submitted.push({ sessionId, text, requestId });
    }
    async poll() {
      const next = polls[Math.min(index, polls.length - 1)];
      index += 1;
      return next();
    }
  }
  return {
    submitted,
    drivers: {
      available: true,
      reason: null,
      classes: { workbuddy: FakeDesktop, zcode: FakeDesktop, factory: FakeDesktop },
      connect: async () => ({ close() {} }),
    },
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return false;
}

describe('group → bridge → client → group', () => {
  it('dispatches an @ request and lands the result back in the conversation', async () => {
    const client = fakeClient();
    const store = new BridgeStore({ dir: await scratchDir('relay-bridge-e2e-store-') });
    await store.open();
    const engine = new AsyncEngine({ dataRoot: await scratchDir('relay-bridge-e2e-engine-') });
    const server = await startControlRoom({
      source: new DemoControlRoomSource({ tickMs: 600000 }),
      port: 0,
      async: { engine },
    });

    const bridge = createBridgeServer({
      config: {
        port: 0,
        host: '127.0.0.1',
        engineUrl: server.url,
        engineToken: null,
        desktopNativeDir: null,
        dataDir: store.dir,
        pollMs: 30,
        timeoutMs: 5000,
      },
      drivers: client.drivers,
      store,
    });
    const { url: bridgeUrl } = await bridge.listen();
    // The bridge exists only after the engine bound its port, so the adapter is
    // registered at runtime — the same path the app uses when a bridge appears late.
    engine.registerAdapter(new HttpBridgeAdapter({ client: 'zcode', baseUrl: bridgeUrl }));

    const sender = {
      agentId: 'codex',
      displayName: 'Codex',
      app: 'codex',
      device: 'desktop-01',
      chatId: 'chat_original_7',
    };
    const group = await engine.createGroup({ name: '20261104-MediaDock-需求开发2', creator: sender });

    const request = await engine.postGroupMessage(group.group.id, {
      sender,
      body: '把登录页的空状态补上',
      mentions: [
        {
          target: 'zcode',
          client: 'zcode',
          project: { id: 'proj_1', path: 'D:\\Work\\MediaDock' },
          model: { account: 'BigModel', provider: 'zhipu', modelId: 'GLM-5.3-Flash', reasoning: 'max' },
        },
      ],
    });

    expect(request.message.state).toBe('delivered');
    expect(request.receipt?.sessionId).toBe('session_zcode_real_1');
    expect(client.submitted).toHaveLength(1);
    expect(client.submitted[0].text).toContain('把登录页的空状态补上');

    const arrived = await waitFor(async () => {
      const view = await engine.group(group.group.id);
      return Boolean(view?.messages.some((message) => message.kind === 'result'));
    });
    expect(arrived).toBe(true);

    const view = await engine.group(group.group.id);
    const result = view?.messages.find((message) => message.kind === 'result');
    expect(result?.outcome).toBe('completed');
    expect(result?.body).toContain('npm test 通过');
    // The origin chat is `codex`; this install has no codex delivery channel, so the
    // reply is a manual item rather than a claimed delivery.
    expect(result?.state).toBe('manual');
    expect(view?.members.find((member) => member.agentId === 'zcode')?.sessionId).toBe(
      'session_zcode_real_1'
    );

    await engine.close();
    await server.close();
    await bridge.close();
  });
});
