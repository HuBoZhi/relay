/**
 * Relay's MCP surface.
 *
 * The server is spoken to exactly as a client would: newline-delimited JSON-RPC on
 * stdio. The installer is tested against a throwaway home, because the thing that
 * matters is that other agents' configs come back intact.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { install, remove, status, clientConfigPath } from '../src/cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(here, '../src/server.mjs');
const scratch: string[] = [];

async function scratchDir(prefix) {
  const base = existsSync('D://') ? 'D://Temp' : tmpdir();
  const dir = await mkdtemp(join(base, prefix));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function fakeApp() {
  const server = createServer((request, response) => {
    if (request.url === '/api/groups') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ groups: [{ id: 'grp_1', name: '测试群', memberCount: 2, openRequests: 0 }] }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  return server;
}

describe('relay-mcp server', () => {
  it('answers initialize and tools/list, and calls the app for relay_groups', async () => {
    const app = fakeApp();
    const port = await new Promise((done) => app.listen(0, '127.0.0.1', () => done(app.address().port)));

    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, RELAY_APP_URL: `http://127.0.0.1:${port}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const replies = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) replies.push(JSON.parse(line));
      }
    });

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'relay_groups', arguments: {} } });

    const deadline = Date.now() + 5000;
    while (replies.length < 3 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 30));
    }
    child.kill();
    app.close();

    expect(replies).toHaveLength(3);
    expect(replies[0].result.serverInfo.name).toBe('relay');
    expect(replies[1].result.tools.map((tool) => tool.name)).toEqual([
      'relay_groups',
      'relay_read',
      'relay_send',
      'relay_result',
    ]);
    expect(replies[2].result.content[0].text).toContain('测试群');
  });
});

describe('installer', () => {
  it('adds the relay server to an existing ZCode config without touching other servers', async () => {
    const home = await scratchDir('relay-mcp-home-');
    const config = clientConfigPath('zcode', home).path;
    await mkdir(dirname(config), { recursive: true });
    await writeFile(
      config,
      JSON.stringify({ mcp: { servers: { other: { type: 'stdio', command: 'x' } } }, plugins: { keep: true } }, null, 2)
    );

    const result = await install('zcode', { home, appUrl: 'http://127.0.0.1:4320' });
    expect(result.changed).toBe(true);

    const saved = JSON.parse(await readFile(config, 'utf8'));
    expect(saved.mcp.servers.other).toEqual({ type: 'stdio', command: 'x' });
    expect(saved.plugins).toEqual({ keep: true });
    expect(saved.mcp.servers.relay.env.RELAY_APP_URL).toBe('http://127.0.0.1:4320');
    expect((await status('zcode', { home })).installed).toBe(true);

    const removed = await remove('zcode', { home });
    expect(removed.changed).toBe(true);
    const after = JSON.parse(await readFile(config, 'utf8'));
    expect(after.mcp.servers.relay).toBeUndefined();
    expect(after.mcp.servers.other).toBeDefined();
  });

  it('writes and removes a Codex TOML block without duplicating it', async () => {
    const home = await scratchDir('relay-mcp-codex-');
    const config = clientConfigPath('codex', home).path;
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, 'model = "gpt-5"\n');

    expect((await install('codex', { home, appUrl: 'http://127.0.0.1:4320' })).changed).toBe(true);
    expect((await install('codex', { home, appUrl: 'http://127.0.0.1:4320' })).changed).toBe(false);

    const text = await readFile(config, 'utf8');
    expect(text).toContain('model = "gpt-5"');
    expect(text.match(/\[mcp_servers\.relay\]/g)).toHaveLength(1);

    await remove('codex', { home });
    const cleaned = await readFile(config, 'utf8');
    expect(cleaned).not.toContain('[mcp_servers.relay]');
    expect(cleaned).toContain('model = "gpt-5"');
  });
});
