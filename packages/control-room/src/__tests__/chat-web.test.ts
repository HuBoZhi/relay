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

  async function setup(handler: (call: Call) => unknown, configure: (window: any) => void = () => {}) {
    const calls: Call[] = [];
    dom = new JSDOM(readFileSync(resolve(web, 'chat.html'), 'utf8'), {
      url: 'http://localhost/chat.html',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    configure(window);
    const stream = new window.EventTarget();
    (window as unknown as { EventSource: unknown }).EventSource = class {
      addEventListener(type: string, listener: EventListener) { stream.addEventListener(type, listener); }
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
      const body = await handler(call);
      const status = (body as { status?: number })?.status ?? 200;
      const payload = (body as { body?: unknown })?.body ?? body;
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
    });
    window.eval(readFileSync(resolve(web, 'icons.js'), 'utf8'));
    window.eval(readFileSync(resolve(web, 'dialog.js'), 'utf8'));
    window.eval(readFileSync(resolve(web, 'desktop-menu.js'), 'utf8'));
    window.eval(readFileSync(resolve(web, 'permissions.js'), 'utf8'));
    window.eval(readFileSync(resolve(web, 'chat.js'), 'utf8'));
    await settle();
    await settle();
    await settle();
    const element = (selector: string) => window.document.querySelector(selector) as HTMLElement | null;
    return { window, calls, element, stream, text: () => window.document.body.textContent || '' };
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

  it('shows bridge callback results without leaving the group', async () => {
    const view = fixture();
    const result = view.messages.pop()!;
    const handler = route(view);
    let completed = false;
    const ui = await setup(call => {
      const response = handler(call);
      if (call.url === '/api/groups' && completed) response.groups![0].openRequests = 0;
      return response;
    });
    expect(ui.element('#messages')?.textContent).not.toContain(result.body);
    view.messages.push(result);
    completed = true;
    ui.stream.dispatchEvent(new ui.window.MessageEvent('async', {
      data: JSON.stringify({ event: { type: 'callback.delivered', taskId: 'task_1' } }),
    }));
    await vi.waitFor(() => expect(ui.element('#messages')?.textContent).toContain(result.body));
    expect(ui.element('#engine-chip-text')?.textContent).not.toContain('请求在途');
  });

  it('reconciles results missed before a stream opens or reconnects', async () => {
    const view = fixture();
    const result = view.messages.pop()!;
    const ui = await setup(route(view));
    view.messages.push(result);
    ui.stream.dispatchEvent(new ui.window.Event('open'));
    await vi.waitFor(() => expect(ui.element('#messages')?.textContent).toContain(result.body));
    view.messages[view.messages.length - 1].body = '断线期间完成的第二次回传';
    ui.stream.dispatchEvent(new ui.window.Event('open'));
    await vi.waitFor(() => expect(ui.element('#messages')?.textContent).toContain('断线期间完成的第二次回传'));
  });

  it('refreshes again when a callback arrives while an older refresh is in flight', async () => {
    const view = fixture();
    const result = view.messages.pop()!;
    const handler = route(view);
    let release: (() => void) | undefined;
    let hold = false;
    const ui = await setup(async call => {
      const response = structuredClone(handler(call));
      if (hold && call.url === '/api/groups/grp_1') {
        hold = false;
        await new Promise<void>(resolve => { release = resolve; });
      }
      return response;
    });
    hold = true;
    ui.element('#refresh-button')!.click();
    await vi.waitFor(() => expect(release).toBeDefined());
    view.messages.push(result);
    ui.stream.dispatchEvent(new ui.window.MessageEvent('async', {
      data: JSON.stringify({ event: { type: 'callback.delivered', taskId: 'task_1' } }),
    }));
    await new Promise(resolve => setTimeout(resolve, 300));
    release!();
    await vi.waitFor(() => expect(ui.element('#messages')?.textContent).toContain(result.body));
  });

  it('sends the chosen ZCode permission and saves it with the group draft', async () => {
    const ui = await setup(route());
    for (let i = 0; i < 40 && !ui.element('#path-select'); i += 1) await settle();
    const permission = ui.element('[data-role="permission"]') as HTMLSelectElement;
    permission.value = 'guarded';
    permission.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    expect(JSON.parse(ui.window.localStorage.getItem('relay.chat.draft.grp_1') || '{}').participants[0].permissionMode).toBe('guarded');
    (ui.element('#body-input') as HTMLTextAreaElement).value = '按所选权限执行';
    (ui.element('#path-select') as HTMLSelectElement).value = 'D:////Work////MediaDock';
    ui.element('#dispatch-button')?.click();
    await settle(); await settle();
    const posted = ui.calls.find(call => call.init?.method === 'POST');
    expect(JSON.parse(String(posted?.init?.body)).mentions[0].session.permissionMode).toBe('guarded');
  });

  it('keeps the message draft and caret when a background refresh replaces the conversation', async () => {
    const ui = await setup(route());
    const input = ui.element('#body-input') as HTMLTextAreaElement;
    input.value = '正在输入的草稿';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(2, 4);
    ui.element('#refresh-button')!.click();
    await settle(); await settle();
    const restored = ui.element('#body-input') as HTMLTextAreaElement;
    expect(restored.value).toBe('正在输入的草稿');
    expect(ui.window.document.activeElement).toBe(restored);
    expect([restored.selectionStart, restored.selectionEnd]).toEqual([2, 4]);
  });

  it('confirms deletion, supports cancellation, and clears the deleted conversation and draft', async () => {
    let deleted = false;
    const ui = await setup((call) => {
      if (call.url === '/api/groups/grp_1/delete') { deleted = true; return { deleted: true }; }
      if (call.url === '/api/groups' && deleted) return { groups: [] };
      return route()(call);
    });
    ui.window.localStorage.setItem('relay.chat.draft.grp_1', '{"body":"草稿"}');
    ui.element('#delete-group-button')!.click();
    expect(ui.text()).toContain('历史任务记录保留');
    ui.element('[data-ask-action="cancel"]')!.click();
    await settle();
    expect(deleted).toBe(false);
    expect(ui.element('#body-input')).toBeTruthy();
    ui.element('#delete-group-button')!.click();
    ui.element('[data-ask-action="confirm"]')!.click();
    await settle(); await settle();
    expect(deleted).toBe(true);
    expect(ui.element('#conv-count')!.textContent).toBe('0');
    expect(ui.element('#body-input')).toBeNull();
    expect(ui.window.localStorage.getItem('relay.chat.draft.grp_1')).toBeNull();
    expect(ui.calls.filter((call) => call.url.endsWith('/delete'))).toHaveLength(1);
  });

  it('keeps the conversation and draft when deletion fails', async () => {
    const ui = await setup((call) => call.url.endsWith('/delete')
      ? { status: 500, body: { error: '保存删除状态失败' } } : route()(call));
    const input = ui.element('#body-input') as HTMLTextAreaElement;
    input.value = '保留的草稿';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    ui.element('#delete-group-button')!.click();
    ui.element('[data-ask-action="confirm"]')!.click();
    await settle(); await settle();
    expect(ui.text()).toContain('保存删除状态失败');
    expect((ui.element('#body-input') as HTMLTextAreaElement).value).toBe('保留的草稿');
    expect((ui.element('#delete-group-button') as HTMLButtonElement).disabled).toBe(false);
    expect(ui.element('#conv-count')!.textContent).toBe('1');
  });

  it('does not send while the Chinese input method is composing', async () => {
    const ui = await setup(route());
    const input = ui.element('#body-input') as HTMLTextAreaElement;
    input.value = '还没有确认的中文';
    input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
    await settle();
    expect(ui.calls.some((call) => call.init?.method === 'POST')).toBe(false);
  });

  it('refreshes client catalogues when the native bridge finishes starting', async () => {
    let ready!: () => void;
    const ui = await setup(route(), (window) => {
      window.relayDesktop = { onConnectionsReady: (listener) => { ready = listener; } };
    });
    const before = ui.calls.filter((call) => call.url.startsWith('/api/async/projects')).length;
    expect(typeof ready).toBe('function');
    ready();
    await settle(); await settle();
    expect(ui.calls.filter((call) => call.url.startsWith('/api/async/projects')).length).toBeGreaterThan(before);
  });

  it('persists a per-group draft and refuses duplicate sends while a request is pending', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    const normal = route();
    const ui = await setup((call) => call.init?.method === 'POST' ? pending : normal(call));
    const input = ui.element('#body-input') as HTMLTextAreaElement;
    input.value = '发送一次就够了';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    expect(JSON.parse(ui.window.localStorage.getItem('relay.chat.draft.grp_1')!).body).toBe(input.value);
    ui.element('#send-button')!.click();
    input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    await settle();
    expect(ui.calls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    release({ status: 202, body: {} });
    await settle(); await settle();
    expect(JSON.parse(ui.window.localStorage.getItem('relay.chat.draft.grp_1')!).body).toBe('');
  });

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

  it('asks for the group name in the page and creates the group', async () => {
    // A desktop window has no native prompt: the ask has to live in the page, or
    // the button answers with nothing and the click looks ignored.
    const ui = await setup(route());
    (ui.element('#new-group-button') as HTMLButtonElement).click();
    await settle();

    const card = ui.window.document.querySelector('.relay-ask') as HTMLElement | null;
    expect(card).toBeTruthy();
    const input = card?.querySelector('[data-ask-field="name"]') as HTMLInputElement;
    const confirm = card?.querySelector('[data-ask-action="confirm"]') as HTMLButtonElement;

    // An empty name is refused in the card, not silently ignored.
    confirm.click();
    await settle();
    expect(card?.querySelector('.relay-ask-error')?.textContent).toContain('群名称');
    expect(ui.calls.some((call) => call.url === '/api/groups' && call.init?.method === 'POST')).toBe(false);

    input.value = '20261105-三联联调';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    confirm.click();
    await settle();
    await settle();

    const posted = ui.calls.find((call) => call.url === '/api/groups' && call.init?.method === 'POST');
    expect(posted).toBeTruthy();
    const payload = JSON.parse(String(posted?.init?.body)) as { name: string; creator: { agentId: string } };
    expect(payload.name).toBe('20261105-三联联调');
    expect(payload.creator.agentId).toBe('relay');
  });

  it('never falls back to a native dialog, which a desktop window answers with null', () => {
    for (const page of ['chat.js', 'tasks.js']) {
      const source = readFileSync(resolve(web, page), 'utf8');
      expect(source).not.toMatch(/window\.(prompt|confirm|alert)\s*\(/);
    }
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
    expect(payload.sender.agentId).toBe('relay');
  });
});
