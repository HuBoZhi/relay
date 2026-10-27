/**
 * CLI/environment resolution for the desktop shell.
 *
 * The desktop app must open straight into a working interface, so the rules are
 * deliberately forgiving: an explicit `--demo`, or no credential at all, means
 * demo data — and the page says so in its notice bar. Nothing is invented on
 * top of a credential: when one exists, the room runs in read-only live mode.
 */

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

  // No credential is not an error for a desktop app: the interface opens on the
  // demo dataset and states that plainly.
  if (!config.token) config.demo = true;

  return config;
}

/** Human-readable run mode; never echoes the credential. */
export function describeMode(config) {
  return config.demo ? '演示数据' : '只读观察';
}
