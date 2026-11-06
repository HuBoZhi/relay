/**
 * Model catalogues, read from the clients themselves.
 *
 * Each client keeps its own list on this machine, and those files also hold API
 * keys — so these tests pin both halves of the contract: the ids come out, the
 * credentials do not.
 */

import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listModelsFor } from '../src/models.mjs';

const scratch: string[] = [];

async function home(): Promise<string> {
  const base = existsSync('D:\\') ? 'D:\\Temp' : tmpdir();
  const dir = await mkdtemp(join(base, 'relay-models-home-'));
  scratch.push(dir);
  return dir;
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value), 'utf8');
}

afterEach(async () => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('client model catalogues', () => {
  it('reads the Codex models cache with their reasoning levels', async () => {
    const root = await home();
    await writeJson(root, '.codex/models_cache.json', {
      models: [
        {
          slug: 'gpt-6.1-sol',
          display_name: 'GPT-6.1-Sol',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
        },
        { slug: 'gpt-6.1-mini', display_name: 'GPT-6.1-Mini', supported_reasoning_levels: [] },
      ],
    });
    const result = await listModelsFor('codex', { home: root });
    expect(result.reason).toBeNull();
    expect(result.models.map((model) => model.id)).toEqual(['gpt-6.1-sol', 'gpt-6.1-mini']);
    expect(result.models[0].label).toBe('GPT-6.1-Sol');
    expect(result.models[0].reasoning).toEqual(['low', 'high']);
  });

  it('keeps the model config.toml names selectable when the cache predates it', async () => {
    const root = await home();
    await writeJson(root, '.codex/models_cache.json', {
      models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol' }],
    });
    const configPath = join(root, '.codex/config.toml');
    await writeFile(configPath, 'model = "gpt-6.2-pro"\n', 'utf8');
    const result = await listModelsFor('codex', { home: root });
    expect(result.models.map((model) => model.id)).toEqual(['gpt-6.2-pro', 'gpt-6.1-sol']);
  });

  it('reads ZCode provider rules, skips disabled providers, and never returns keys', async () => {
    const root = await home();
    await writeJson(root, '.zcode/v2/provider_config.json', {
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: 'a',
              enabled: true,
              config: {
                access: { type: 'api-key', apiKey: 'sk-should-not-leak' },
                modelOrder: ['GLM-5.3', 'GLM-5.3-Flash'],
              },
            },
            { providerId: 'b', enabled: false, config: { modelOrder: ['retired-model'] } },
            { providerId: 'c', config: { personalModelIds: ['deepseek-flash'] } },
          ],
        },
        modelConfigRules: { providerModelRules: [{ modelId: 'GLM-5.3' }] },
      },
    });
    const result = await listModelsFor('zcode', { home: root });
    expect(result.models.map((model) => model.id)).toEqual([
      'GLM-5.3',
      'GLM-5.3-Flash',
      'deepseek-flash',
    ]);
    expect(JSON.stringify(result)).not.toContain('sk-should-not-leak');
  });

  it('reads the newest WorkBuddy product config, not an older cache file', async () => {
    const root = await home();
    await writeJson(root, '.workbuddy/cache/acc-product-config-v3-1.json', {
      models: [{ id: 'old-model', name: '旧模型' }],
    });
    await writeJson(root, '.workbuddy/cache/acc-product-config-v3-2.json', {
      models: [
        { id: 'fast-model', name: '快速', descriptionZh: '优先响应速度' },
        { id: 'balanced-model', name: '均衡' },
      ],
    });
    // Do not rely on filesystem timestamp precision for two adjacent writes.
    await utimes(join(root, '.workbuddy/cache/acc-product-config-v3-1.json'), 1000, 1000);
    await utimes(join(root, '.workbuddy/cache/acc-product-config-v3-2.json'), 2000, 2000);
    const result = await listModelsFor('workbuddy', { home: root });
    const ids = result.models.map((model) => model.id);
    expect(ids).toContain('fast-model');
    expect(ids).not.toContain('old-model');
    expect(result.models[0].label).toBe('快速');
  });

  it('keeps only the models the WorkBuddy craft agent can run', async () => {
    const root = await home();
    await writeJson(root, '.workbuddy/cache/acc-product-config-v3-9.json', {
      agents: [{ name: 'cli', modelTags: ['craft'], models: ['fast-model'] }],
      models: [
        { id: 'fast-model', name: '快速' },
        { id: 'kling-video-v3', name: '视频模型' },
      ],
    });
    const result = await listModelsFor('workbuddy', { home: root });
    expect(result.models.map((model) => model.id)).toEqual(['fast-model']);
  });

  it('says why a client has no readable catalogue instead of returning a guess', async () => {
    const root = await home();
    const codex = await listModelsFor('codex', { home: root });
    expect(codex.models).toEqual([]);
    expect(codex.reason).toContain('Codex');

    const factory = await listModelsFor('factory', { home: root });
    expect(factory.models).toEqual([]);
    expect(factory.reason).toContain('Factory');
  });

  it('rejects a client it does not know', async () => {
    await expect(listModelsFor('nope')).rejects.toThrow(/不支持的客户端/);
    await expect(listModelsFor('  ')).rejects.toThrow(/客户端/);
  });
});
