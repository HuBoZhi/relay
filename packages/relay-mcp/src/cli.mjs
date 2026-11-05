#!/usr/bin/env node
/**
 * `relay-mcp` — install the Relay tools into an agent, or run the server.
 *
 * Installing means one entry in the agent's own MCP config, pointing at this
 * server. It never edits the agent's model, auth, or permissions, and it backs up
 * the config it touches before touching it.
 *
 *   relay-mcp install --client zcode
 *   relay-mcp status  --client zcode
 *   relay-mcp remove  --client zcode
 *   relay-mcp serve
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'server.mjs');

const USAGE = `用法：relay-mcp <命令> [选项]

命令：
  install --client <zcode|codex|workbuddy>   把这套工具注册到该客户端的 MCP 配置
  remove  --client <client>                  从配置中移除
  status  --client <client>                  查看是否已注册
  serve                                      以 stdio 方式运行 MCP 服务

选项：
  --home <目录>     覆盖用户目录（默认取系统家目录，测试用）
  --app <地址>      Relay 引擎地址，默认 http://127.0.0.1:4320
  --dry-run         只显示将要写入的内容，不落盘

环境变量：RELAY_APP_URL、RELAY_ASYNC_TOKEN
`;

export function clientConfigPath(client, home = homedir()) {
  switch (client) {
    case 'zcode':
      return { path: join(home, '.zcode', 'cli', 'config.json'), kind: 'json', key: ['mcp', 'servers'] };
    case 'workbuddy':
      return { path: join(home, '.workbuddy', 'mcp.json'), kind: 'json', key: ['mcpServers'] };
    case 'codex':
      return { path: join(home, '.codex', 'config.toml'), kind: 'toml' };
    default:
      throw new Error(`不支持的客户端：${client}`);
  }
}

export function entryFor(appUrl) {
  return {
    type: 'stdio',
    command: 'node',
    args: [SERVER],
    env: { RELAY_APP_URL: appUrl },
    enabled: true,
    timeoutMs: 60000,
  };
}

async function readJson(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`${path} 不是合法 JSON：${error.message}`);
  }
}

async function backup(path) {
  try {
    const target = `${path}.bak-relay-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await copyFile(path, target);
    return target;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function installJson(configPath, keys, entry, { dryRun = false } = {}) {
  const data = await readJson(configPath);
  let node = data;
  for (const key of keys.slice(0, -1)) {
    node[key] = node[key] && typeof node[key] === 'object' ? node[key] : {};
    node = node[key];
  }
  const last = keys[keys.length - 1];
  node[last] = node[last] && typeof node[last] === 'object' ? node[last] : {};
  const existed = Boolean(node[last].relay);
  node[last].relay = entry;
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (!dryRun) {
    const saved = await backup(configPath);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, text, 'utf8');
    return { changed: !existed, backup: saved, path: configPath };
  }
  return { changed: !existed, backup: null, path: configPath, preview: text };
}

export async function removeJson(configPath, keys, { dryRun = false } = {}) {
  const data = await readJson(configPath);
  let node = data;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object') return { changed: false, path: configPath };
    node = node[key];
  }
  const bucket = node[keys[keys.length - 1]];
  if (!bucket || !bucket.relay) return { changed: false, path: configPath };
  delete bucket.relay;
  if (!dryRun) {
    await backup(configPath);
    await writeFile(configPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
  return { changed: true, path: configPath };
}

export function tomlBlock(appUrl) {
  return [
    '[mcp_servers.relay]',
    'command = "node"',
    `args = [${JSON.stringify(SERVER)}]`,
    '',
    '[mcp_servers.relay.env]',
    `RELAY_APP_URL = ${JSON.stringify(appUrl)}`,
    '',
  ].join('\n');
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

export async function installToml(configPath, appUrl, { dryRun = false } = {}) {
  const current = await readText(configPath);
  if (current.includes('[mcp_servers.relay]')) {
    return { changed: false, path: configPath };
  }
  const next = `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}\n# Relay 群聊工具（relay-mcp install 写入）\n${tomlBlock(appUrl)}`;
  if (!dryRun) {
    const saved = await backup(configPath);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, next, 'utf8');
    return { changed: true, backup: saved, path: configPath };
  }
  return { changed: true, path: configPath, preview: next };
}

export async function removeToml(configPath, { dryRun = false } = {}) {
  const current = await readText(configPath);
  const start = current.indexOf('[mcp_servers.relay]');
  if (start === -1) return { changed: false, path: configPath };
  const tail = current.slice(start);
  const nextSection = tail.slice(1).search(/\n\[/);
  const end = nextSection === -1 ? current.length : start + 1 + nextSection + 1;
  const next = `${current.slice(0, start)}${current.slice(end)}`.replace(/\n{3,}/g, '\n\n');
  if (!dryRun) {
    await backup(configPath);
    await writeFile(configPath, next, 'utf8');
  }
  return { changed: true, path: configPath };
}

export async function install(client, { home, appUrl, dryRun = false } = {}) {
  const config = clientConfigPath(client, home);
  const entry = entryFor(appUrl);
  if (config.kind === 'toml') return installToml(config.path, appUrl, { dryRun });
  return installJson(config.path, config.key, entry, { dryRun });
}

export async function remove(client, { home, dryRun = false } = {}) {
  const config = clientConfigPath(client, home);
  if (config.kind === 'toml') return removeToml(config.path, { dryRun });
  return removeJson(config.path, config.key, { dryRun });
}

export async function status(client, { home } = {}) {
  const config = clientConfigPath(client, home);
  if (config.kind === 'toml') {
    const text = await readText(config.path);
    return { client, path: config.path, installed: text.includes('[mcp_servers.relay]') };
  }
  const data = await readJson(config.path);
  let node = data;
  for (const key of config.key) {
    node = node && typeof node === 'object' ? node[key] : null;
  }
  return { client, path: config.path, installed: Boolean(node && node.relay) };
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const options = { home: homedir(), appUrl: process.env.RELAY_APP_URL || 'http://127.0.0.1:4320', dryRun: false };
  let client = null;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} 缺少取值`);
      index += 1;
      return value;
    };
    if (flag === '--client') client = next();
    else if (flag === '--home') options.home = resolve(next());
    else if (flag === '--app') options.appUrl = next();
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(USAGE);
      return;
    } else throw new Error(`未知参数：${flag}`);
  }

  if (command === 'serve') {
    await import('./server.mjs');
    return;
  }
  if (command === 'status') {
    if (!client) throw new Error('缺少 --client');
    console.log(JSON.stringify(await status(client, options), null, 2));
    return;
  }
  if (command === 'install' || command === 'remove') {
    if (!client) throw new Error('缺少 --client');
    const result = command === 'install' ? await install(client, options) : await remove(client, options);
    console.log(JSON.stringify(result, null, 2));
    if (command === 'install') {
      console.log('');
      console.log(`已注册到 ${client}。重启该客户端后，它的 MCP 工具列表里会出现 relay_* 工具。`);
      console.log(`服务地址：${options.appUrl}`);
    }
    return;
  }
  console.log(USAGE);
  process.exitCode = command ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
