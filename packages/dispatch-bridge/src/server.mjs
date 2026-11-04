/**
 * The bridge's loopback HTTP surface.
 *
 * Three routes, each with one job:
 *
 * - `/dispatch` drives a client and returns as soon as the prompt was accepted.
 *   It never waits for the turn, so the sending chat can end its turn immediately.
 * - `/probe` answers "is this client reachable right now" without creating a
 *   session or sending anything.
 * - `/deliver` is where chat injection would live; it reports `manual` today because
 *   no verified injection path exists. Saying so is the point.
 *
 * Loopback + JSON-only POST is the security boundary, the same one the local app
 * uses. No CORS, no foreign Origin, no remote listener.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { PORTS, SUPPORTED_CLIENTS } from './config.mjs';
import { driverFor, modelOptionsFor, probeClient, sameWorkspace } from './drivers.mjs';
import { BridgeStore } from './store.mjs';
import { TurnWatcher } from './watcher.mjs';

const MAX_BODY = 128 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const type = String(request.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) throw new HttpError(415, '请求必须是 application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new HttpError(413, '请求体过大');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) throw new HttpError(400, '请求体为空');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, '请求体必须是 JSON 对象');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function checkOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  const host = request.headers.host;
  try {
    if (host && new URL(origin).host === host) return;
  } catch {
    /* fall through */
  }
  throw new HttpError(403, '拒绝跨站请求');
}

/** The prompt the client receives. Deliberately plain text: one job, one place. */
export function buildPrompt(request) {
  const lines = [`【${request.topicName}】${request.title}`, '', request.body];
  if (request.completion?.condition) lines.push('', `完成条件：${request.completion.condition}`);
  if (request.project?.path) lines.push(`项目目录：${request.project.path}`);
  lines.push('', '（本轮结束时 Relay 会自动回报结果，无需在此会话中另行通知。）');
  return lines.join('\n');
}

