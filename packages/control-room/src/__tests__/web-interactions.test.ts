import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DemoControlRoomSource } from '../demo-source.js';
import type { MessagePageView, StreamFrame } from '../types.js';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const settle = () => new Promise((done) => setTimeout(done, 0));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('control room interaction regressions', () => {
  let dom: JSDOM;
  let source: DemoControlRoomSource;

  afterEach(async () => {
    dom?.window.close();
    await source?.close();
  });

  async function setup(mode = 'demo') {
    source = new DemoControlRoomSource({ tickMs: 600_000 });
    const data = await source.bootstrap();
    data.mode = mode as typeof data.mode;
    dom = new JSDOM(readFileSync(resolve(web, 'index.html'), 'utf8'), {
      url: 'http://localhost/',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    window.matchMedia = (() => ({ matches: false, addEventListener() {} })) as never;
    let stream!: { onFrame: (name: string, frame: unknown) => void; onStatus: (status: string) => void };
    const api = {
      bootstrap: vi.fn(async () => structuredClone(data)),
      messages: vi.fn((name: string) => source.messages(name, { limit: 40 })),
      pause: vi.fn(async () => {}),
      stream: vi.fn((callbacks: typeof stream) => {
        stream = callbacks;
        return { close() {} };
      }),
    };
    Object.assign(window, { RelayApi: api });
    window.eval(readFileSync(resolve(web, 'icons.js'), 'utf8'));
    window.eval(readFileSync(resolve(web, 'app.js'), 'utf8'));
    await settle();
    const element = (selector: string) => window.document.querySelector(selector) as HTMLElement;
    const click = (selector: string) => element(selector).click();
    const text = (selector: string) => element(selector).textContent || '';
    const frame = (value: StreamFrame) => stream.onFrame(value.type, value);
    return { api, data, stream, element, click, text, frame };
  }

  it('loads the newly selected channel while the old request is pending and ignores late failures', async () => {
    const ui = await setup();
    const slow = deferred<MessagePageView>();
    ui.api.messages.mockImplementationOnce(() => slow.promise);
    ui.click('[data-channel="engineering"]');
    ui.click('[data-channel="research"]');
    await settle();
    expect(ui.text('.channel-title')).toContain('研究分析');
    expect(ui.element('#message-timeline').querySelectorAll('.message').length).toBeGreaterThan(0);
    slow.reject(new Error('旧频道请求失败'));
    await settle();
    expect(ui.text('#message-timeline')).not.toContain('旧频道请求失败');
    expect(ui.element('#message-timeline').getAttribute('aria-busy')).toBe('false');
  });

  it('does not let an older request for the same channel replace a newer snapshot', async () => {
    const ui = await setup();
    const slow = deferred<MessagePageView>();
    ui.api.messages.mockImplementationOnce(() => slow.promise);
    ui.click('[data-channel="engineering"]');
    ui.click('[data-channel="research"]');
    ui.click('[data-channel="engineering"]');
    await settle();
    const before = ui.text('#message-timeline');
    slow.resolve({ channel: 'engineering', messages: [], nextBefore: null, hasMore: false, total: 0 });
    await settle();
    expect(ui.text('#message-timeline')).toBe(before);
  });

  it('shows a browser transport failure and refreshes after reconnect', async () => {
    const ui = await setup();
    ui.stream.onStatus('error');
    expect(ui.text('#connection-chip-text')).toBe('重连中');
    expect(ui.text('#connection-bar-text')).toContain('浏览器与本地服务');
    expect(ui.element('#connection-bar').hidden).toBe(false);
    ui.stream.onStatus('open');
    await settle();
    expect(ui.api.bootstrap).toHaveBeenCalledTimes(2);
    expect(ui.element('#connection-bar').hidden).toBe(true);
  });

  it('pauses only this observer and ignores bootstrap frames until resumed', async () => {
    const ui = await setup();
    ui.click('#live-toggle');
    expect(ui.text('#connection-chip-text')).toBe('观察已暂停');
    expect(ui.api.pause).not.toHaveBeenCalled();
    ui.frame({ type: 'bootstrap', bootstrap: { ...ui.data, channels: [] } });
    expect(ui.element('#channel-list').querySelectorAll('[data-channel]')).toHaveLength(8);
    ui.click('#live-toggle');
    await settle();
    expect(ui.api.bootstrap).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed refresh visible instead of claiming healthy realtime data', async () => {
    const ui = await setup();
    ui.api.bootstrap.mockRejectedValueOnce(new Error('快照读取失败'));
    ui.stream.onStatus('error');
    ui.stream.onStatus('open');
    await settle();
    expect(ui.text('#connection-chip-text')).toBe('刷新失败');
    expect(ui.text('#connection-bar-text')).toContain('快照读取失败');
    expect(ui.element('#connection-bar').hidden).toBe(false);
  });

  it('does not apply a refresh that completes after the observer pauses', async () => {
    const ui = await setup();
    const slow = deferred<typeof ui.data>();
    ui.api.bootstrap.mockImplementationOnce(() => slow.promise);
    ui.stream.onStatus('error');
    ui.stream.onStatus('open');
    ui.click('#live-toggle');
    slow.resolve({ ...ui.data, channels: [] });
    await settle();
    expect(ui.element('#channel-list').querySelectorAll('[data-channel]')).toHaveLength(8);
    expect(ui.text('#connection-chip-text')).toBe('观察已暂停');
  });

  it('counts duplicate message frames once and clears pending notices when switching channels', async () => {
    const ui = await setup();
    ui.click('[data-channel="engineering"]');
    await settle();
    const message = { ...(await source.messages('engineering', { limit: 1 })).messages[0]!, id: 'new-event' };
    const count = Number(ui.text('#metric-messages-today'));
    ui.element('#message-timeline').scrollTop = 100;
    ui.frame({ type: 'message', message });
    ui.frame({ type: 'message', message });
    expect(Number(ui.text('#metric-messages-today'))).toBe(count + 1);
    expect(ui.text('#pending-messages')).toContain('1 条新消息');
    ui.click('[data-channel="research"]');
    await settle();
    expect(ui.element('#pending-messages')).toBeNull();
  });

  it('preserves an event arriving during the initial history fetch', async () => {
    const ui = await setup();
    const slow = deferred<MessagePageView>();
    const page = await source.messages('engineering', { limit: 40 });
    ui.api.messages.mockImplementationOnce(() => slow.promise);
    ui.click('[data-channel="engineering"]');
    const message = { ...page.messages[0]!, id: 'during-fetch', text: '请求期间的新消息' };
    ui.frame({ type: 'message', message });
    slow.resolve(page);
    await settle();
    expect(ui.text('#message-timeline')).toContain('请求期间的新消息');
  });

  it('opens archived history without hiding it behind the today filter', async () => {
    const ui = await setup();
    const archive = ui.data.channels.find((channel) => channel.archived)!;
    ui.click(`[data-channel="${archive.name}"]`);
    await settle();
    expect((ui.element('#date-filter') as HTMLSelectElement).value).toBe('all');
    expect(ui.element('#message-timeline').querySelectorAll('.message').length).toBeGreaterThan(0);
  });

  it('loads a fallback channel when the current channel disappears', async () => {
    const ui = await setup();
    ui.click('[data-channel="engineering"]');
    await settle();
    const channels = ui.data.channels.filter((channel) => channel.name !== 'engineering');
    ui.frame({
      type: 'agents',
      channels,
      agents: ui.data.agents,
      metrics: ui.data.metrics,
      connection: ui.data.connection,
    });
    await settle();
    expect(ui.text('.channel-title')).toContain(channels[0]!.displayName);
    expect(ui.api.messages).toHaveBeenLastCalledWith(channels[0]!.name, expect.anything());
  });

  it('does not animate synthetic deliveries in live mode', async () => {
    const ui = await setup('live');
    expect(ui.element('#network').querySelectorAll('.packet')).toHaveLength(0);
    expect(ui.element('#network').querySelectorAll('[marker-end]')).toHaveLength(0);
    expect(ui.text('.legend-flow')).toBe('成员关系');
    ui.click('[data-view="channel"]');
    expect(ui.element('#network').querySelectorAll('.packet')).toHaveLength(0);
  });
});
