/**
 * Project discovery for the dispatch form.
 *
 * A person knows the folder, not the client's internal project id, so the form
 * asks the client and carries the id along. These tests pin three things: the
 * list comes from the adapter, an adapter that cannot enumerate says why, and a
 * dispatch no longer dies on a missing id when the path is enough.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { DemoControlRoomSource } from '../../demo-source.js';
import { AsyncEngine } from '../engine.js';
import type { DispatchAdapter, DeliverOutcome, DispatchOutcome } from '../adapters.js';
import type { ProjectOption, SubmitTaskInput } from '../contracts.js';
import { startHttpTestServer } from '../../__tests__/http-test-server.js';

const scratch: string[] = [];

async function scratchRoot(): Promise<string> {
  const base = existsSync('D:\\') ? 'D:\\Temp' : tmpdir();
  const dir = await mkdtemp(join(base, 'relay-projects-'));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function adapter(client: string, projects?: ProjectOption[]): DispatchAdapter {
  return {
    client,
    describe: () => ({}),
    dispatch: async (): Promise<DispatchOutcome> => ({ status: 'delivered' }),
    deliver: async (): Promise<DeliverOutcome> => ({ state: 'manual', reason: '未实现' }),
    ...(projects ? { listProjects: async () => projects } : {}),
  };
}

async function withServer<T>(adapters: DispatchAdapter[], run: (base: string, engine: AsyncEngine) => Promise<T>): Promise<T> {
  const engine = new AsyncEngine({ dataRoot: await scratchRoot(), adapters });
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

describe('project discovery', () => {
  it('returns the projects the client already has configured', async () => {
    const projects = [
      { id: 'proj_mediadock', name: 'MediaDock', path: 'D:\\Work\\MediaDock' },
      { id: 'proj_relay', name: 'Relay', path: 'G:\\Coding\\Github\\relay' },
    ];
    await withServer([adapter('zcode', projects)], async (base) => {
      const response = await fetch(`${base}/api/async/projects?client=zcode`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.client).toBe('zcode');
      expect(body.reason).toBeNull();
      expect(body.projects).toEqual(projects);
    });
  });

  it('explains itself instead of inventing a list when the client cannot enumerate', async () => {
    await withServer([adapter('zcode')], async (base) => {
      const body = await (await fetch(`${base}/api/async/projects?client=zcode`)).json();
      expect(body.projects).toEqual([]);
      expect(body.reason).toContain('派发桥接');
    });
  });

  it('reports the bridge failure instead of an empty, unexplained list', async () => {
    const failing: DispatchAdapter = {
      client: 'zcode',
      describe: () => ({}),
      dispatch: async (): Promise<DispatchOutcome> => ({ status: 'delivered' }),
      deliver: async (): Promise<DeliverOutcome> => ({ state: 'manual', reason: '未实现' }),
      listProjects: async () => {
        throw new Error('端口 19372 未开放');
      },
    };
    await withServer([failing], async (base) => {
      const body = await (await fetch(`${base}/api/async/projects?client=zcode`)).json();
      expect(body.projects).toEqual([]);
      expect(body.reason).toContain('19372');
    });
  });

  it('accepts a dispatch that only names the folder', async () => {
    await withServer([adapter('zcode')], async (_base, engine) => {
      const receipt = await engine.submit(submission());
      // The path is the requirement; the id is the client's to resolve.
      expect(receipt.status.transport.state).toBeDefined();
      const snapshot = await engine.snapshot();
      const stage = snapshot.stages.find((item) => item.taskId === receipt.taskId);
      expect(stage?.project.path).toBe('D:\\Work\\MediaDock');
      expect(stage?.project.id).toBe('');
    });
  });
});

function submission(): SubmitTaskInput {
  return {
    topic: { name: '20261105-项目发现' },
    title: '只给目录也能派活',
    body: '按目录派发，不手填项目 ID。',
    authorization: { scopes: ['develop'], allowChain: false },
    origin: { app: 'codex', device: 'desktop-01', chatId: 'chat_1' },
    stages: [
      {
        kind: 'implement',
        client: 'zcode',
        project: { id: '', path: 'D:\\Work\\MediaDock' },
        model: { account: 'BigModel', provider: 'BigModel', modelId: 'GLM-5.3-Flash', reasoning: 'max' },
        completion: { condition: '改完并说明', requiresEvidence: false },
      },
    ],
  } as SubmitTaskInput;
}