export function createBridgeServer({ config, drivers, store, log = () => {} }) {
  const live = new Map();
  const activeByClient = new Map();

  const desktopFor = (client) => live.get(client)?.desktop ?? null;

  const watcher = new TurnWatcher({
    store,
    engineUrl: config.engineUrl,
    engineToken: config.engineToken,
    pollMs: config.pollMs,
    timeoutMs: config.timeoutMs,
    desktopFor,
    log,
  });

  async function ensureDesktop({ client, workspace, model, continueSessionId }) {
    if (!drivers.available) throw new HttpError(503, drivers.reason);
    const Driver = driverFor(drivers, client);
    if (!Driver) throw new HttpError(400, `不支持的客户端：${client}`);

    const existing = live.get(client);
    if (existing && !sameWorkspace(existing.workspace, workspace)) {
      // A client has one active session in this bridge. Switching projects under a
      // live run is how a session lands in the wrong folder.
      throw new HttpError(409, `该客户端当前绑定项目 ${existing.workspace}，与请求的 ${workspace} 不一致`);
    }

    if (existing && (!continueSessionId || existing.sessionId === continueSessionId)) {
      return existing;
    }

    const transport = existing?.transport ?? (await drivers.connect({ client, port: PORTS[client] }));
    const desktop = new Driver(transport, continueSessionId, {
      workspace,
      model: modelOptionsFor(client, model),
    });
    const entry = { transport, desktop, workspace, sessionId: continueSessionId ?? null };
    live.set(client, entry);
    return entry;
  }

  async function dispatch(request) {
    const client = String(request.client || '');
    if (!SUPPORTED_CLIENTS.includes(client)) throw new HttpError(400, `不支持的客户端：${client}`);
    if (!request.project?.path) throw new HttpError(400, '派发必须指定项目目录');
    if (!request.taskId || !request.stageId || !request.runId) {
      throw new HttpError(400, '派发必须携带 taskId / stageId / runId');
    }
    if (activeByClient.get(client)) {
      // Honest back-pressure: the engine records this as queued with a reason.
      return {
        status: 'queued',
        reason: `「${client}」已有任务在执行，本轮任务排队等待`,
      };
    }

    const workspace = String(request.project.path);
    const continueSessionId =
      request.session?.policy === 'continue' ? (request.session.sessionId ?? null) : null;

    let entry;
    try {
      entry = await ensureDesktop({ client, workspace, model: request.model, continueSessionId });
    } catch (error) {
      return { status: 'failed', reason: error.message };
    }

    const recordId = `${request.taskId}:${request.stageId}:${request.runId}`;
    const requestId = randomUUID();
    const record = {
      id: recordId,
      client,
      taskId: request.taskId,
      stageId: request.stageId,
      runId: request.runId,
      workspace,
      projectId: request.project.id ?? null,
      requestId,
      sessionId: entry.sessionId,
      state: 'submitting',
      startedAt: new Date().toISOString(),
      attempt: 1,
    };
    await store.putPending(record);

    try {
      if (!entry.sessionId) {
        const created = await entry.desktop.createSession();
        entry.sessionId = created.sessionId;
        record.sessionId = created.sessionId;
        await store.saveSession(client, workspace, {
          sessionId: created.sessionId,
          workspace,
          model: request.model ?? null,
        });
      } else if (!sameWorkspace(entry.workspace, workspace)) {
        throw new Error('会话所属项目与请求不一致');
      }
      await entry.desktop.submit(record.sessionId, buildPrompt(request), requestId);
    } catch (error) {
      record.state = 'failed';
      record.note = error.message;
      record.finishedAt = new Date().toISOString();
      await store.putPending(record);
      return { status: 'failed', reason: error.message, sessionId: record.sessionId ?? null };
    }

    record.state = 'accepted';
    await store.putPending(record);
    activeByClient.set(client, record.id);
    void watcher.watch(record).finally(() => {
      if (activeByClient.get(client) === record.id) activeByClient.delete(client);
    });

    return {
      status: 'delivered',
      sessionId: record.sessionId,
      projectId: request.project.id ?? null,
      workspacePath: workspace,
      modelId: request.model?.modelId ?? null,
      account: request.model?.account ?? null,
      reasoning: request.model?.reasoning ?? null,
      nativeTurnId: requestId,
    };
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const method = (request.method ?? 'GET').toUpperCase();

    if (method === 'GET' && url.pathname === '/health') {
      json(response, 200, {
        ok: true,
        engine: config.engineUrl,
        adapterReady: drivers.available,
        adapterReason: drivers.reason,
        clients: Object.fromEntries(
          SUPPORTED_CLIENTS.map((client) => [
            client,
            { port: PORTS[client], active: Boolean(live.get(client)) },
          ])
        ),
        pending: store.pending().map((record) => ({
          id: record.id,
          client: record.client,
          state: record.state,
          startedAt: record.startedAt,
          note: record.note ?? null,
        })),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/runs') {
      json(response, 200, { runs: store.pending() });
      return;
    }

    if (method !== 'POST') {
      json(response, 405, { error: '不支持的请求方法' });
      return;
    }

    checkOrigin(request);

    if (url.pathname === '/probe') {
      const body = await readJson(request).catch(() => ({}));
      if (body.client) {
        // The engine asks about one client and expects that answer at the top level,
        // so the single-client form returns the probe itself.
        json(response, 200, await probeClient({ drivers, client: String(body.client) }));
        return;
      }
      const results = [];
      for (const client of SUPPORTED_CLIENTS) results.push(await probeClient({ drivers, client }));
      json(response, 200, { probes: results });
      return;
    }

    if (url.pathname === '/dispatch') {
      const body = await readJson(request);
      const outcome = await dispatch(body);
      json(response, 200, outcome);
      return;
    }

    if (url.pathname === '/deliver') {
      const body = await readJson(request);
      // No verified way to inject into an arbitrary desktop chat. Reporting anything
      // else here would turn a toast or a queue entry into a false "已收到".
      json(response, 200, {
        state: 'manual',
        reason: `桥接未实现原聊天注入（目标聊天 ${body.chat?.chatId ?? '未知'}），请在 APP 中人工处理`,
      });
      return;
    }

    json(response, 404, { error: '未知接口' });
  }

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log(`[bridge] 请求失败 ${request.url}：${error.message}`);
      if (!response.headersSent) json(response, status, { error: error.message });
      else response.end();
    });
  });

  return {
    server,
    watcher,
    async listen() {
      const port = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : config.port);
        });
      });
      await watcher.resume();
      return { port, url: `http://${config.host}:${port}` };
    },
    async close() {
      watcher.stop();
      for (const entry of live.values()) entry.transport?.close?.();
      live.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export async function startBridge({ config, drivers, store, log = () => {} }) {
  const bridge = createBridgeServer({ config, drivers, store, log });
  const { url, port } = await bridge.listen();
  return { url, port, ...bridge };
}

export { BridgeStore };
