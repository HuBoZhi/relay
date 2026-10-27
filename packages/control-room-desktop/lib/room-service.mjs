/**
 * Starts the control room server inside the desktop process.
 *
 * The server itself is the one the CLI ships (`dist/server.mjs`, bundled from
 * `@agent-relay/control-room`), so the desktop app and `relay-control-room` can
 * never drift apart. Only the lifecycle differs: this module owns the port
 * fallback and the status probe the tray renders.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { summarize } from './tray-menu.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DIST_ROOT = join(HERE, '..', 'dist');

const MAX_PORT_ATTEMPTS = 12;

async function loadServer() {
  return import(pathToFileURL(join(DIST_ROOT, 'server.mjs')).href);
}

/**
 * Bind the first free port from `preferred` upward.
 *
 * A second launch (or another app squatting on 4320) must not leave the user
 * with a dead tray icon, so a busy port moves on instead of failing.
 */
export async function startRoom({ config, log = () => {} }) {
  const server = await loadServer();

  const source = config.demo
    ? new server.DemoControlRoomSource({ timezone: config.timezone })
    : new server.RelayControlRoomSource({
        workspaceKey: config.token,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        timezone: config.timezone,
      });
  const pending = config.demo ? null : source.start();

  let running = null;
  let lastError = null;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS && !running; attempt += 1) {
    const port = config.port + attempt;
    try {
      running = await server.startControlRoom({
        source,
        port,
        host: config.host,
        webRoot: join(DIST_ROOT, 'web'),
        log,
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/EADDRINUSE/i.test(message)) break;
    }
  }

  if (!running) {
    await source.close().catch(() => {});
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      /EADDRINUSE/i.test(detail)
        ? `端口 ${config.port} 起的连续 ${MAX_PORT_ATTEMPTS} 个端口都被占用，请用 --port 指定其他端口。`
        : '无法启动本地服务，请检查监听地址是否可用。'
    );
  }

  // The first live read reports its own failures through the source log; keep
  // the promise from floating unhandled.
  if (pending) void pending.catch(() => {});

  return {
    url: running.url,
    port: running.port,
    mode: config.demo ? '演示数据' : '只读观察',
    target: source.target,
    async close() {
      await running.close().catch(() => {});
      await source.close().catch(() => {});
    },
  };
}

/**
 * Read the room's own status endpoint; a hung read must not freeze the tray.
 *
 * `/api/health` is answered from memory, so it separates "the shell is broken"
 * from "the workspace read is slow or refused" — two very different problems for
 * whoever is looking at the tray.
 */
export async function probe(url, { timeoutMs = 5000 } = {}) {
  if (!url) return { ok: false, error: '本地服务尚未启动' };
  try {
    const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!health.ok) return { ok: false, error: `本地服务异常（状态码 ${health.status}）` };
  } catch {
    return { ok: false, error: '本地服务无响应' };
  }
  try {
    const response = await fetch(`${url}/api/bootstrap`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, error: `读取工作空间失败（状态码 ${response.status}）` };
    const bootstrap = await response.json();
    return { ok: true, status: summarize(bootstrap), at: Date.now() };
  } catch {
    return { ok: false, error: '读取工作空间超时' };
  }
}
