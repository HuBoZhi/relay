import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT, resolveConfig } from '../lib/config.mjs';
import { buildTrayMenu, formatUpdatedAt, summarize, trayTooltip } from '../lib/tray-menu.mjs';

const bootstrap = {
  channels: [{ name: 'a' }, { name: 'b' }],
  agents: [{ name: 'x' }, { name: 'y' }, { name: 'z' }],
  metrics: { messagesToday: 42 },
  connection: { state: 'live', label: '已连接 · 实时' },
};

describe('resolveConfig', () => {
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
      '更新时间：10:12:37',
    ]);
  });

  it('surfaces a failed read instead of a stale connection label', () => {
    const rows = build({ status: null, error: '本地服务无响应' }).map((item) => item.label);
    expect(rows).toContain('数据连接：本地服务无响应');
    expect(rows).toContain('今日消息：未知');
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
      '协作控制中心 · 演示数据 · 2 个频道'
    );
  });

  it('reports the failure when there is no status', () => {
    expect(trayTooltip({ mode: '只读观察', status: null, error: '本地服务无响应' })).toBe(
      '协作控制中心 · 只读观察 · 本地服务无响应'
    );
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
