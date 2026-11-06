/**
 * The dispatch bridge, owned by the app.
 *
 * It runs as a child of the shell rather than a separate thing the user has to
 * start: one icon, one installer, one quit. The process boundary is kept on
 * purpose — a client that hangs in CDP or a wedged CLI must not be able to freeze
 * the window — but the lifecycle belongs entirely to the app, and quitting the app
 * takes it down.
 *
 * The child is a real Node process (`ELECTRON_RUN_AS_NODE=1`), so it gets no
 * Electron privileges and cannot show UI of its own.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const DIST = join(import.meta.dirname, '..', 'dist');
const BRIDGE_ENTRY = join(DIST, 'bridge.mjs');
const PORT_ATTEMPTS = 8;

async function healthy(url, timeoutMs = 800) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start the bridge and wait until it answers.
 *
 * Returns `{ url, port, stop }` — or `{ url: null, reason }` when it could not
 * start, in which case the app still opens and dispatch reports "queued" with the
 * reason instead of pretending a bridge exists.
 */
export async function startManagedBridge({
  engineUrl,
  dataDir,
  desktopNativeDir,
  preferredPort = 7901,
  env = process.env,
  log = () => {},
  executablePath = process.execPath,
  signal,
} = {}) {
  let lastError = null;

  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) break;
    const port = preferredPort + attempt;
    const child = spawn(
      executablePath,
      [
        BRIDGE_ENTRY,
        '--port',
        String(port),
        '--engine',
        engineUrl,
        '--data',
        dataDir,
        ...(desktopNativeDir ? ['--desktop-native', desktopNativeDir] : []),
      ],
      {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );

    let exited = false;
    let spawned = false;
    let exitCode = null;
    child.once('spawn', () => { spawned = true; });
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => {
      lastError = error.message;
      exited = true;
      exitCode = -1;
      signal?.removeEventListener('abort', abort);
    });
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) log(`[桥接] ${line.trim()}`);
      }
    });
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) log(`[桥接] ${line.trim()}`);
      }
    });
    child.on('exit', (code) => {
      signal?.removeEventListener('abort', abort);
      exited = true;
      exitCode = code;
    });

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !exited && !signal?.aborted) {
      if (spawned && await healthy(url) && !exited && !signal?.aborted) {
        log(`[桥接] 已随应用启动：${url}`);
        return {
          url,
          port,
          pid: child.pid,
          managed: true,
          async stop() {
            if (exited) return;
            child.kill();
            const until = Date.now() + 3000;
            while (!exited && Date.now() < until) await sleep(50);
            // A wedged client call must not keep the app alive on quit.
            if (!exited) child.kill('SIGKILL');
          },
        };
      }
      await sleep(120);
    }

    // Port already taken by something else: try the next one. Any other failure is
    // reported once and stops the loop.
    const output = exitCode === null ? '未在 10 秒内就绪' : `退出码 ${exitCode}`;
    lastError = exited ? output : '端口无响应';
    if (!exited) child.kill();
    if (exitCode !== 1 && exitCode !== null) break;
  }

  log(`[桥接] 未能启动：${lastError ?? '未知原因'}`);
  return { url: null, port: null, managed: false, reason: lastError ?? '未知原因', async stop() {} };
}
