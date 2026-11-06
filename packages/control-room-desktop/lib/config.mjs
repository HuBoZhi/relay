/**
 * CLI/environment resolution for the desktop shell.
 *
 * The desktop app must open straight into a working interface, so the rules are
 * deliberately forgiving: an explicit `--demo`, or no credential at all, means
 * demo data — and the page says so in its notice bar. Nothing is invented on
 * top of a credential: when one exists, the room runs in read-only live mode.
 */

import { readFileSync } from 'node:fs';

const CREDENTIAL_ENV = ['RELAY_CONTROL_ROOM_TOKEN', 'RELAY_WORKSPACE_KEY', 'RELAY_API_KEY'];

/** Strip the launcher's own argv entries so flags work in dev and packaged builds. */
function userArgs(argv) {
  const rest = argv.slice(1);
  if (rest[0] === '.' || (rest[0] && rest[0].endsWith('main.mjs'))) rest.shift();
  return rest;
}

export const DEFAULT_PORT = 4320;

export function resolveConfig({ argv = process.argv, env = process.env } = {}) {
  const args = userArgs(argv);
  const config = {
    demo: false,
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    baseUrl: undefined,
    token: undefined,
    tokenSource: null,
    timezone: env.RELAY_CONTROL_ROOM_TZ?.trim() || 'Asia/Shanghai',
    showWindow: true,
    smoke: false,
    screenshotPath: null,
    workspaceStateFile: env.RELAY_CONTROL_ROOM_STATE_FILE?.trim() || null,
    systemLauncher: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${arg} 缺少取值`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--port': {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 0 || value > 65535)
          throw new Error('端口必须是 0-65535 的整数');
        config.port = value;
        break;
      }
      case '--host':
        config.host = next();
        break;
      case '--base-url':
        config.baseUrl = next();
        break;
      case '--token':
        config.token = next();
        config.tokenSource = '参数';
        break;
      case '--workspace-state':
        config.workspaceStateFile = next();
        break;
      case '--system-launcher':
        config.systemLauncher = next();
        break;
      case '--demo':
        config.demo = true;
        break;
      case '--no-window':
        config.showWindow = false;
        break;
      case '--smoke':
        config.smoke = true;
        break;
      case '--capture':
        config.screenshotPath = next();
        break;
      default:
        // Unknown flags are ignored rather than fatal: a launcher shortcut may
        // carry switches this build does not know about.
        break;
    }
  }

  if (!config.token) {
    for (const name of CREDENTIAL_ENV) {
      const value = env[name]?.trim();
      if (value) {
        config.token = value;
        config.tokenSource = name;
        break;
      }
    }
  }

  if (!config.token && config.workspaceStateFile && !config.demo) {
    try {
      const state = JSON.parse(readFileSync(config.workspaceStateFile, 'utf8').replace(/^\uFEFF/, ''));
      if (typeof state.workspaceKey !== 'string' || !state.workspaceKey.trim()) throw new Error();
      config.token = state.workspaceKey.trim();
      config.tokenSource = '工作区状态文件';
    } catch {
      throw new Error('无法读取工作区凭据，请检查状态文件的路径、格式和权限。');
    }
  }

  // No credential is not an error for a desktop app: the interface opens on the
  // demo dataset and states that plainly.
  if (!config.token) config.demo = true;

  return config;
}

/** Persist paths and view settings, never credentials, in the Windows login entry. */
export function loginItemArgs(config, userDataPath) {
  const args = ['--no-window', '--port', String(config.port), '--host', config.host,
    '--user-data-dir', userDataPath];
  if (config.workspaceStateFile) args.push('--workspace-state', config.workspaceStateFile);
  if (config.systemLauncher) args.push('--system-launcher', config.systemLauncher);
  if (config.baseUrl) args.push('--base-url', config.baseUrl);
  if (config.demo) args.push('--demo');
  return args;
}

export function loginItemCommand(config, { executable, userDataPath }) {
  // Windows login launches the GUI directly. Never attach it to a script host or
  // console; client bootstrap is a hidden, finite child of the running app.
  return { path: executable, args: loginItemArgs(config, userDataPath).map((arg) =>
    /\s/.test(arg) ? `"${arg}"` : arg) };
}

/** Human-readable run mode; never echoes the credential. */
export function describeMode(config) {
  return config.demo ? '演示数据' : '只读观察';
}
