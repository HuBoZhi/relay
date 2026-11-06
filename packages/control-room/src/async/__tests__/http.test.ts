/**
 * The HTTP contract a dispatching chat actually talks to.
 *
 * These tests pin three things the requirement calls out: a submit answers before
 * the work does, a replay does not create a second task, and the local endpoint
 * refuses requests a random web page could make.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { DemoControlRoomSource } from '../../demo-source.js';
import { AsyncEngine } from '../engine.js';
import type { SubmitTaskInput } from '../contracts.js';
import { startHttpTestServer } from '../../__tests__/http-test-server.js';

const scratch: string[] = [];

async function scratchRoot(): Promise<string> {
  const base = existsSync('D:\\') ? 'D:\\Temp' : tmpdir();
  const dir = await mkdtemp(join(base, 'relay-async-http-'));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function withServer<T>(run: (base: string, engine: AsyncEngine) => Promise<T>): Promise<T> {
  const engine = new AsyncEngine({ dataRoot: await scratchRoot() });
  const server = await startHttpTestServer({
    source: new DemoControlRoomSource({ tickMs: 60_000 }),
    async: { engine },
  });
  try {
    return await run(server.url, engine);
  } finally {
    await server.close();
    await engine.close();
  }
}

function payload(overrides: Partial<SubmitTaskInput> = {}): SubmitTaskInput {
  return {
    topic: { name: '20261104-MediaDock-需求开发2' },
    title: '实现内容主题替换',
    body: '将 {主题} 替换为当前项目的主题部分。',
    authorization: { scopes: ['develop', 'review'], allowChain: true },
    origin: {
      app: 'codex',
      device: 'desktop-01',
      chatId: 'chat_original_7',
      senderId: 'agent_original',
      workflowIds: [],
    },
    stages: [
      {
        kind: 'develop',
        client: 'zcode',
        project: { id: 'proj_mediadock', path: 'D:\\Work\\MediaDock' },
        session: { policy: 'new', sessionId: null },
        model: { account: 'BigModel', provider: 'zhipu', modelId: 'GLM-5.3-Flash', reasoning: 'max' },
        completion: { condition: '开发完成', requiresEvidence: true },
      },
    ],
    ...overrides,
  };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('async HTTP API', () => {
  it('deletes groups through a same-origin JSON mutation and refuses stale access', async () => {
    await withServer(async (base, engine) => {
      const { group } = await engine.createGroup({ name: '删除接口测试', creator: { agentId: 'relay', app: 'relay', device: 'local', chatId: 'local' } });
      const endpoint = `${base}/api/groups/${group.id}/delete`;
      expect((await post(endpoint, {}, { Origin: 'https://untrusted.example' })).status).toBe(403);
      expect(await engine.group(group.id)).toBeTruthy();
      expect((await post(endpoint, {})).status).toBe(200);
      expect((await fetch(`${base}/api/groups/${group.id}`)).status).toBe(404);
      expect(await (await fetch(`${base}/api/groups`)).json()).toEqual({ groups: [] });
      expect((await post(endpoint, {})).status).toBe(200);
      expect((await post(`${base}/api/groups/missing/delete`, {})).status).toBe(404);
    });
  });
  it('accepts a task with 202 and a queued receipt', async () => {
    await withServer(async (base) => {
      const response = await post(`${base}/api/async/tasks`, payload());
      expect(response.status).toBe(202);
      const receipt = (await response.json()) as Record<string, unknown>;
      expect(receipt.phase).toBe('queued');
      expect(receipt.taskId).toMatch(/^task_/);
      expect(receipt.sessionId).toBeNull();
      const status = receipt.status as { business: { state: string } };
      expect(status.business.state).toBe('unconfirmed');
    });
  });

  it('answers a repeated submit with the original ids', async () => {
    await withServer(async (base) => {
      const body = payload({ idempotencyKey: 'chat_original_7:1' });
      const first = (await (await post(`${base}/api/async/tasks`, body)).json()) as Record<string, unknown>;
      const second = (await (await post(`${base}/api/async/tasks`, body)).json()) as Record<string, unknown>;
      expect(second.taskId).toBe(first.taskId);
      expect(second.idempotent).toBe(true);
    });
  });

  it('records a callback and reports manual delivery separately', async () => {
    await withServer(async (base, engine) => {
      const receipt = (await (await post(`${base}/api/async/tasks`, payload())).json()) as Record<
        string,
        string
      >;
      const response = await post(`${base}/api/async/callbacks`, {
        taskId: receipt.taskId,
        stageId: receipt.stageId,
        runId: receipt.runId,
        outcome: 'completed',
        summary: '开发完成',
      });
      expect(response.status).toBe(202);
      const callback = (await response.json()) as {
        recorded: boolean;
        delivery: { state: string; reason: string };
      };
      expect(callback.recorded).toBe(true);
      expect(callback.delivery.state).toBe('manual');
      expect(callback.delivery.reason).toContain('未接入');

      const detail = (await (await fetch(`${base}/api/async/tasks/${receipt.taskId}`)).json()) as {
        task: { status: { callback: { state: string } } };
      };
      expect(detail.task.status.callback.state).toBe('manual');
      void engine;
    });
  });

  it('rejects a non-JSON body and a cross-origin request', async () => {
    await withServer(async (base) => {
      const plain = await fetch(`${base}/api/async/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload()),
      });
      expect(plain.status).toBe(415);

      const crossSite = await post(`${base}/api/async/tasks`, payload(), { Origin: 'https://example.com' });
      expect(crossSite.status).toBe(403);
    });
  });

  it('names the missing fields instead of silently reusing a previous target', async () => {
    await withServer(async (base) => {
      const bad = payload();
      bad.stages = [{ ...bad.stages[0]!, project: { id: '', path: '' } }];
      const response = await post(`${base}/api/async/tasks`, bad);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { issues: { field: string }[] };
      expect(body.issues.map((issue) => issue.field)).toContain('stages[0].project.path');
    });
  });

  it('opens a group and dispatches an @ request through the chat endpoint', async () => {
    await withServer(async (base) => {
      const created = await post(`${base}/api/groups`, {
        name: '20261104-MediaDock-需求开发2',
        creator: {
          agentId: 'codex',
          displayName: 'Codex',
          app: 'codex',
          device: 'desktop-01',
          chatId: 'chat_original_7',
        },
      });
      expect(created.status).toBe(201);
      const view = (await created.json()) as { group: { id: string } };

      const response = await post(`${base}/api/groups/${view.group.id}/messages`, {
        sender: {
          agentId: 'codex',
          displayName: 'Codex',
          app: 'codex',
          device: 'desktop-01',
          chatId: 'chat_original_7',
        },
        body: '把登录页空状态补上',
        mentions: [
          {
            target: 'zcode',
            client: 'zcode',
            project: { id: 'proj_mediadock', path: 'D:////Work////MediaDock' },
            model: { account: 'BigModel', provider: 'zhipu', modelId: 'GLM-5.3-Flash', reasoning: 'max' },
          },
        ],
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as {
        message: { kind: string; state: string };
        receipt: { phase: string } | null;
      };
      expect(body.message.kind).toBe('request');
      expect(body.receipt?.phase).toBe('queued');
      expect(body.message.state).toBe('queued');
    });
  });

  it('rejects a group request with no project and names the mention', async () => {
    await withServer(async (base) => {
      const created = (await (
        await post(`${base}/api/groups`, {
          name: '群X',
          creator: {
            agentId: 'codex',
            displayName: 'Codex',
            app: 'codex',
            device: 'desktop-01',
            chatId: 'chat_1',
          },
        })
      ).json()) as { group: { id: string } };

      const response = await post(`${base}/api/groups/${created.group.id}/messages`, {
        sender: { agentId: 'codex', app: 'codex', chatId: 'chat_1' },
        body: '干活',
        mentions: [
          {
            target: 'zcode',
            client: 'zcode',
            model: { account: 'BigModel', provider: 'zhipu', modelId: 'GLM-5.3-Flash', reasoning: 'max' },
          },
        ],
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { issues: { field: string }[] };
      expect(body.issues[0]?.field).toBe('mentions[0].project');
    });
  });

  it('keeps the read-only observer endpoints working next to the task routes', async () => {
    await withServer(async (base) => {
      const health = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean };
      expect(health.ok).toBe(true);
      const missing = await fetch(`${base}/api/async/tasks/task_unknown`);
      expect(missing.status).toBe(404);
    });
  });
});
