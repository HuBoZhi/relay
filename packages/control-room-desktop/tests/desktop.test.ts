import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MENU_ACTIONS, buildAppMenu, menuActionIds } from '../lib/app-menu.mjs';
import { DEFAULT_PORT, loginItemArgs, loginItemCommand, resolveConfig } from '../lib/config.mjs';
import { buildTrayMenu, formatUpdatedAt, summarize, trayTooltip } from '../lib/tray-menu.mjs';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  mergeSettings,
  normalizeSettings,
  saveSettings,
  SETTINGS_VERSION,
} from '../lib/settings.mjs';

/** A real settings directory: the loader must not be the thing that creates it. */
async function settingsFile() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-desktop-settings-'));
  await mkdir(dir, { recursive: true });
  return join(dir, 'settings.json');
}

const bootstrap = {
  channels: [{ name: 'a' }, { name: 'b' }],
  agents: [{ name: 'x' }, { name: 'y' }, { name: 'z' }],
  metrics: { messagesToday: 42 },
  connection: { state: 'live', label: '已连接 · 实时' },
};

describe('resolveConfig', () => {
  it('starts the native GUI at login while retaining the unified client bootstrap',()=>{
    const config=resolveConfig({argv:['app','--system-launcher','D:/Relay/start.ps1'],env:{RELAY_CONTROL_ROOM_TOKEN:'fixture-key'}});
    const command=loginItemCommand(config,{executable:'app.exe',userDataPath:'D:/profile',windowsScriptHost:'wscript.exe',runtimeRoot:'D:/Relay',consoleDir:'D:/Console'});
    expect(command.path).toBe('app.exe');
    expect(command.args).toContain('--no-window');
    expect(command.args).toContain('D:/Relay/start.ps1');
    expect(command.args).not.toContain('fixture-key');
    expect(loginItemArgs(config,'D:/profile')).toContain('--system-launcher');
  });
  it('reconnects after login without inheriting the launch shell credentials', () => {
    const directory=mkdtempSync(join(tmpdir(),'relay-login-test-'));
    try {
      const stateFile=join(directory,'workspace.private.json');
      writeFileSync(stateFile,JSON.stringify({workspaceKey:'fixture-key'}));
      const original=resolveConfig({argv:['app','--workspace-state',stateFile],env:{}});
      const args=loginItemArgs(original,'D:/Relay Data');
      expect(args).not.toContain('fixture-key');
      const restarted=resolveConfig({argv:['app',...args],env:{}});
      expect(restarted.demo).toBe(false);
      expect(restarted.token).toBe('fixture-key');
      expect(restarted.showWindow).toBe(false);
      writeFileSync(stateFile,JSON.stringify({workspaceKey:'rotated-fixture-key'}));
      expect(resolveConfig({argv:['app',...args],env:{}}).token).toBe('rotated-fixture-key');
    } finally {rmSync(directory,{recursive:true,force:true});}
  });

  it('rejects an unusable configured workspace instead of opening demo data', () => {
    expect(()=>resolveConfig({argv:['app','--workspace-state','D:/missing-relay-state.json'],env:{}})).toThrow('无法读取工作区凭据');
  });
  it('falls back to demo data when no credential exists', () => {
    const config = resolveConfig({ argv: ['electron', '.'], env: {} });
    expect(config.demo).toBe(true);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.host).toBe('127.0.0.1');
  });

  it('uses a read-only token from the environment without marking it as demo', () => {
    const config = resolveConfig({
      argv: ['electron', '.'],
      env: { RELAY_CONTROL_ROOM_TOKEN: 'ot_live_test' },
    });
    expect(config.demo).toBe(false);
    expect(config.tokenSource).toBe('RELAY_CONTROL_ROOM_TOKEN');
  });

  it('prefers the explicit token flag over the environment', () => {
    const config = resolveConfig({
      argv: ['electron', '.', '--token', 'from-flag'],
      env: { RELAY_CONTROL_ROOM_TOKEN: 'from-env' },
    });
    expect(config.token).toBe('from-flag');
    expect(config.tokenSource).toBe('参数');
  });

  it('reads desktop switches and ignores unknown ones', () => {
    const config = resolveConfig({
      argv: ['electron', '.', '--port', '4400', '--demo', '--no-window', '--mystery'],
      env: {},
    });
    expect(config.port).toBe(4400);
    expect(config.demo).toBe(true);
    expect(config.showWindow).toBe(false);
  });

  it('rejects a port that is not a port', () => {
    expect(() => resolveConfig({ argv: ['electron', '.', '--port', 'abc'], env: {} })).toThrow(
      '端口必须是 0-65535 的整数'
    );
  });
});

