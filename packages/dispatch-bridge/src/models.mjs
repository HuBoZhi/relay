/**
 * The models each connected agent can choose right now.
 *
 * Every client keeps its own catalogue on this machine: Codex caches the list the
 * service hands it, ZCode stores its provider rules, WorkBuddy caches its product
 * config. Reading those files is the honest answer to "what can this agent run";
 * a list maintained in this repo would drift with every client release.
 *
 * Only ids and labels leave this module — the same files also hold API keys.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REASONS = {
  codex: '还没有 Codex 的模型缓存；打开一次 Codex 后即可读取',
  zcode: '还没有 ZCode 的模型配置；打开一次 ZCode 后即可读取',
  workbuddy: '还没有 WorkBuddy 的模型缓存；打开一次 WorkBuddy 后即可读取',
  factory: 'Factory 的模型清单只在应用内维护，本机没有可读的清单',
};

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function uniqueIds(values) {
  const ids = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Codex fetches its catalogue from the service and keeps it in `models_cache.json`. */
async function codexModels(home) {
  let cache;
  try {
    cache = await readJson(join(home, '.codex', 'models_cache.json'));
  } catch {
    return null;
  }
  const models = (Array.isArray(cache.models) ? cache.models : [])
    .map((model) => ({
      id: typeof model?.slug === 'string' ? model.slug : '',
      label:
        typeof model?.display_name === 'string' && model.display_name ? model.display_name : model?.slug,
      reasoning: uniqueIds(
        (Array.isArray(model?.supported_reasoning_levels) ? model.supported_reasoning_levels : []).map(
          (level) => level?.effort
        )
      ),
    }))
    .filter((model) => model.id);

  // The model config.toml names is what this machine is on. Keep it selectable even
  // when the cache predates it, or the form would prescribe a model the user moved off.
  const current = await codexConfiguredModel(home);
  if (current && !models.some((model) => model.id === current)) {
    models.unshift({ id: current, label: current, reasoning: [] });
  }
  return models;
}

async function codexConfiguredModel(home) {
  try {
    const text = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    const match = /^\s*model\s*=\s*"([^"]+)"/m.exec(text);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * ZCode keeps the models per provider rule.
 *
 * `modelOrder` is what its picker shows; `personalModelIds` and `builtinModelIds`
 * are the account's own additions and the provider template. The file nests the
 * rules under `providerRules` on current builds and stores them as a bare array
 * on older ones, so both shapes are read.
 */
async function zcodeModels(home) {
  let config;
  try {
    const data = await readJson(join(home, '.zcode', 'v2', 'provider_config.json'));
    config = data?.config ?? {};
  } catch {
    return null;
  }
  const providerRules = Array.isArray(config.providerConfigRules?.providerRules)
    ? config.providerConfigRules.providerRules
    : Array.isArray(config.providerConfigRules)
      ? config.providerConfigRules
      : [];
  const ids = [];
  for (const rule of providerRules) {
    if (rule?.enabled === false) continue;
    for (const key of ['modelOrder', 'personalModelIds', 'builtinModelIds']) {
      const list = rule?.config?.[key];
      if (Array.isArray(list)) ids.push(...list);
    }
  }
  const modelRules = config?.modelConfigRules?.providerModelRules;
  if (Array.isArray(modelRules)) ids.push(...modelRules.map((rule) => rule?.modelId));
  return uniqueIds(ids).map((id) => ({ id, label: id, reasoning: [] }));
}

/** WorkBuddy ships its catalogue inside the cached product config. */
async function workbuddyModels(home) {
  const dir = join(home, '.workbuddy', 'cache');
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const candidates = entries.filter(
    (name) => name.startsWith('acc-product-config-v3-') && name.endsWith('.json')
  );
  if (candidates.length === 0) return null;
  const stamped = await Promise.all(
    candidates.map(async (name) => {
      try {
        return { name, at: (await stat(join(dir, name))).mtimeMs };
      } catch {
        return { name, at: 0 };
      }
    })
  );
  stamped.sort((left, right) => right.at - left.at);
  let data;
  try {
    data = await readJson(join(dir, stamped[0].name));
  } catch {
    return null;
  }
  return (Array.isArray(data?.models) ? data.models : [])
    .map((model) => {
      const id = String(model?.id ?? '');
      return {
        id,
        label: String(model?.name ?? model?.displayName ?? id),
        reasoning: [],
        description: String(model?.descriptionZh ?? model?.descriptionEn ?? '') || undefined,
      };
    })
    .filter((model) => model.id && craftAllows(data, model.id));
}

/**
 * Relay's WorkBuddy adapter opens a `craft` conversation, so only the models that
 * agent lists can actually run a dispatch. The catalogue also carries image and
 * completion models that would be refused at session creation.
 */
function craftAllows(data, id) {
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const craft = agents.find((agent) => Array.isArray(agent?.modelTags) && agent.modelTags.includes('craft'));
  const allowed = Array.isArray(craft?.models) ? craft.models : [];
  return allowed.length === 0 || allowed.includes(id);
}

const READERS = {
  codex: codexModels,
  zcode: zcodeModels,
  workbuddy: workbuddyModels,
};

/**
 * Models for one client, newest source available on this machine.
 *
 * An empty list plus a reason lets the form fall back to a typed model id instead
 * of pretending the agent has nothing to run.
 */
export async function listModelsFor(client, { home = homedir() } = {}) {
  const key = String(client ?? '').trim();
  if (!key) throw new Error('必须指定客户端');
  const reader = READERS[key];
  if (!reader) {
    if (key in REASONS) return { client: key, models: [], reason: REASONS[key] };
    throw new Error(`不支持的客户端：${key}`);
  }
  const models = (await reader(home)) ?? [];
  return { client: key, models, reason: models.length > 0 ? null : REASONS[key] };
}
