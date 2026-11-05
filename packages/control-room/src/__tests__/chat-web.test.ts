/**
 * The chat page in a DOM.
 *
 * Three promises are worth keeping: a request shows where it went and what it was
 * told to use, a dispatch with no project is refused before it leaves the page,
 * and a plain message carries an address but no work order.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const settle = () => new Promise((done) => setTimeout(done, 0));

interface Call {
  url: string;
  init?: RequestInit;
}

function fixture() {
  const now = '2026-11-04T08:00:00.000Z';
  const sender = {
    agentId: 'codex',
    displayName: 'Codex',
    app: 'codex',
    device: 'desktop-01',
    chatId: 'chat_codex_main',
  };
  return {
    group: {
      id: 'grp_1',
      topicId: 'top_1',
      name: '20261104-MediaDock-需求开发2',
      slug: '20261104-mediadock-2',
      createdBy: sender,
      memberIds: ['mbr_1', 'mbr_2'],
      messageIds: ['m1', 'm2', 'm3'],
      taskIds: ['task_1'],
      createdAt: now,
      updatedAt: now,
    },
    members: [
      {
        id: 'mbr_1',
        groupId: 'grp_1',
        agentId: 'codex',
        displayName: 'Codex',
        role: 'owner',
        sessionId: null,
        app: 'codex',
        device: 'desktop-01',
        chatId: 'chat_codex_main',
        model: null,
        joinedAt: now,
        joinedBy: 'creator',
      },
      {
        id: 'mbr_2',
        groupId: 'grp_1',
        agentId: 'zcode',
        displayName: 'ZCode',
        role: 'worker',
        sessionId: 'session_a1b2c3',
        app: 'zcode',
        device: 'desktop-01',
        chatId: 'chat_zcode_1',
        model: null,
        joinedAt: now,
        joinedBy: 'self',
      },
    ],
    messages: [
      {
        id: 'm1',
        groupId: 'grp_1',
        kind: 'request',
        sender,
        body: '把登录页的空状态补上',
        mentions: [
          {
            target: 'zcode',
            client: 'zcode',
            model: { account: 'BigModel', provider: 'zhipu', modelId: 'GLM-5.3-Flash', reasoning: 'max' },
            project: { id: 'proj', path: 'D:\\Work\\MediaDock' },
          },
        ],
        taskId: 'task_1',
        stageId: 'stg_1',
        runId: 'run_1',
        outcome: null,
        state: 'queued',
        reason: '未接入「zcode」的派发通道，任务已排队',
        createdAt: now,
      },
      {
        id: 'm2',
        groupId: 'grp_1',
        kind: 'join',
        sender: {
          agentId: 'zcode',
          displayName: 'ZCode',
          app: 'zcode',
          device: 'desktop-01',
          chatId: 'chat_zcode_1',
        },
        body: 'ZCode 已加入（会话 session_a1b2c3）',
        mentions: [],
        taskId: null,
        stageId: null,
        runId: null,
        outcome: null,
        state: 'sent',
        reason: null,
        createdAt: now,
      },
      {
        id: 'm3',
        groupId: 'grp_1',
        kind: 'result',
        sender: {
          agentId: 'zcode',
          displayName: 'ZCode',
          app: 'zcode',
          device: 'desktop-01',
          chatId: 'chat_zcode_1',
        },
        body: '空状态已补，npm test 通过',
        mentions: [{ target: 'codex' }],
        taskId: 'task_1',
        stageId: 'stg_1',
        runId: 'run_1',
        outcome: 'completed',
        state: 'manual',
        reason: '原聊天接收能力未验证',
        createdAt: now,
      },
    ],
    tasks: [],
  };
}

describe('chat page', () => {
  let dom: JSDOM | null = null;

  afterEach(() => {
    dom?.window.close();
    dom = null;
  });

  async function setup(handler: (call: Call) => unknown) {
    const calls: Call[] = [];
    dom = new JSDOM(readFileSync(resolve(web, 'chat.html'), 'utf8'), {
      url: 'http://localhost/chat.html',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    (window as unknown as { EventSource: unknown }).EventSource = class {
      addEventListener() {}
      close() {}
    };
    (window as unknown as { fetch: unknown }).fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      // The composer asks the app for the client's own project list; answer it so
      // the select exists in these tests.
      if (String(url).startsWith('/api/async/projects')) {
        const payload = {
          client: 'zcode',
          projects: [{ id: 'proj_1', name: 'MediaDock', path: 'D:////Work////MediaDock' }],
        };
        return {
          ok: true,
          status: 200,
          json: async () => payload,
          text: async () => JSON.stringify(payload),
        };
      }
      const body = handler(call);
      const status = (body as { status?: number })?.status ?? 200;
      const payload = (body as { body?: unknown })?.body ?? body;
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
    });
    window.eval(readFileSync(resolve(web, 'icons.js'), 'utf8'));
    window.eval(readFileSync(resolve(web, 'chat.js'), 'utf8'));
    await settle();
    await settle();
    await settle();
    const element = (selector: string) => window.document.querySelector(selector) as HTMLElement | null;
    return { window, calls, element, text: () => window.document.body.textContent || '' };
  }

  function route(view = fixture()) {
    return (call: Call) => {
      if (call.url === '/api/groups') {
        return {
          groups: [
            {
              id: 'grp_1',
              name: '20261104-MediaDock-需求开发2',
              slug: 'x',
              memberCount: 2,
              messageCount: 3,
              lastMessage: {
                body: '空状态已补',
                sender: 'ZCode',
                at: '2026-11-04T08:00:00.000Z',
                kind: 'result',
              },
              openRequests: 1,
              updatedAt: '2026-11-04T08:00:00.000Z',
            },
          ],
        };
      }
      if (call.url === '/api/groups/grp_1') return view;
      if (call.url.startsWith('/api/groups/grp_1/messages')) {
        return {
          status: 202,
          body: {
            message: { id: 'm9', kind: 'request', state: 'queued' },
            receipt: { phase: 'queued' },
            group: view,
          },
        };
      }
      return { status: 404, body: { error: '未知接口' } };
    };
  }

  it('renders the request with its target, model, and project, and the result with its delivery', async () => {
    const ui = await setup(route());
    const text = ui.text();
    expect(text).toContain('@zcode');
    expect(text).toContain('GLM-5.3-Flash · max');
    expect(text).toContain('D:\\Work\\MediaDock');
    expect(text).toContain('已排队');
    expect(text).toContain('完成');
    expect(text).toContain('原聊天未收到，需人工处理');
    // The session that proves the join is visible in the member row.
    expect(text).toContain('session_a1b2c3');
  });

  it('refuses a dispatch with no project before leaving the page', async () => {
    const ui = await setup(route());
    (ui.element('#body-input') as HTMLTextAreaElement).value = '把注册页校验补上';
    // The project list is available now, so "nothing chosen" means an empty select.
    for (let i = 0; i < 40 && !ui.element('#path-select'); i += 1) await settle();
    (ui.element('#path-select') as HTMLSelectElement).value = '';
    (ui.element('#dispatch-button') as HTMLButtonElement).click();
    await settle();

    expect(ui.text()).toContain('派活必须指定项目目录');
    expect(ui.calls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
  });

  it('gives each addressed agent its own model', async () => {
    const ui = await setup(route());
    await settle();
    ui.element('#add-participant')?.click();
    await settle();

    const rows = ui.window.document.querySelectorAll('#participants .participant');
    expect(rows).toHaveLength(2);
    const second = rows[1] as HTMLElement;
    (second.querySelector('[data-role="target"]') as HTMLSelectElement).value = 'codex';
    (second.querySelector('[data-role="model"]') as HTMLInputElement).value = 'gpt-5-codex';
    (second.querySelector('[data-role="reasoning"]') as HTMLSelectElement).value = 'high';

    // The project list arrives asynchronously and re-renders the composer.
    for (let i = 0; i < 40 && !ui.window.document.querySelector('#path-select'); i += 1) await settle();
    (ui.window.document.querySelector('#body-input') as HTMLTextAreaElement).value = '两位分别看下';
    (ui.window.document.querySelector('#path-select') as HTMLSelectElement).value = 'D:////Work////MediaDock';
    (ui.element('#dispatch-button') as HTMLButtonElement).click();
    await settle();
    await settle();

    const posted = ui.calls.find((call) => call.init?.method === 'POST');
    expect(posted).toBeTruthy();
    const payload = JSON.parse(String(posted?.init?.body)) as {
      mentions: { target: string; model?: { modelId: string; reasoning: string } }[];
    };
    expect(payload.mentions.map((mention) => mention.target)).toEqual(['zcode', 'codex']);
    expect(payload.mentions[0]?.model?.modelId).toBe('GLM-5.3-Flash');
    expect(payload.mentions[1]?.model?.modelId).toBe('gpt-5-codex');
    expect(payload.mentions[1]?.model?.reasoning).toBe('high');
  });

  it('sends a plain message as an address, with no client and no project', async () => {
    const ui = await setup(route());
    (ui.element('#body-input') as HTMLTextAreaElement).value = '这台机器装 Node 22 了吗？';
    (ui.element('#send-button') as HTMLButtonElement).click();
    await settle();
    await settle();

    const posted = ui.calls.find((call) => call.init?.method === 'POST');
    expect(posted).toBeTruthy();
    const payload = JSON.parse(String(posted?.init?.body)) as {
      mentions: { target: string; client?: string; project?: unknown }[];
      sender: { agentId: string };
    };
    expect(payload.mentions[0]?.target).toBe('zcode');
    expect(payload.mentions[0]?.client).toBeUndefined();
    expect(payload.mentions[0]?.project).toBeUndefined();
    expect(payload.sender.agentId).toBe('codex');
  });
});
