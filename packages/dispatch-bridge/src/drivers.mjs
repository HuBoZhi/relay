/**
 * Client drivers.
 *
 * The protocol for each desktop app lives in the machine-verified adapter directory
 * (`desktop-native`), not here. This module loads those classes and gives them one
 * shape, so the bridge never grows a second, drifting copy of a client's internals.
 *
 * Everything below uses the Runtime-level interface only: no synthetic input, no
 * DOM operations, no reading of model credentials.
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { PORTS, SUPPORTED_CLIENTS } from './config.mjs';

/** Read-only interface checks, evaluated in the app's own renderer. */
const INTERFACE_PROBES = {
  workbuddy: `(() => {
    try {
      const ok = typeof wb?.conversations?.create === 'function' && typeof wb?.conversations?.get === 'function';
      return { ok, note: 'wb.conversations.create / get' };
    } catch (error) { return { ok: false, note: String(error) }; }
  })()`,
  factory: `(() => {
    try {
      const channel = electronAPI?.daemon;
      const ok = Boolean(channel) && typeof channel.sendMessage === 'function';
      return { ok, note: 'electronAPI.daemon.sendMessage' };
    } catch (error) { return { ok: false, note: String(error) }; }
  })()`,
};

/**
 * Load the adapter classes once.
 *
 * A missing directory is not fatal: the bridge still starts, reports why it cannot
 * dispatch, and can be pointed at an install later without a code change.
 */
export async function loadDrivers(dir, { log = () => {} } = {}) {
  if (!dir) {
    return {
      available: false,
      reason: '未找到 desktop-native 适配器目录；派发会停在已排队',
      classes: {},
      connect: null,
    };
  }
  try {
    const [cdp, clients, factory] = await Promise.all([
      import(pathToFileURL(join(dir, 'cdp.mjs')).href),
      import(pathToFileURL(join(dir, 'native-clients.mjs')).href),
      import(pathToFileURL(join(dir, 'factory.mjs')).href),
    ]);
    const classes = {
      workbuddy: clients.WorkBuddyDesktop,
      zcode: clients.ZCodeDesktop,
      factory: factory.FactoryDesktop,
    };
    for (const client of SUPPORTED_CLIENTS) {
      if (typeof classes[client] !== 'function') throw new Error(`适配器缺少 ${client} 驱动`);
    }
    if (typeof cdp.DesktopIpcTransport?.connect !== 'function') {
      throw new Error('适配器缺少 DesktopIpcTransport.connect');
    }
    return {
      available: true,
      reason: null,
      dir,
      classes,
      connect: (options) => cdp.DesktopIpcTransport.connect(options),
    };
  } catch (error) {
    log(`[bridge] 适配器加载失败：${error.message}`);
    return {
      available: false,
      reason: `适配器加载失败：${error.message}`,
      classes: {},
      connect: null,
    };
  }
}

export function driverFor(drivers, client) {
  if (!drivers.available) return null;
  return drivers.classes[client] ?? null;
}

/**
 * Per-client model wiring.
 *
 * Each app names its model selection differently; the engine's structured
 * `{ account, provider, modelId, reasoning }` is mapped here, once.
 */
export function modelOptionsFor(client, model) {
  if (!model) return undefined;
  if (client === 'zcode') {
    return {
      providerId: model.provider || model.account,
      modelId: model.modelId,
      options: { reasoningLevel: model.reasoning },
    };
  }
  // WorkBuddy and Factory take the workspace at creation time; their model is the
  // app's own selection, so the bridge does not pretend to override it.
  return undefined;
}

/** A workspace path comparison that ignores separators and casing. */
export function sameWorkspace(a, b) {
  const canonical = (value) =>
    String(value ?? '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  return canonical(a) === canonical(b);
}

/**
 * Read-only probe.
 *
 * It answers "is this client reachable and does its interface look present" without
 * creating a session, sending a prompt, or changing any state. A client whose
 * version-specific internals cannot be checked cheaply reports `unverified` rather
 * than a hopeful "supported".
 */
export async function probeClient({ drivers, client, timeoutMs = 5000 }) {
  const port = PORTS[client];
  if (!port) {
    return {
      client,
      ok: false,
      interfaceReady: 'unsupported',
      version: null,
      notes: [],
      error: '不支持的客户端',
    };
  }
  if (!drivers.available) {
    return {
      client,
      ok: false,
      interfaceReady: 'unverified',
      version: null,
      notes: [drivers.reason],
      error: drivers.reason,
    };
  }

  let version = null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`状态码 ${response.status}`);
    const body = await response.json();
    version = typeof body?.Browser === 'string' ? body.Browser : null;
  } catch (error) {
    return {
      client,
      port,
      ok: false,
      interfaceReady: 'unverified',
      version: null,
      notes: [`本机调试端口 ${port} 未开放（${error.message}）`],
      error: `端口 ${port} 未开放：需要以 --remote-debugging-port=${port} 启动该客户端`,
    };
  }

  let transport = null;
  try {
    transport = await drivers.connect({ client, port, timeoutMs });
    const expression = INTERFACE_PROBES[client];
    if (!expression) {
      // ZCode exposes no stable global; its interface is verified at dispatch time
      // through the connected service registry.
      return {
        client,
        port,
        ok: true,
        interfaceReady: 'unverified',
        version,
        notes: ['已连接；接口在派发时通过服务注册表校验'],
        error: null,
      };
    }
    const result = await transport.evaluate(expression);
    return {
      client,
      port,
      ok: result?.ok === true,
      interfaceReady: result?.ok === true ? 'supported' : 'unverified',
      version,
      notes: result?.note ? [String(result.note)] : [],
      error: result?.ok === true ? null : '接口未就绪',
    };
  } catch (error) {
    return {
      client,
      port,
      ok: false,
      interfaceReady: 'unverified',
      version,
      notes: [],
      error: error.message,
    };
  } finally {
    transport?.close?.();
  }
}