describe('summarize', () => {
  it('reports the four facts the tray shows', () => {
    expect(summarize(bootstrap)).toEqual({
      channels: 2,
      agents: 3,
      messagesToday: 42,
      connectionLabel: '已连接 · 实时',
      connectionState: 'live',
    });
  });

  it('keeps unknown counts unknown instead of inventing zeros', () => {
    const summary = summarize({ channels: [], agents: [], metrics: { messagesToday: null } });
    expect(summary.messagesToday).toBeNull();
    expect(summary.connectionLabel).toBe('状态未知');
  });

  it('does not report an unreadable workspace as empty', () => {
    const summary = summarize({
      channels: [],
      agents: [],
      metrics: { messagesToday: 0 },
      connection: { state: 'degraded', label: '连接降级' },
    });
    expect(summary.channels).toBeNull();
    expect(summary.agents).toBeNull();
    expect(summary.messagesToday).toBeNull();
    expect(summary.connectionLabel).toBe('连接降级');
  });
});

describe('buildTrayMenu', () => {
  const build = (overrides = {}) =>
    buildTrayMenu({
      mode: '演示数据',
      url: 'http://127.0.0.1:4320',
      status: summarize(bootstrap),
      updatedAt: Date.parse('2026-10-27T02:12:37Z'),
      actions: {},
      ...overrides,
    });

  it('offers the three actions a tray owes the user', () => {
    const labels = build().map((item) => item.label);
    expect(labels[0]).toBe('打开控制中心');
    expect(labels).toContain('复制访问地址');
    expect(labels.at(-1)).toBe('退出');
  });

  it('reports mode, address, connection, workspace, messages, and time', () => {
    const rows = build()
      .filter((item) => item.enabled === false)
      .map((item) => item.label);
    expect(rows).toEqual([
      '运行模式：演示数据',
      '监听地址：127.0.0.1:4320',
      '数据连接：已连接 · 实时',
      '工作空间：2 个频道 · 3 个智能体',
      '今日消息：42 条',
      '任务：未启用',
      '更新时间：10:12:37',
    ]);
  });

  it('shows task counts when the engine reported them', () => {
    const rows = build({
      tasks: { inFlight: 2, awaitingConfirmation: 1, callbacksManual: 0 },
    })
      .filter((item) => item.enabled === false)
      .map((item) => item.label);
    expect(rows).toContain('任务：在途 2 · 待确认 1 · 需人工 0');
  });

  it('offers task workspace and settings without Latin labels', () => {
    const labels = build().map((item) => item.label ?? '');
    expect(labels).toContain('打开群聊');
    expect(labels).toContain('打开任务工作台');
    expect(labels).toContain('设置数据目录与启动行为');
    expect(labels).toContain('缩小到托盘');
  });

  it('surfaces a failed read instead of a stale connection label', () => {
    const rows = build({ status: null, error: '本地服务无响应' }).map((item) => item.label);
    expect(rows).toContain('数据连接：本地服务无响应');
    expect(rows).toContain('今日消息：未知');
  });

  it('does not glue an unknown count to a unit', () => {
    const rows = build({ status: summarize({ channels: null, agents: null }) }).map((item) => item.label);
    expect(rows).toContain('工作空间：频道未知 · 智能体未知');
  });

  it('never prints Latin letters at the operator', () => {
    const labels = build().map((item) => item.label ?? '');
    for (const label of labels) expect(label, label).not.toMatch(/[A-Za-z]/);
  });

  it('disables address actions when the server never started', () => {
    const menu = build({ url: '', status: null, error: '端口被占用' });
    const copy = menu.find((item) => item.label === '复制访问地址');
    expect(copy?.enabled).toBe(false);
  });
});

