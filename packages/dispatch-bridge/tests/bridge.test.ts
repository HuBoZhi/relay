/**
 * The bridge, tested without a desktop client.
 *
 * The point of these tests is the contract the engine relies on: dispatch returns
 * before the turn ends, the watcher reports the result exactly once, an interrupted
 * turn is reported as blocked rather than completed, and a missing adapter is a
 * refusal instead of a fake success.
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveBridgeConfig } from '../src/config.mjs';
import { loadDrivers } from '../src/drivers.mjs';
import { BridgeStore } from '../src/store.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { buildPrompt } from '../src/server.mjs';

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

function fakeDrivers(polls) {
  const calls = { submitted: [], transports: [] };
  let index = 0;
  class FakeDesktop {
    constructor(transport, sessionId) {
      this.transport = transport;
      this.sessionId = sessionId ?? null;
    }
    async createSession() {
      this.sessionId = 'sess_fake_1';
      return { sessionId: this.sessionId, transport: 'local' };
    }
    async submit(sessionId, text, requestId) {
      calls.submitted.push({ sessionId, text, requestId });
    }
    async poll() {
      const next = polls[Math.min(index, polls.length - 1)];
      index += 1;
      return next();
    }
  }
  return {
    drivers: {
      available: true,
      reason: null,
      classes: { workbuddy: FakeDesktop, zcode: FakeDesktop, factory: FakeDesktop },
      connect: async () => {
        const transport = {
          closed: false,
          close() {
            this.closed = true;
          },
        };
        calls.transports.push(transport);
        return transport;
      },
    },
    calls,
  };
}

function fakeEngine() {
  const received = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      received.push({ url: request.url, body: body ? JSON.parse(body) : null });
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  return { server, received };
}

async function listen(server) {
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  return port;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function startHarness({ polls, dispatch }) {
  const engine = fakeEngine();
  const enginePort = await listen(engine.server);
  const { drivers, calls } = fakeDrivers(polls);
  const store = new BridgeStore({ dir: await scratchDir('relay-bridge-store-') });
  await store.open();
  const config = {
    port: 0,
    host: '127.0.0.1',
    engineUrl: `http://127.0.0.1:${enginePort}`,
    engineToken: null,
    desktopNativeDir: null,
    dataDir: store.dir,
    pollMs: 30,
    timeoutMs: 5000,
  };
  const bridge = createBridgeServer({ config, drivers, store });
  const { url } = await bridge.listen();
  return { engine, calls, store, bridge, url };
}

function request(overrides = {}) {
  return {
    taskId: 'task_1',
    stageId: 'stg_1',
    runId: 'run_1',
    topicName: '20261104-MediaDock-需求开发2',
    title: '补登录页空状态',
    body: '把空状态补上，文案统一',
    client: 'zcode',
    project: { id: 'proj_1', path: 'D:\\Work\\MediaDock' },
    session: { policy: 'new', sessionId: null },
    model: { account: 'BigModel', provider: 'zhipu', modelId: 'GLM-5.3-Flash', reasoning: 'max' },
    callback: { app: 'codex', device: 'desktop-01', chatId: 'chat_original_7' },
    completion: { condition: '测试通过', requiresEvidence: false },
    ...overrides,
  };
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('dispatch', () => {
  it('returns when the prompt is accepted, before the turn ends', async () => {
    const harness = await startHarness({
      polls: [
        () => ({ status: 'running', response: '' }),
        () => ({ status: 'completed', response: '已完成' }),
      ],
    });
    try {
      const started = Date.now();
      const result = await post(`${harness.url}/dispatch`, request());
      const elapsed = Date.now() - started;

      expect(result.status).toBe(200);
      expect(result.body.status).toBe('delivered');
      expect(result.body.sessionId).toBe('sess_fake_1');
      expect(elapsed).toBeLessThan(1000);
      expect(harness.calls.submitted).toHaveLength(1);
      expect(harness.calls.submitted[0].text).toContain('补登录页空状态');
      expect(harness.calls.submitted[0].text).toContain('完成条件：测试通过');
      expect(harness.calls.submitted[0].text).toContain('会自动回报结果');
    } finally {
      await harness.bridge.close();
      harness.engine.server.close();
    }
  });

  it('reports the finished turn to the engine exactly once', async () => {
    const harness = await startHarness({
      polls: [
        () => ({ status: 'running', response: '' }),
        () => ({ status: 'completed', response: '空状态已补' }),
      ],
    });
    try {
      await post(`${harness.url}/dispatch`, request());
      const arrived = await waitFor(() => harness.engine.received.length > 0);
      expect(arrived).toBe(true);
      const report = harness.engine.received[0];
      expect(report.url).toBe('/api/async/callbacks');
      expect(report.body.taskId).toBe('task_1');
      expect(report.body.outcome).toBe('completed');
      expect(report.body.summary).toContain('空状态已补');
      expect(report.body.idempotencyKey).toBe('bridge:task_1:stg_1:run_1');
      // Longer than the poll interval: a replay would show up here.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(harness.engine.received).toHaveLength(1);
    } finally {
      await harness.bridge.close();
      harness.engine.server.close();
    }
  });

  it('reports an interrupted turn as blocked, never completed', async () => {
    const harness = await startHarness({
      polls: [() => ({ status: 'cancelled', response: '用户中断' })],
    });
    try {
      await post(`${harness.url}/dispatch`, request());
      await waitFor(() => harness.engine.received.length > 0);
      expect(harness.engine.received[0].body.outcome).toBe('blocked');
      expect(harness.engine.received[0].body.summary).toContain('中断');
    } finally {
      await harness.bridge.close();
      harness.engine.server.close();
    }
  });

  it('reports a permission request as blocked with the pending ids', async () => {
    const harness = await startHarness({
      polls: [
        () => ({
          status: 'error',
          response: '',
          error: { code: 'desktop_confirmation_required', pendingRequestIds: ['perm_1'] },
        }),
      ],
    });
    try {
      await post(`${harness.url}/dispatch`, request());
      await waitFor(() => harness.engine.received.length > 0);
      const body = harness.engine.received[0].body;
      expect(body.outcome).toBe('blocked');
      expect(body.summary).toContain('等待确认');
      expect(body.summary).toContain('perm_1');
    } finally {
      await harness.bridge.close();
      harness.engine.server.close();
    }
  });

  it('refuses a request without a project instead of letting the client choose', async () => {
    const harness = await startHarness({ polls: [() => ({ status: 'completed', response: '' })] });
    try {
      const result = await post(`${harness.url}/dispatch`, request({ project: undefined }));
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('项目目录');
    } finally {
      await harness.bridge.close();
      harness.engine.server.close();
    }
  });

  it('queues a second request on a busy client with a reason', async () => {
    const harness = await startHarness({
      polls: Array.from({ length: 40 }, () => () => ({ status: 'running', response: '' })),
    });
    try {
      const first = await post(`${harness.url}/dispatch`, request());
      const second = await post(`${harness.url}/dispatch`, request({ taskId: 'task_2' }));
      expect(first.body.status).toBe('delivered');
      expect(second.body.status).toBe('queued');
      expect(second.body.reason).toContain('已有任务在执行');
      expect(harness.calls.submitted).toHaveLength(1);
    } finally {
      await harness.bridge.close();
      harness.engine.server.close();
    }
  });

  it('answers manual for chat delivery rather than claiming it worked', async () => {
    const harness = await startHarness({ polls: [() => ({ status: 'completed', response: '' })] });
    try {
      const result = await post(`${harness.url}/deliver`, { chat: { chatId: 'chat_1' } });
      expect(result.body.state).toBe('manual');
      expect(result.body.reason).toContain('未实现原聊天注入');
    } finally {
      await harness.bridge.close();
      harness.engine.server.close();
    }
  });
});

describe('probe', () => {
  it('answers a single-client probe at the top level, as the engine expects', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url, init) => String(url) === 'http://127.0.0.1:19372/json/version'
      ? Promise.resolve(new Response(JSON.stringify({ Browser: 'ZCode fixture' }))) : realFetch(url, init));
    const harness = await startHarness({ polls: [() => ({ status: 'running', response: '' })] });
    try {
      const single = await post(`${harness.url}/probe`, { client: 'zcode' });
      expect(single.status).toBe(200);
      expect(single.body.client).toBe('zcode');
      // ZCode's interface cannot be checked from a global, so it stays unverified
      // until a dispatch passes through its service registry.
      expect(single.body.interfaceReady).toBe('unverified');
      expect(single.body.notes.join(' ')).toContain('服务注册表');

      const all = await post(`${harness.url}/probe`, {});
      expect(all.body.probes).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
      await harness.bridge.close();
      harness.engine.server.close();
    }
  });
});

describe('adapter loading', () => {
  it('loads the installed adapter modules and names a missing directory', async () => {
    const dir = await scratchDir('relay-bridge-adapter-');
    await writeFile(
      join(dir, 'cdp.mjs'),
      'export class DesktopIpcTransport { static async connect() { throw new Error("no desktop in tests"); } }\n'
    );
    await writeFile(
      join(dir, 'native-clients.mjs'),
      'export class WorkBuddyDesktop {}\nexport class ZCodeDesktop {}\n'
    );
    await writeFile(join(dir, 'factory.mjs'), 'export class FactoryDesktop {}\n');

    const loaded = await loadDrivers(dir);
    expect(loaded.available).toBe(true);
    expect(Object.keys(loaded.classes).sort()).toEqual(['factory', 'workbuddy', 'zcode']);

    const missing = await loadDrivers(join(dir, 'not-here'));
    expect(missing.available).toBe(false);
    expect(missing.reason).toContain('适配器加载失败');
  });
});

describe('bridge state', () => {
  it('keeps sessions apart per client and workspace, and never retries a cut-off run', async () => {
    const dir = await scratchDir('relay-bridge-state-');
    const store = new BridgeStore({ dir });
    await writeFile(join(dir, 'sessions.json'), '{}').catch(() => undefined);
    await store.open();
    await store.saveSession('zcode', 'D:\\Work\\App', { sessionId: 'sess_1' });
    await store.saveSession('zcode', 'D:/work/app/', { sessionId: 'sess_2' });
    expect(store.session('zcode', 'D:\\Work\\App')?.sessionId).toBe('sess_2');

    await store.putPending({
      id: 'run_cut',
      client: 'zcode',
      taskId: 't',
      stageId: 's',
      runId: 'r',
      state: 'submitting',
      startedAt: new Date().toISOString(),
    });
    const reopened = new BridgeStore({ dir });
    await reopened.open();
    const record = reopened.pendingById('run_cut');
    expect(record?.state).toBe('unconfirmed');
    expect(record?.note).toContain('无法确认');
  });
});

describe('config', () => {
  it('loads a stdio MCP configuration and resolves its working directory', async () => {
    const root = await scratchDir('relay-mcp-config-');
    const file = join(root, 'mcp.json');
    await writeFile(file, '\uFEFF' + JSON.stringify({ command: process.execPath, args: ['mcp.js'], cwd: 'worker', mode: 'build' }));
    const config = resolveBridgeConfig({ argv: ['--zcode-mcp-config', file], env: {} });
    expect(config.zcodeMcp).toMatchObject({ command: process.execPath, cwd: join(root, 'worker'), mode: 'build' });
    await writeFile(file, JSON.stringify({ command: 'node', args: [], mode: 'invalid' }));
    expect(() => resolveBridgeConfig({ argv: ['--zcode-mcp-config', file], env: {} })).toThrow('mode');
  });
  it('refuses a remote engine and a data directory on the system drive', () => {
    expect(() => resolveBridgeConfig({ argv: ['--engine', 'http://10.0.0.9:4320'], env: {} })).toThrow(
      '回环地址'
    );
    expect(() => resolveBridgeConfig({ argv: ['--data', 'C:\\RelayData\\bridge'], env: {} })).toThrow(
      '系统盘'
    );
    const ok = resolveBridgeConfig({ argv: ['--port', '7900', '--data', 'D:\\Temp\\bridge'], env: {} });
    expect(ok.port).toBe(7900);
    expect(ok.engineUrl).toBe('http://127.0.0.1:4320');
  });
});

describe('prompt', () => {
  it('carries the job, the completion condition, and the project', () => {
    const text = buildPrompt(request());
    expect(text).toContain('【20261104-MediaDock-需求开发2】补登录页空状态');
    expect(text).toContain('把空状态补上');
    expect(text).toContain('项目目录：D:\\Work\\MediaDock');
  });
});

void mkdir;
