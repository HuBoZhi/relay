/**
 * The task workspace in a DOM.
 *
 * Two things are worth locking here: the page must not upgrade a queued receipt
 * into "已送达", and a rejected submit must show the server's field-level issues
 * instead of silently keeping a previous target.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const settle = () => new Promise((done) => setTimeout(done, 0));

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function summaryFixture(overrides: Record<string, unknown> = {}) {
  const now = '2026-11-04T07:00:00.000Z';
  return {
    generatedAt: now,
    dataRoot: 'D:\\RelayData\\async',
    warnings: [],
    topics: [
      {
        id: 'top_1',
        name: '20261104-MediaDock-需求开发2',
        slug: '20261104-mediadock-2',
        channel: null,
        createdAt: now,
      },
    ],
    tasks: [
      {
        id: 'task_1',
        topicId: 'top_1',
        title: '实现内容主题替换',
        body: '正文',
        authorization: { scopes: ['develop'], allowChain: true },
        origin: {
          app: 'codex',
          device: 'desktop-01',
          chatId: 'chat_original_7',
          senderId: 'agent',
          workflowIds: [],
        },
        correlationId: 'task_1',
        stageIds: ['stg_1'],
        runIds: ['run_1'],
        callbackIds: [],
        messageIds: [],
        status: {
          transport: { state: 'local-saved', at: now, source: 'test' },
          execution: { state: 'queued', at: now, source: 'test' },
          business: { state: 'unconfirmed', at: now, source: 'test' },
          callback: { state: 'pending', at: now, source: 'test' },
        },
        cancelled: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    stages: [],
    runs: [],
    callbacks: [],
    messages: [],
    clients: [],
    counts: {
      tasks: 1,
      inFlight: 1,
      awaitingConfirmation: 0,
      callbacksPendingDelivery: 0,
      callbacksManual: 0,
      failed: 0,
    },
    ...overrides,
  };
}

describe('task workspace rendering', () => {
  let dom: JSDOM | null = null;

  afterEach(() => {
    dom?.window.close();
    dom = null;
  });

  async function setup(handler: (call: FetchCall) => unknown, configure: (window: any) => void = () => {}) {
    const calls: FetchCall[] = [];
    dom = new JSDOM(readFileSync(resolve(web, 'tasks.html'), 'utf8'), {
      url: 'http://localhost/tasks.html',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    configure(window);
    (window as unknown as { EventSource: unknown }).EventSource = class {
      addEventListener() {}
      close() {}
    };
    (window as unknown as { fetch: unknown }).fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      const body = handler(call);
      const status = (body as { status?: number })?.status ?? 200;
      const payload = (body as { body?: unknown })?.body ?? body;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
      };
    });
    window.eval(readFileSync(resolve(web, 'icons.js'), 'utf8'));
    window.eval(readFileSync(resolve(web, 'desktop-menu.js'), 'utf8'));
    window.eval(readFileSync(resolve(web, 'tasks.js'), 'utf8'));
    await settle();
    await settle();

    const element = (selector: string) => window.document.querySelector(selector) as HTMLElement | null;
    const click = (selector: string) => element(selector)?.click();
    const text = () => window.document.body.textContent || '';
    return { window, calls, element, click, text };
  }

  it('keeps recovery settings accessible when the task engine cannot be read', async () => {
    const ui = await setup(() => ({ status: 503, body: { error: '存储暂不可用' } }), (window) => {
      window.location.hash = '#settings';
    });
    expect(ui.text()).toContain('数据与运行');
  });

  it('preserves unsaved settings across refreshes and hash navigation', async () => {
    const ui = await setup(() => summaryFixture(), (window) => {
      window.location.hash = '#settings';
      window.relayDesktop = { settings: async () => ({ settings: { notifications: true }, packaged: true }) };
    });
    const input = ui.element('#f-data-root') as HTMLInputElement;
    input.value = 'D:\\My Tasks';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    ui.click('#refresh-button');
    await settle(); await settle();
    expect((ui.element('#f-data-root') as HTMLInputElement).value).toBe('D:\\My Tasks');
    ui.window.location.hash = '#overview';
    ui.window.dispatchEvent(new ui.window.HashChangeEvent('hashchange'));
    await settle();
    expect(ui.window.document.body.dataset.view).toBe('overview');
  });

  it('shows the task list and the four status layers separately', async () => {
    const ui = await setup(() => summaryFixture());
    expect(ui.text()).toContain('实现内容主题替换');
    expect(ui.text()).toContain('业务未确认');
    expect(ui.element('#nav-count-tasks')?.textContent).toBe('1');
    expect(ui.element('#data-root-chip')?.textContent).toBe('D:\\RelayData\\async');
  });

  it('reports a queued receipt as queued, never as delivered', async () => {
    const ui = await setup((call) => {
      if (call.url.includes('/api/async/tasks') && call.init?.method === 'POST') {
        return {
          status: 202,
          body: {
            taskId: 'task_1',
            topicId: 'top_1',
            topicName: '20261104-MediaDock-需求开发2',
            topicSlug: '20261104-mediadock-2',
            stageId: 'stg_1',
            runId: 'run_1',
            messageId: 'msg_1',
            phase: 'queued',
            client: 'zcode',
            sessionId: null,
            projectId: 'proj',
            model: { requested: {}, actual: null },
            reason: '未接入「zcode」的派发通道，任务已排队',
            status: summaryFixture().tasks[0]!.status,
            acceptedAt: '2026-11-04T07:00:00.000Z',
            idempotent: false,
          },
        };
      }
      return summaryFixture();
    });

    ui.click('[data-nav="dispatch"]');
    await settle();
    const window = ui.window;
    (window.document.querySelector('#f-title') as HTMLInputElement).value = '实现内容主题替换';
    (window.document.querySelector('#f-origin-chat') as HTMLInputElement).value = 'chat_original_7';
    (window.document.querySelector('[name="stagePath"]') as HTMLInputElement).value = 'D:\\Work\\MediaDock';
    (window.document.querySelector('[name="stageProjectId"]') as HTMLInputElement).value = 'proj_mediadock';
    (window.document.querySelector('#dispatch-form') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();
    await settle();

    const posted = ui.calls.find((call) => call.init?.method === 'POST');
    expect(posted).toBeTruthy();
    const payload = JSON.parse(String(posted?.init?.body)) as {
      origin: { chatId: string };
      stages: { project: { path: string }; model: { modelId: string; reasoning: string } }[];
    };
    expect(payload.origin.chatId).toBe('chat_original_7');
    expect(payload.stages[0]?.model.modelId).toBe('GLM-5.3-Flash');
    expect(payload.stages[0]?.model.reasoning).toBe('max');

    // The static form hint mentions both words; only the receipt heading may
    // state a phase, and for a queued dispatch it must say queued.
    const receiptHeading = ui.window.document.querySelector('.receipt h2');
    expect(receiptHeading?.textContent).toContain('已排队');
    expect(receiptHeading?.textContent).not.toContain('已送达');
  });

  it('shows the server field issues on a rejected submit', async () => {
    const ui = await setup((call) => {
      if (call.url.includes('/api/async/tasks') && call.init?.method === 'POST') {
        return {
          status: 400,
          body: {
            error: 'stages[0].project.path: 必须选择目标项目目录',
            issues: [{ field: 'stages[0].project.path', message: '必须选择目标项目目录' }],
          },
        };
      }
      return summaryFixture();
    });

    ui.click('[data-nav="dispatch"]');
    await settle();
    (ui.window.document.querySelector('#f-title') as HTMLInputElement).value = '标题';
    (ui.window.document.querySelector('#f-origin-chat') as HTMLInputElement).value = 'chat_original_7';
    (ui.window.document.querySelector('#dispatch-form') as HTMLFormElement).dispatchEvent(
      new ui.window.Event('submit', { bubbles: true, cancelable: true })
    );
    await settle();
    await settle();

    expect(ui.text()).toContain('必须选择目标项目目录');
    expect(ui.element('[data-invalid="true"]')).toBeTruthy();
  });
});
