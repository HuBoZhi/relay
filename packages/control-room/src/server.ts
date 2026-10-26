/**
 * The control room HTTP server.
 *
 * Loopback-only by default: this is an observer for one operator's machine, and
 * the credential it holds can read the entire workspace. The browser gets view
 * models over `/api/*` plus an SSE stream; it never receives the credential and
 * cannot reach the Relay API directly, so no CORS surface is opened.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ControlRoomSource } from './source.js';
import type { BootstrapView, MessagePageView, StreamFrame } from './types.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_SSE_CLIENTS = 32;
const HEARTBEAT_MS = 15_000;

export interface ControlRoomServerOptions {
  source: ControlRoomSource;
  port?: number;
  host?: string;
  /** Override the static directory (tests). Defaults to the packaged `web/`. */
  webRoot?: string;
  log?: (message: string) => void;
}

export interface ControlRoomServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function defaultWebRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}

function textError(response: http.ServerResponse, status: number, error: string): void {
  json(response, status, { error });
}

export async function startControlRoom(options: ControlRoomServerOptions): Promise<ControlRoomServer> {
  const { source } = options;
  const host = options.host ?? '127.0.0.1';
  const webRoot = resolve(options.webRoot ?? defaultWebRoot());
  const log = options.log ?? ((message: string) => console.log(message));
  const clients = new Set<http.ServerResponse>();

  const send = (response: http.ServerResponse, frame: StreamFrame): void => {
    try {
      response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    } catch {
      clients.delete(response);
    }
  };

  const unsubscribe = source.subscribe((frame) => {
    for (const client of clients) send(client, frame);
  });

  const heartbeat = setInterval(() => {
    const frame: StreamFrame = { type: 'ping', at: new Date().toISOString() };
    for (const client of clients) send(client, frame);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  async function serveStatic(pathname: string, response: http.ServerResponse): Promise<void> {
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const target = resolve(join(webRoot, relative));
    if (!target.startsWith(webRoot + sep) && target !== webRoot) {
      textError(response, 403, '禁止访问该路径');
      return;
    }
    const type = CONTENT_TYPES[extname(target)];
    if (!type) {
      textError(response, 404, '未找到该文件');
      return;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) {
        textError(response, 404, '未找到该文件');
        return;
      }
      const body = await readFile(target);
      response.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(body);
    } catch {
      textError(response, 404, '未找到该文件');
    }
  }

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      log(`[control-room] 请求失败 ${request.url}: ${String(error)}`);
      if (!response.headersSent) textError(response, 500, '服务器处理请求时出错');
      else response.end();
    });
  });

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const method = request.method ?? 'GET';

    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      textError(response, 405, '不支持的请求方法');
      return;
    }

    if (url.pathname === '/api/health') {
      json(response, 200, { ok: true, mode: source.mode, target: source.target });
      return;
    }

    if (url.pathname === '/api/bootstrap') {
      try {
        const bootstrap: BootstrapView = await source.bootstrap();
        json(response, 200, bootstrap);
      } catch (error) {
        log(`[control-room] 读取概览失败: ${String(error)}`);
        textError(response, 503, '无法读取工作空间数据，请检查凭据与网络');
      }
      return;
    }

    if (url.pathname === '/api/search') {
      const query = url.searchParams.get('q')?.trim() ?? '';
      const channel = url.searchParams.get('channel')?.trim() || undefined;
      if (!query) {
        json(response, 200, { hits: [] });
        return;
      }
      try {
        json(response, 200, { hits: await source.search(query, channel) });
      } catch (error) {
        log(`[control-room] 搜索失败: ${String(error)}`);
        textError(response, 503, '消息搜索暂不可用');
      }
      return;
    }

    if (url.pathname === '/api/stream') {
      if (clients.size >= MAX_SSE_CLIENTS) {
        textError(response, 429, '同时观察的窗口过多，请关闭部分页面后重试');
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.write('retry: 3000\n\n');
      clients.add(response);
      request.on('close', () => {
        clients.delete(response);
      });
      // An immediate frame proves the stream is live before the first event
      // arrives, so the page does not sit on "正在连接" when nothing happens.
      send(response, { type: 'ping', at: new Date().toISOString() });
      return;
    }

    if (url.pathname === '/api/pause' && method === 'POST') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 4_096) {
          textError(response, 413, '请求体过大');
          return;
        }
      }
      let paused = false;
      try {
        paused = Boolean((JSON.parse(body || '{}') as { paused?: unknown }).paused);
      } catch {
        textError(response, 400, '请求体不是合法 JSON');
        return;
      }
      await source.setPaused(paused);
      json(response, 200, { paused });
      return;
    }

    const messageMatch = /^\/api\/messages\/([^/]+)$/.exec(url.pathname);
    if (messageMatch) {
      const id = decodeURIComponent(messageMatch[1] ?? '');
      const message = await source.message(id);
      if (!message) {
        textError(response, 404, '未找到该消息，可能已超出保留范围');
        return;
      }
      json(response, 200, message);
      return;
    }

    const channelMatch = /^\/api\/channels\/([^/]+)\/messages$/.exec(url.pathname);
    if (channelMatch) {
      const channel = decodeURIComponent(channelMatch[1] ?? '');
      const limitRaw = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;
      const page: MessagePageView = await source.messages(channel, {
        limit,
        ...(url.searchParams.get('before') ? { before: url.searchParams.get('before') as string } : {}),
        ...(url.searchParams.get('q') ? { query: url.searchParams.get('q') as string } : {}),
        ...(url.searchParams.get('from') ? { from: url.searchParams.get('from') as string } : {}),
        ...(url.searchParams.get('day') ? { day: url.searchParams.get('day') as string } : {}),
      });
      json(response, 200, page);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      textError(response, 404, '未知的接口');
      return;
    }

    if (method === 'POST') {
      textError(response, 405, '不支持的请求方法');
      return;
    }
    await serveStatic(url.pathname === '/' ? '/index.html' : url.pathname, response);
  }

  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4320, host, () => {
      const address = server.address();
      resolvePort(typeof address === 'object' && address ? address.port : (options.port ?? 4320));
    });
  });

  const url = `http://${host}:${port}`;
  return {
    url,
    port,
    async close() {
      clearInterval(heartbeat);
      unsubscribe();
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
