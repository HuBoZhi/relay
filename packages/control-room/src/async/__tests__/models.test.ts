/**
 * Model discovery for the dispatch form.
 *
 * The model column offers what the client itself reports. These tests pin the
 * contract: the list comes from the adapter, an adapter that cannot enumerate
 * says why, and the reasoning levels travel with the model that reports them.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { DemoControlRoomSource } from '../../demo-source.js';
import { AsyncEngine } from '../engine.js';
import type { DispatchAdapter, DeliverOutcome, DispatchOutcome } from '../adapters.js';
import type { ModelOption } from '../contracts.js';
import { startHttpTestServer } from '../../__tests__/http-test-server.js';

const scratch: string[] = [];

async function scratchRoot(): Promise<string> {
  const base = existsSync('D:\\') ? 'D:\\Temp' : tmpdir();
  const dir = await mkdtemp(join(base, 'relay-models-'));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function adapter(client: string, models?: ModelOption[]): DispatchAdapter {
  return {
    client,
    describe: () => ({}),
    dispatch: async (): Promise<DispatchOutcome> => ({ status: 'delivered' }),
    deliver: async (): Promise<DeliverOutcome> => ({ state: 'manual', reason: '未实现' }),
    ...(models ? { listModels: async () => models } : {}),
  };
}

async function withServer<T>(
  adapters: DispatchAdapter[],
  run: (base: string, engine: AsyncEngine) => Promise<T>
): Promise<T> {
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

describe('model discovery', () => {
  it('returns the models the client can select, with their reasoning levels', async () => {
    const models: ModelOption[] = [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', reasoning: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-6.1-mini', label: 'GPT-6.1-Mini', reasoning: ['low', 'medium'] },
    ];
    await withServer([adapter('codex', models)], async (base) => {
      const response = await fetch(`${base}/api/async/models?client=codex`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.client).toBe('codex');
      expect(body.reason).toBeNull();
      expect(body.models).toEqual(models);
    });
  });

  it('explains itself instead of inventing a catalogue when the client cannot enumerate', async () => {
    await withServer([adapter('factory')], async (base) => {
      const body = await (await fetch(`${base}/api/async/models?client=factory`)).json();
      expect(body.models).toEqual([]);
      expect(body.reason).toContain('派发桥接');
    });
  });

  it('answers for an agent with no adapter of its own through the registered bridge', async () => {
    const models: ModelOption[] = [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', reasoning: ['low', 'high'] },
    ];
    let asked: string | null = null;
    const shared: DispatchAdapter = {
      client: 'zcode',
      describe: () => ({}),
      dispatch: async (): Promise<DispatchOutcome> => ({ status: 'delivered' }),
      deliver: async (): Promise<DeliverOutcome> => ({ state: 'manual', reason: '未实现' }),
      listModels: async (client?: string) => {
        asked = client ?? 'zcode';
        return models;
      },
    };
    await withServer([shared], async (base) => {
      const body = await (await fetch(`${base}/api/async/models?client=codex`)).json();
      // Codex has no bridge of its own; any bridge can read its catalogue.
      expect(asked).toBe('codex');
      expect(body.models).toEqual(models);
      expect(body.reason).toBeNull();
    });
  });

  it('reports the bridge failure instead of an empty, unexplained list', async () => {
    const failing: DispatchAdapter = {
      client: 'zcode',
      describe: () => ({}),
      dispatch: async (): Promise<DispatchOutcome> => ({ status: 'delivered' }),
      deliver: async (): Promise<DeliverOutcome> => ({ state: 'manual', reason: '未实现' }),
      listModels: async () => {
        throw new Error('还没有 ZCode 的模型配置');
      },
    };
    await withServer([failing], async (base) => {
      const body = await (await fetch(`${base}/api/async/models?client=zcode`)).json();
      expect(body.models).toEqual([]);
      expect(body.reason).toContain('ZCode');
    });
  });

  it('requires a client', async () => {
    await withServer([adapter('zcode', [])], async (_base, engine) => {
      await expect(engine.listModels('  ')).rejects.toThrow(/客户端/);
    });
  });
});
