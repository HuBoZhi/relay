/**
 * HTTP surface for the async engine.
 *
 * Mounted into the same loopback server as the read-only observer so the app has
 * one origin, one port, and no CORS surface. It is a separate handler with its own
 * routes (`/api/async/*`) so "observe" and "act" stay visibly distinct in code and
 * in logs.
 *
 * Two deliberate constraints:
 * - Only JSON POST bodies are accepted. That forces a preflight for any browser
 *   request from another origin, which a page on this machine cannot satisfy.
 * - `Origin`, when present, must match the request host. A page open on some other
 *   site cannot drive task dispatch against the local app.
 */

import type http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { AsyncEngine, AsyncNotFoundError, AsyncValidationError, type EngineEvent } from './engine.js';
import type {
  CreateGroupInput,
  JoinGroupInput,
  PostGroupMessageInput,
  RecordCallbackInput,
  ReportGroupResultInput,
  SubmitTaskInput,
} from './contracts.js';

const MAX_BODY_BYTES = 256 * 1024;

export interface AsyncHttpOptions {
  engine: AsyncEngine;
  log?: (message: string) => void;
  /**
   * Optional shared secret. When set, mutating routes require `X-Relay-Async-Token`.
   * The desktop app leaves this unset — loopback plus JSON-only POST is the
   * boundary — but a shared install can turn it on.
   */
  token?: string;
}

