/**
 * Renderer smoke test.
 *
 * The front end is plain script tags and DOM strings, so the fastest honest
 * check is to load the real `web/` bundle in jsdom against a real server and
 * assert what an operator would see. This catches the failure mode unit tests
 * miss: view models that are fine in JSON but render as blanks.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import { DemoControlRoomSource } from '../demo-source.js';
import type { ControlRoomServer } from '../server.js';
import { startHttpTestServer } from './http-test-server.js';
import type { BootstrapView, ControlRoomSource, MessagePageView } from '../types.js';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

interface Rendered {
  window: JSDOM['window'];
  text(selector: string): string;
  count(selector: string): number;
  click(selector: string): void;
  close(): void;
}

async function render(baseUrl: string): Promise<Rendered> {
  const html = await (await fetch(`${baseUrl}/`)).text();
  const dom = new JSDOM(html, { url: `${baseUrl}/`, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const base = baseUrl;
  window.fetch = ((input: string | URL, init?: RequestInit) =>
    fetch(new URL(String(input), base), init)) as never;
  // Node fetch and its abort signal must use the same realm in this harness.
  window.AbortController = AbortController as never;
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  // stdlib jsdom has no EventSource; the page degrades to polling-free rendering.
  window.EventSource = class {
    addEventListener() {}
    close() {}
    onopen: unknown = null;
    onerror: unknown = null;
  } as never;
  (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

  for (const file of ['icons.js', 'api.js', 'app.js']) {
    window.eval(readFileSync(resolve(WEB_ROOT, file), 'utf8'));
  }

  // Give boot() and the message fetch a chance to settle.
  await new Promise((settle) => setTimeout(settle, 400));

  return {
    window,
    text(selector: string) {
      return window.document.querySelector(selector)?.textContent?.trim() ?? '';
    },
    count(selector: string) {
      return window.document.querySelectorAll(selector).length;
    },
    click(selector: string) {
      const element = window.document.querySelector(selector);
      element?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as never);
    },
    close() {
      window.close();
    },
  };
}

describe('control room renderer', () => {
  let server: ControlRoomServer | null = null;
  let source: ControlRoomSource | null = null;
  let view: Rendered | null = null;

  afterEach(async () => {
    view?.close();
    view = null;
    await server?.close();
    await source?.close();
    server = null;
    source = null;
  });

  it('renders channels, metrics, topology, and messages from demo data', async () => {
    source = new DemoControlRoomSource({ tickMs: 600_000 });
    server = await startHttpTestServer({ source, log: () => {} });
    view = await render(server.url);

    expect(view.count('#channel-list [data-channel]')).toBe(8);
    expect(view.text('#channel-total')).toBe('08');
    expect(view.text('#filter-count-warning')).toBe('1');
    expect(view.text('#metric-channels-working')).toMatch(/^\d+$/);
    expect(view.text('#metric-agents-running')).toMatch(/^\d+$/);
    expect(view.count('#network [data-graph-channel]')).toBe(8);
    // The global map expands members only for the selected channel.
    expect(view.count('#network [data-graph-agent]')).toBe(Number(view.text('#agent-count')));
    expect(view.count('#traffic-chart i')).toBe(12);
    expect(view.count('#recent-activity [data-activity-message]')).toBeGreaterThan(0);

    // The detail panel follows the default selection.
    expect(view.text('.channel-title h2')).toContain('#');
    expect(view.text('.channel-status')).toMatch(/工作中|待关注|等待|空闲|已归档|未知|近期有消息/);
    expect(view.text('.state-evidence')).toContain('依据');

    const messages = view.count('#message-timeline .message');
    expect(messages, view.text('#message-timeline')).toBeGreaterThan(0);
    expect(view.text('#message-timeline .message-meta time')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(view.text('.message-read')).toMatch(/已读|读取状态未知|已入队/);
    expect(view.text('#connection-chip-text')).toContain('演示数据');

    // Channel switching keeps the message panel in sync.
    view.click('#channel-list [data-channel="engineering"]');
    await new Promise((settle) => setTimeout(settle, 300));
    expect(view.text('.channel-title h2')).toContain('工程研发');
    expect(view.window.document.querySelector('#agents-panel')?.hidden).toBe(true);
    view.click('#agents-tab');
    await new Promise((settle) => setTimeout(settle, 200));
    expect(view.count('.agent-card')).toBeGreaterThan(0);
    expect(view.text('.agent-meta')).toMatch(/主机|未知/);
  }, 20_000);

  it('does not present an unreachable workspace as healthy', async () => {
    // A source that failed its reads: empty data, explicit degraded transport.
    source = {
      mode: 'live',
      target: '127.0.0.1:45999',
      async bootstrap(): Promise<BootstrapView> {
        return {
          mode: 'live',
          generatedAt: new Date().toISOString(),
          timezone: 'Asia/Shanghai',
          workspace: { id: null, name: 'relay', displayName: '工作空间', description: '' },
          connection: {
            state: 'degraded',
            label: '连接降级',
            detail: '读取工作空间失败，正在重试',
            target: '127.0.0.1:45999',
            mode: 'live',
            lastEventAt: null,
            lastRefreshAt: null,
            cursor: null,
            bufferedEvents: 0,
          },
          channels: [],
          agents: [],
          nodes: [],
          metrics: {
            channelsWorking: null,
            channelsAttention: null,
            channelsTotal: 0,
            agentsRunning: null,
            agentsOnline: null,
            agentsTotal: 0,
            messagesToday: null,
            messagesTodayPartial: false,
            throughput: null,
          },
          recentMessages: [],
          capabilities: { sessionEvents: false, hostPlacement: false, search: false, streaming: false },
          notice: '读取工作空间失败，请检查 Relay 地址、凭据与网络；恢复后会自动重试',
        };
      },
      async messages(channel: string): Promise<MessagePageView> {
        return { channel, messages: [], nextBefore: null, hasMore: false, total: 0 };
      },
      async message() {
        return null;
      },
      async search() {
        return [];
      },
      subscribe() {
        return () => {};
      },
      async setPaused() {},
      async close() {},
    } as ControlRoomSource;

    server = await startHttpTestServer({ source, log: () => {} });
    view = await render(server.url);

    expect(view.text('#connection-chip-text')).not.toContain('实时');
    expect(view.text('#connection-bar-text')).toContain('读取工作空间失败');
    expect(view.text('#notice-bar-text')).toContain('检查 Relay 地址');
    // Unknown must read as a placeholder, not as a zero.
    expect(view.text('#metric-channels-working')).toBe('--');
    expect(view.text('#metric-agents-running')).toBe('--');
    expect(view.text('#metric-messages-today')).toBe('--');
    expect(view.text('#traffic-chart')).toContain('暂无数据');
    expect(view.text('#channel-list')).toContain('暂无可见频道');
  }, 20_000);
});