describe('trayTooltip', () => {
  it('carries the mode and channel count', () => {
    expect(trayTooltip({ mode: '演示数据', status: summarize(bootstrap), error: null })).toBe(
      'Relay系统 · 演示数据 · 2 个频道'
    );
  });

  it('reports the failure when there is no status', () => {
    expect(trayTooltip({ mode: '只读观察', status: null, error: '本地服务无响应' })).toBe(
      'Relay系统 · 只读观察 · 本地服务无响应'
    );
  });

  it('adds the in-flight task count when the engine is mounted', () => {
    expect(
      trayTooltip({
        mode: '演示数据',
        status: summarize(bootstrap),
        error: null,
        tasks: { inFlight: 3 },
      })
    ).toBe('Relay系统 · 演示数据 · 2 个频道 · 在途 3');
  });
});

describe('formatUpdatedAt', () => {
  it('renders Beijing time with a 24-hour clock', () => {
    expect(formatUpdatedAt(Date.parse('2026-10-27T02:12:37Z'))).toBe('10:12:37');
  });

  it('never throws on an unreadable clock', () => {
    expect(formatUpdatedAt('not-a-date')).toBe('--:--:--');
  });
});

describe('buildAppMenu', () => {
  const menu = buildAppMenu({ isPackaged: true });

  it('keeps the four groups the native menu used to have', () => {
    expect(menu.map((group) => group.label)).toEqual(['控制中心', '视图', '窗口', '帮助']);
  });

  it('names every entry in Chinese', () => {
    for (const group of menu) {
      expect(group.label, group.label).not.toMatch(/[A-Za-z]/);
      for (const item of group.items) {
        if (item.type === 'separator') continue;
        expect(item.label, item.label).not.toMatch(/[A-Za-z]/);
      }
    }
  });

  it('hides developer tools from packaged builds', () => {
    const ids = menuActionIds(menu);
    expect(ids).not.toContain('devtools');
    expect(menuActionIds(buildAppMenu({ isPackaged: false }))).toContain('devtools');
  });

  it('only emits actions the shell can run', () => {
    for (const id of menuActionIds(menu)) expect(MENU_ACTIONS, id).toContain(id);
  });

  it('exposes the chat, task workspace, and settings entries', () => {
    const ids = menuActionIds(menu);
    expect(ids).toContain('open-chat');
    expect(ids).toContain('open-tasks');
    expect(ids).toContain('open-settings');
    expect(ids).toContain('open-observer');
  });
});

describe('desktop settings', () => {
  it('defaults to quitting on window close and enabling notifications', () => {
    expect(DEFAULT_SETTINGS.closeToTray).toBe(false);
    expect(DEFAULT_SETTINGS.notifications).toBe(true);
    expect(DEFAULT_SETTINGS.loginAtStartup).toBe(false);
  });

  it('keeps only loopback dispatch bridges', () => {
    const settings = normalizeSettings({
      bridges: [
        { client: 'zcode', url: 'http://127.0.0.1:7900' },
        { client: 'workbuddy', url: 'http://10.0.0.5:7900' },
        { client: '', url: 'http://127.0.0.1:7901' },
      ],
    });
    expect(settings.bridges).toEqual([{ client: 'zcode', url: 'http://127.0.0.1:7900' }]);
  });

  it('survives a missing or corrupt file instead of blocking startup', async () => {
    const path = await settingsFile();
    expect(await loadSettings(path)).toMatchObject({ closeToTray: false, notifications: true });
    await writeFile(path, '{ not json', 'utf8');
    expect(await loadSettings(path)).toMatchObject({ version: SETTINGS_VERSION });
  });

  it('loads Windows UTF-8 BOM preferences and keeps IPv6 HTTP bridges', async () => {
    const path = await settingsFile();
    await writeFile(path, '\uFEFF' + JSON.stringify({ connectors: ['factory'], closeToTray: true }));
    expect(await loadSettings(path)).toMatchObject({ connectors: ['factory'], closeToTray: true });
    expect(normalizeSettings({ bridges: [{ client: 'factory', url: 'http://[::1]:7901' }] }).bridges).toHaveLength(1);
  });

  it('round-trips a saved patch and ignores unknown keys', async () => {
    const path = await settingsFile();
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      closeToTray: true,
      dataRoot: 'D:\\RelayData\\async',
      mystery: 'ignored',
    });
    await saveSettings(path, merged);
    const loaded = await loadSettings(path);
    expect(loaded.closeToTray).toBe(true);
    expect(loaded.dataRoot).toBe('D:\\RelayData\\async');
    expect(loaded).not.toHaveProperty('mystery');
  });
});