interface Ctx {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  url: URL;
  method: string;
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function fail(response: http.ServerResponse, status: number, error: string, issues?: unknown): void {
  json(response, status, issues ? { error, issues } : { error });
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = String(request.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, '请求必须是 application/json');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) throw new HttpError(400, '请求体为空');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, '请求体必须是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

/** Same-origin guard. A missing header is a non-browser caller (curl, agent). */
function checkOrigin(request: http.IncomingMessage): void {
  const origin = request.headers.origin;
  if (!origin) return;
  const host = request.headers.host;
  try {
    if (host && new URL(origin).host === host) return;
  } catch {
    /* fall through to the rejection below */
  }
  throw new HttpError(403, '拒绝跨站请求');
}

function checkToken(request: http.IncomingMessage, expected: string | undefined): void {
  if (!expected) return;
  const provided = request.headers['x-relay-async-token'];
  const value = Array.isArray(provided) ? provided[0] : provided;
  const left = Buffer.from(String(value ?? ''), 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new HttpError(401, '缺少或错误的访问令牌');
  }
}

export interface AsyncHttpHandler {
  handle(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<boolean>;
}

export function createAsyncHttpHandler(options: AsyncHttpOptions): AsyncHttpHandler {
  const { engine } = options;
  const log = options.log ?? (() => undefined);

  return {
    async handle(request, response, url): Promise<boolean> {
      // Two prefixes: task-level routes and the group chat in front of them.
      if (!url.pathname.startsWith('/api/async') && !url.pathname.startsWith('/api/groups')) return false;
      const method = (request.method ?? 'GET').toUpperCase();
      if (!['GET', 'HEAD', 'POST'].includes(method)) {
        fail(response, 405, '不支持的请求方法');
        return true;
      }
      const ctx: Ctx = { request, response, url, method };
      try {
        if (method === 'POST') {
          checkOrigin(request);
          checkToken(request, options.token);
        }
        await route(ctx, engine);
      } catch (error) {
        if (error instanceof HttpError) {
          fail(response, error.status, error.message);
        } else if (error instanceof AsyncValidationError) {
          fail(response, 400, error.message, error.issues);
        } else if (error instanceof AsyncNotFoundError) {
          fail(response, 404, error.message);
        } else {
          log(`[async] 接口失败 ${url.pathname}：${(error as Error).message}`);
          fail(response, 500, '服务处理任务请求时出错');
        }
      }
      return true;
    },
  };
}

async function route(ctx: Ctx, engine: AsyncEngine): Promise<void> {
  const { url, method } = ctx;
  const path = url.pathname;

  if (method === 'GET' && (path === '/api/async/summary' || path === '/api/async/tasks')) {
    json(ctx.response, 200, await engine.snapshot());
    return;
  }

  if (method === 'GET' && path === '/api/async/clients') {
    const snapshot = await engine.snapshot();
    json(ctx.response, 200, { clients: snapshot.clients });
    return;
  }

  if (method === 'GET' && path === '/api/async/projects') {
    // Ask the client what it already has configured. A project id is an internal
    // handle; the person picking a folder should never have to type one.
    const client = (url.searchParams.get('client') ?? '').trim();
    json(ctx.response, 200, await engine.listProjects(client));
    return;
  }

  if (method === 'GET' && path === '/api/async/models') {
    // The client owns the catalogue: ask it rather than shipping a list here that
    // goes stale the moment the client adds a model.
    const client = (url.searchParams.get('client') ?? '').trim();
    json(ctx.response, 200, await engine.listModels(client));
    return;
  }

  if (method === 'POST' && path === '/api/async/tasks') {
    const body = await readJson(ctx.request);
    const receipt = await engine.submit(body as unknown as SubmitTaskInput);
    // 202: accepted, not finished. The sender ends its turn on this response.
    json(ctx.response, 202, receipt);
    return;
  }

  const taskMatch = /^\/api\/async\/tasks\/([^/]+)$/.exec(path);
  if (method === 'GET' && taskMatch) {
    const detail = await engine.task(decodeURIComponent(taskMatch[1] ?? ''));
    if (!detail) throw new AsyncNotFoundError('未找到该任务');
    json(ctx.response, 200, detail);
    return;
  }

  const cancelMatch = /^\/api\/async\/tasks\/([^/]+)\/cancel$/.exec(path);
  if (method === 'POST' && cancelMatch) {
    const body = await readJson(ctx.request);
    const task = await engine.cancelTask(
      decodeURIComponent(cancelMatch[1] ?? ''),
      typeof body.reason === 'string' ? body.reason : '用户取消'
    );
    json(ctx.response, 200, task);
    return;
  }

  const rebindMatch = /^\/api\/async\/tasks\/([^/]+)\/stages\/([^/]+)\/callback$/.exec(path);
  if (method === 'POST' && rebindMatch) {
    const body = await readJson(ctx.request);
    const task = await engine.rebindCallback(
      decodeURIComponent(rebindMatch[1] ?? ''),
      decodeURIComponent(rebindMatch[2] ?? ''),
      {
        app: String(body.app ?? ''),
        device: String(body.device ?? ''),
        chatId: String(body.chatId ?? ''),
      }
    );
    json(ctx.response, 200, task);
    return;
  }

  if (method === 'POST' && path === '/api/async/callbacks') {
    const body = await readJson(ctx.request);
    const receipt = await engine.recordCallback(body as unknown as RecordCallbackInput);
    // 202: recorded. Delivery into the origin chat is reported separately.
    json(ctx.response, 202, receipt);
    return;
  }

  const retryMatch = /^\/api\/async\/callbacks\/([^/]+)\/retry$/.exec(path);
  if (method === 'POST' && retryMatch) {
    const receipt = await engine.retryCallbackDelivery(decodeURIComponent(retryMatch[1] ?? ''));
    json(ctx.response, 202, receipt);
    return;
  }

  const runStateMatch = /^\/api\/async\/runs\/([^/]+)\/state$/.exec(path);
  if (method === 'POST' && runStateMatch) {
    const body = await readJson(ctx.request);
    const execution = String(body.execution ?? '');
    const allowed = [
      'queued',
      'accepted',
      'running',
      'awaiting-confirmation',
      'blocked',
      'interrupted',
      'failed',
      'turn-ended',
      'unknown',
    ];
    if (!allowed.includes(execution)) {
      throw new HttpError(400, `不支持的执行状态：${execution}`);
    }
    const run = await engine.reportRunState({
      runId: decodeURIComponent(runStateMatch[1] ?? ''),
      execution: execution as Parameters<AsyncEngine['reportRunState']>[0]['execution'],
      detail: typeof body.detail === 'string' ? body.detail : undefined,
    });
    if (!run) throw new AsyncNotFoundError('未找到该执行实例');
    json(ctx.response, 200, run);
    return;
  }

  if (method === 'GET' && path === '/api/groups') {
    json(ctx.response, 200, { groups: await engine.listGroups() });
    return;
  }

  if (method === 'POST' && path === '/api/groups') {
    const body = await readJson(ctx.request);
    const view = await engine.createGroup(body as unknown as CreateGroupInput);
    json(ctx.response, 201, view);
    return;
  }

  const groupMatch = /^\/api\/groups\/([^/]+)$/.exec(path);
  if (method === 'GET' && groupMatch) {
    const view = await engine.group(decodeURIComponent(groupMatch[1] ?? ''));
    if (!view) throw new AsyncNotFoundError('未找到该群');
    json(ctx.response, 200, view);
    return;
  }

  const groupMessages = /^\/api\/groups\/([^/]+)\/messages$/.exec(path);
  const groupDelete = /^\/api\/groups\/([^/]+)\/delete$/.exec(path);
  if (method === 'POST' && groupDelete) {
    await readJson(ctx.request);
    await engine.deleteGroup(decodeURIComponent(groupDelete[1] ?? ''));
    json(ctx.response, 200, { deleted: true });
    return;
  }
  if (method === 'POST' && groupMessages) {
    const body = await readJson(ctx.request);
    const result = await engine.postGroupMessage(
      decodeURIComponent(groupMessages[1] ?? ''),
      body as unknown as PostGroupMessageInput
    );
    // 202: the message is stored and any request it carried was dispatched, but
    // nobody is waiting for the work itself.
    json(ctx.response, 202, result);
    return;
  }

  const groupJoin = /^\/api\/groups\/([^/]+)\/join$/.exec(path);
  if (method === 'POST' && groupJoin) {
    const body = await readJson(ctx.request);
    const result = await engine.joinGroup(
      decodeURIComponent(groupJoin[1] ?? ''),
      body as unknown as JoinGroupInput
    );
    json(ctx.response, 200, result);
    return;
  }

  const groupResults = /^\/api\/groups\/([^/]+)\/results$/.exec(path);
  if (method === 'POST' && groupResults) {
    const body = await readJson(ctx.request);
    const result = await engine.reportGroupResult(
      decodeURIComponent(groupResults[1] ?? ''),
      body as unknown as ReportGroupResultInput
    );
    json(ctx.response, 202, result);
    return;
  }

  const probeMatch = /^\/api\/async\/clients\/([^/]+)\/probe$/.exec(path);
  if (method === 'POST' && probeMatch) {
    const client = await engine.probeClient(decodeURIComponent(probeMatch[1] ?? ''));
    json(ctx.response, 200, client);
    return;
  }

  throw new HttpError(404, '未知的任务接口');
}

/** Shape pushed to the browser over SSE. One frame per engine event. */
export function asyncStreamFrame(event: EngineEvent): { type: 'async'; event: EngineEvent } {
  return { type: 'async', event };
}
