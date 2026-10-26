import { afterEach, describe, expect, it } from 'vitest';

import { DemoControlRoomSource } from '../demo-source.js';
import { startControlRoom, type ControlRoomServer } from '../server.js';

const FIXED = Date.parse('2026-10-26T06:32:08Z');
let server: ControlRoomServer | null = null;
let source: DemoControlRoomSource | null = null;

async function start(): Promise<ControlRoomServer> {
  source = new DemoControlRoomSource({ now: () => FIXED, tickMs: 60_000 });
  server = await startControlRoom({ source, port: 0, log: () => {} });
  return server;
}

afterEach(async () => {
  await server?.close();
  await source?.close();
  server = null;
  source = null;
});

describe('control room HTTP surface', () => {
  it('serves the interface shell', async () => {
    const room = await start();
    const response = await fetch(room.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('协作控制中心');
  });

  it('reports health without leaking credentials', async () => {
    const room = await start();
    const data = (await (await fetch(`${room.url}/api/health`)).json()) as { ok: boolean; mode: string };
    expect(data.ok).toBe(true);
    expect(data.mode).toBe('demo');
    expect(JSON.stringify(data)).not.toContain('rk_live_');
  });

  it('returns a bootstrap snapshot with every view field the UI reads', async () => {
    const room = await start();
    const response = await fetch(`${room.url}/api/bootstrap`);
    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown> & {
      channels: { name: string; stateLabel: string }[];
      agents: { workStateLabel: string }[];
      metrics: Record<string, unknown>;
      timezone: string;
    };
    expect(data.timezone).toBe('Asia/Shanghai');
    expect(Array.isArray(data.channels)).toBe(true);
    expect(data.channels.length).toBeGreaterThan(0);
    expect(data.channels[0]!.stateLabel).toBeTruthy();
    expect(data.agents[0]!.workStateLabel).toBeTruthy();
    expect(data.metrics.channelsWorking).not.toBeUndefined();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('pages channel messages and rejects unknown channels gracefully', async () => {
    const room = await start();
    const page = (await (await fetch(`${room.url}/api/channels/engineering/messages?limit=2`)).json()) as {
      messages: { id: string }[];
      hasMore: boolean;
      nextBefore: string | null;
    };
    expect(page.messages).toHaveLength(2);
    expect(page.hasMore).toBe(true);

    const empty = (await (await fetch(`${room.url}/api/channels/no-such-channel/messages`)).json()) as {
      messages: unknown[];
    };
    expect(empty.messages).toEqual([]);
  });

  it('clamps the limit parameter', async () => {
    const room = await start();
    const page = (await (await fetch(`${room.url}/api/channels/engineering/messages?limit=9999`)).json()) as {
      messages: unknown[];
    };
    expect(page.messages.length).toBeLessThanOrEqual(200);
  });

  it('serves a single message and 404s for a missing id', async () => {
    const room = await start();
    const page = (await (await fetch(`${room.url}/api/channels/engineering/messages?limit=1`)).json()) as {
      messages: { id: string; text: string }[];
    };
    const id = page.messages[0]!.id;
    const message = (await (await fetch(`${room.url}/api/messages/${encodeURIComponent(id)}`)).json()) as {
      id: string;
    };
    expect(message.id).toBe(id);

    const missing = await fetch(`${room.url}/api/messages/does-not-exist`);
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { error: string };
    expect(body.error).toContain('未找到');
  });

  it('searches messages', async () => {
    const room = await start();
    const data = (await (await fetch(`${room.url}/api/search?q=${encodeURIComponent('游标')}`)).json()) as {
      hits: { text: string }[];
    };
    expect(data.hits.length).toBeGreaterThan(0);
  });

  it('accepts pause requests and validates the body', async () => {
    const room = await start();
    const ok = await fetch(`${room.url}/api/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ paused: true });

    const bad = await fetch(`${room.url}/api/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(bad.status).toBe(400);
  });

  it('opens an SSE stream with the event-stream content type', async () => {
    const room = await start();
    const controller = new AbortController();
    const response = await fetch(`${room.url}/api/stream`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
  });

  it('refuses path traversal and unknown API routes', async () => {
    const room = await start();
    const traversal = await fetch(`${room.url}/../package.json`);
    expect([403, 404]).toContain(traversal.status);
    const unknown = await fetch(`${room.url}/api/nope`);
    expect(unknown.status).toBe(404);
  });
});
