/**
 * Desktop settings, kept as one small JSON file.
 *
 * Everything the app writes about *tasks* lives under the data root the user
 * picks (and that root should be a data drive). This file is different: it is the
 * bootstrap record that says where the data root is, so it cannot live inside it.
 * Electron's `userData` is the standard place for that, it holds no task text and
 * no credentials, and it is the only file the shell writes outside the data root.
 *
 * Defaults follow the product decisions: closing the window quits the app, no
 * launch-at-login, notifications on. "Close to tray" is available but never
 * assumed.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  /** `null` means "let the engine choose a data drive". */
  dataRoot: null,
  /** Closing the window quits unless the user asks for tray behaviour. */
  closeToTray: false,
  notifications: true,
  loginAtStartup: false,
  /** Clients the built-in bridge serves. Empty disables the bridge entirely. */
  connectors: ['zcode', 'workbuddy'],
  /** Port the built-in bridge prefers; it moves on if the port is taken. */
  bridgePort: 7901,
  zcodeTransport: 'desktop',
  zcodeMcpConfig: 'D:/Programs/AgentRelay/zcode-mcp/relay-config.json',
  /** Extra bridges the user runs themselves: `{ client, url }`, loopback only. */
  bridges: [],
});

function isLoopback(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** Coerce a loaded object into a usable shape; unknown keys are dropped. */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const bridges = Array.isArray(source.bridges)
    ? source.bridges
        .filter((entry) => entry && typeof entry.client === 'string' && typeof entry.url === 'string')
        .filter((entry) => isLoopback(entry.url))
        .map((entry) => ({ client: entry.client.trim(), url: entry.url.trim() }))
        .filter((entry) => entry.client.length > 0)
    : [];
  const connectors = Array.isArray(source.connectors)
    ? [...new Set(source.connectors.map((value) => String(value).trim()).filter(Boolean))]
    : [...DEFAULT_SETTINGS.connectors];
  const bridgePort = Number(source.bridgePort);
  return {
    version: SETTINGS_VERSION,
    dataRoot: typeof source.dataRoot === 'string' && source.dataRoot.trim() ? source.dataRoot.trim() : null,
    closeToTray: source.closeToTray === true,
    notifications: source.notifications !== false,
    loginAtStartup: source.loginAtStartup === true,
    connectors,
    bridgePort: Number.isInteger(bridgePort) && bridgePort >= 1024 && bridgePort <= 65535 ? bridgePort : 7901,
    bridges,
    zcodeTransport: source.zcodeTransport === 'mcp' ? 'mcp' : 'desktop',
    zcodeMcpConfig: typeof source.zcodeMcpConfig === 'string' && source.zcodeMcpConfig.trim() ? source.zcodeMcpConfig.trim() : DEFAULT_SETTINGS.zcodeMcpConfig,
  };
}

export async function loadSettings(file) {
  try {
    const raw = await readFile(file, 'utf8');
    return normalizeSettings(JSON.parse(raw.replace(/^\uFEFF/, '')));
  } catch {
    // A missing or unreadable settings file must not stop the app from opening.
    return { ...DEFAULT_SETTINGS, bridges: [] };
  }
}

export async function saveSettings(file, settings) {
  const normalized = normalizeSettings(settings);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await rename(temp, file);
  return normalized;
}

/**
 * Merge a patch onto current settings.
 *
 * Only keys the settings page owns may change; a stray field from a renderer must
 * not be able to point the app at another data root by accident.
 */
export function mergeSettings(current, patch) {
  const next = { ...normalizeSettings(current) };
  if (!patch || typeof patch !== 'object') return next;
  if ('dataRoot' in patch) {
    const value = patch.dataRoot;
    if (typeof value === 'string' && value.trim()) {
      if (!isAbsolute(value.trim())) throw new Error('请选择完整的任务数据目录路径。');
      if (/^C:[\\/]/i.test(value.trim())) throw new Error('请选择 D 盘或其他非 C 盘的数据目录。');
      let ancestor = resolve(value.trim());
      while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
      if (existsSync(ancestor) && /^C:[\\/]/i.test(realpathSync(ancestor))) {
        throw new Error('此目录实际指向 C 盘，请选择其他位置。');
      }
    }
    next.dataRoot = typeof value === 'string' && value.trim() ? resolve(value.trim()) : null;
  }
  if ('closeToTray' in patch) next.closeToTray = patch.closeToTray === true;
  if ('zcodeTransport' in patch) next.zcodeTransport = patch.zcodeTransport === 'mcp' ? 'mcp' : 'desktop';
  if ('zcodeMcpConfig' in patch && typeof patch.zcodeMcpConfig === 'string') next.zcodeMcpConfig = patch.zcodeMcpConfig.trim();
  if ('notifications' in patch) next.notifications = patch.notifications !== false;
  if ('loginAtStartup' in patch) next.loginAtStartup = patch.loginAtStartup === true;
  if ('connectors' in patch && Array.isArray(patch.connectors)) {
    next.connectors = [...new Set(patch.connectors.map((value) => String(value).trim()).filter(Boolean))];
  }
  if ('bridgePort' in patch) {
    const port = Number(patch.bridgePort);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) next.bridgePort = port;
  }
  if ('bridges' in patch && Array.isArray(patch.bridges)) {
    next.bridges = normalizeSettings({ bridges: patch.bridges }).bridges;
  }
  if (next.zcodeTransport === 'mcp' && (!next.zcodeMcpConfig || !isAbsolute(next.zcodeMcpConfig))) {
    throw new Error('请选择 ZCode MCP 配置文件的完整路径。');
  }
  return next;
}
