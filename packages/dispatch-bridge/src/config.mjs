/**
 * Bridge configuration.
 *
 * Three things must be explicit and are refused when wrong:
 *
 * - The engine address, because a bridge that guesses the port reports results to
 *   nothing and looks healthy while doing it.
 * - The adapter directory, because the client protocol lives with the adapter that
 *   was verified on this machine, not in this package.
 * - The data directory, which holds session ids and pending runs and must stay off
 *   the system drive.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_PORT = 7900;

/** Local debug ports each desktop client listens on. Loopback only, by design. */
export const PORTS = Object.freeze({ workbuddy: 19371, zcode: 19372, factory: 19373 });

export const SUPPORTED_CLIENTS = Object.freeze(['workbuddy', 'zcode', 'factory']);

export function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return (
      ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)
    );
  } catch {
    return false;
  }
}

function isSystemDrive(path) {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const system = (process.env.SystemDrive || 'C:').replace(/\\/g, '/').toLowerCase();
  return normalized === system || normalized.startsWith(`${system}/`);
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return resolve(candidate);
  }
  return null;
}

export function resolveBridgeConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const config = {
    port: Number(env.RELAY_BRIDGE_PORT || DEFAULT_PORT),
    host: '127.0.0.1',
    engineUrl: env.RELAY_BRIDGE_ENGINE?.trim() || 'http://127.0.0.1:4320',
    engineToken: env.RELAY_BRIDGE_ENGINE_TOKEN?.trim() || null,
    desktopNativeDir: env.RELAY_DESKTOP_NATIVE_DIR?.trim() || 'D:/Programs/AgentRelay/desktop-native',
    dataDir: env.RELAY_BRIDGE_DATA?.trim() || 'D:/RelayData/bridge',
    pollMs: Number(env.RELAY_BRIDGE_POLL_MS || 2000),
    timeoutMs: Number(env.RELAY_BRIDGE_TIMEOUT_MS || 60 * 60 * 1000),
    help: false,
  };

  const next = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} 缺少取值`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--port':
        config.port = Number(next(index, flag));
        index += 1;
        break;
      case '--engine':
        config.engineUrl = next(index, flag);
        index += 1;
        break;
      case '--engine-token':
        config.engineToken = next(index, flag);
        index += 1;
        break;
      case '--desktop-native':
        config.desktopNativeDir = next(index, flag);
        index += 1;
        break;
      case '--data':
        config.dataDir = next(index, flag);
        index += 1;
        break;
      case '--poll-ms':
        config.pollMs = Number(next(index, flag));
        index += 1;
        break;
      case '--timeout-ms':
        config.timeoutMs = Number(next(index, flag));
        index += 1;
        break;
      case '--help':
      case '-h':
        config.help = true;
        break;
      default:
        throw new Error(`未知参数：${flag}`);
    }
  }

  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error('端口必须是 1024-65535 的整数');
  }
  if (!isLoopbackUrl(config.engineUrl)) {
    throw new Error('引擎地址必须是本机回环地址，例如 http://127.0.0.1:4320');
  }
  if (!Number.isFinite(config.pollMs) || config.pollMs < 250) {
    throw new Error('轮询间隔至少 250 毫秒');
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 60_000) {
    throw new Error('超时至少 60000 毫秒');
  }
  if (isSystemDrive(resolve(config.dataDir))) {
    throw new Error(`桥接数据目录不能位于系统盘：${config.dataDir}`);
  }

  config.engineUrl = config.engineUrl.replace(/\/+$/, '');
  config.dataDir = resolve(config.dataDir);
  config.desktopNativeDir = firstExisting([config.desktopNativeDir]) ?? null;
  return config;
}

/** One-screen summary for the startup log; never prints a token. */
export function describeConfig(config) {
  return [
    `监听：http://${config.host}:${config.port}`,
    `引擎：${config.engineUrl}`,
    `适配器：${config.desktopNativeDir ?? '不可用（未安装 desktop-native）'}`,
    `数据：${config.dataDir}`,
    `轮询：${config.pollMs} ms · 超时 ${Math.round(config.timeoutMs / 60000)} 分钟`,
  ].join(' · ');
}

export const USAGE = `用法：relay-dispatch-bridge [选项]

本机派发桥接：把引擎的派发请求交给桌面客户端，并在本轮结束后回报结果。

选项：
  --port <端口>              监听端口，默认 7900（只允许回环地址）
  --engine <地址>            任务引擎地址，默认 http://127.0.0.1:4320
  --engine-token <令牌>      引擎写接口令牌（引擎设置了 X-Relay-Async-Token 时需要）
  --desktop-native <目录>    客户端适配器目录，默认取已安装的 desktop-native
  --data <目录>              会话与在途记录目录，必须在非系统盘
  --poll-ms <毫秒>           原生轮次检查间隔，默认 2000
  --timeout-ms <毫秒>        单轮等待上限，默认 3600000
  --help                     显示本说明

桥接只使用客户端的 Runtime 级本机接口；不模拟键鼠，不操作 DOM，不读取模型凭据。
`;
