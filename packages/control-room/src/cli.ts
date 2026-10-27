#!/usr/bin/env node
/**
 * `relay-control-room` — start the read-only collaboration control room.
 *
 * Credential resolution order matters: an explicit flag, then the control-room
 * specific env var, then the workspace key the rest of the CLI already uses.
 * The value is never echoed back to the terminal, and `--demo` never needs one.
 */

import { resolveTimezone } from './format.js';
import { DemoControlRoomSource } from './demo-source.js';
import { RelayControlRoomSource } from './relay-source.js';
import { startControlRoom } from './server.js';
import type { ControlRoomSource } from './source.js';

interface CliOptions {
  port: number;
  host: string;
  baseUrl?: string;
  token?: string;
  demo: boolean;
  stream: boolean;
  refreshMs?: number;
  allowRemote: boolean;
  help: boolean;
}

const USAGE = `用法：relay-control-room [选项]

只读协作控制中心：在浏览器中观察频道、智能体工作状态与消息流转。
凭据只在本地服务进程内使用，不会下发到浏览器。

选项：
  --port <端口>            监听端口，默认 4320
  --host <地址>            监听地址，默认 127.0.0.1（只允许回环地址）
  --base-url <地址>        Relay 服务地址，默认使用部署配置
  --token <凭据>           工作空间密钥或只读观察者令牌（ot_live_…）
  --refresh-ms <毫秒>      频道与工作状态的刷新间隔，默认 20000
  --no-stream              关闭实时事件流，仅定时刷新
  --demo                   使用演示数据启动，不连接任何服务
  --allow-remote           允许监听非回环地址（凭据可读整个工作空间，请谨慎）
  --help                   显示本说明

环境变量：
  RELAY_CONTROL_ROOM_TOKEN  控制中心专用凭据（优先于 RELAY_WORKSPACE_KEY）
  RELAY_WORKSPACE_KEY / RELAY_API_KEY
  RELAY_CONTROL_ROOM_TZ     界面时区，默认 Asia/Shanghai
`;

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    port: 4320,
    host: '127.0.0.1',
    demo: false,
    stream: true,
    allowRemote: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} 缺少取值`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--port': {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 0 || value > 65535)
          throw new Error('端口必须是 0-65535 的整数');
        options.port = value;
        break;
      }
      case '--host':
        options.host = next();
        break;
      case '--base-url':
        options.baseUrl = next();
        break;
      case '--token':
        options.token = next();
        break;
      case '--refresh-ms': {
        const value = Number(next());
        if (!Number.isFinite(value) || value < 1_000) throw new Error('刷新间隔至少为 1000 毫秒');
        options.refreshMs = Math.trunc(value);
        break;
      }
      case '--no-stream':
        options.stream = false;
        break;
      case '--demo':
        options.demo = true;
        break;
      case '--allow-remote':
        options.allowRemote = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }

  return options;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('使用 --help 查看可用参数。');
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  if (!isLoopback(options.host) && !options.allowRemote) {
    console.error(`拒绝监听 ${options.host}：控制中心持有可读整个工作空间的凭据。`);
    console.error('如确需远程访问，请通过 SSH 隧道转发 127.0.0.1，或显式添加 --allow-remote。');
    process.exitCode = 1;
    return;
  }

  const token =
    options.token?.trim() ||
    process.env.RELAY_CONTROL_ROOM_TOKEN?.trim() ||
    process.env.RELAY_WORKSPACE_KEY?.trim() ||
    process.env.RELAY_API_KEY?.trim();

  if (!options.demo && !token) {
    console.error('未找到凭据：请通过 --token 或 RELAY_CONTROL_ROOM_TOKEN 提供只读观察者令牌，');
    console.error('或使用 --demo 以演示数据启动。');
    process.exitCode = 1;
    return;
  }

  const timezone = resolveTimezone();
  let source: ControlRoomSource;
  let pending: Promise<void> | null = null;
  if (options.demo || !token) {
    source = new DemoControlRoomSource({ timezone });
  } else {
    const relay = new RelayControlRoomSource({
      workspaceKey: token,
      // Omit the field rather than passing `undefined` so the SDK default applies.
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      timezone,
      ...(options.refreshMs ? { refreshIntervalMs: options.refreshMs } : {}),
      disableStream: !options.stream,
    });
    // Bind the port before the first read: a slow or unreachable engine must not
    // delay the URL the operator is waiting on. The page starts on "正在连接"
    // and its own bootstrap call joins the same refresh.
    pending = relay.start();
    source = relay;
  }

  let server;
  try {
    server = await startControlRoom({
      source,
      port: options.port,
      host: options.host,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Kept Chinese-first on purpose: the message the operator reads is a
    // sentence, not a Node errno fragment. The raw string only reaches the
    // terminal when someone is already debugging (RELAY_CONTROL_ROOM_DEBUG).
    console.error(`无法在 ${options.host}:${options.port} 启动服务。`);
    if (/EADDRINUSE/.test(detail)) {
      console.error('该端口已被占用，请用 --port 指定其他端口。');
    } else if (/EACCES/.test(detail)) {
      console.error('当前用户无权监听该端口，请换用大于 1024 的端口。');
    } else {
      console.error('请检查监听地址是否可用。');
    }
    if (process.env.RELAY_CONTROL_ROOM_DEBUG) console.error(detail);
    await source.close().catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('  协作控制中心已启动');
  console.log(`  地址：${server.url}`);
  console.log(
    `  模式：${source.mode === 'demo' ? '演示数据（未连接 Relay 服务）' : `只读观察 · ${source.target}`}`
  );
  console.log(`  时区：${timezone}`);
  console.log('  凭据仅保存在本进程内，不会发送到浏览器。按 Ctrl+C 停止。');
  console.log('');

  // The first read reports its own failures through the source's log hook; keep
  // the promise from floating unhandled.
  if (pending) void pending.catch(() => undefined);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => undefined);
    await source.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('/cli.js') === true;
if (invokedDirectly) {
  void main();
}
