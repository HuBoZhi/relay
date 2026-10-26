import { afterEach, describe, expect, it } from 'vitest';

import { DemoControlRoomSource } from '../demo-source.js';

const FIXED = Date.parse('2026-10-26T06:32:08Z');
let source: DemoControlRoomSource | null = null;

function make(): DemoControlRoomSource {
  source = new DemoControlRoomSource({ now: () => FIXED, tickMs: 60_000 });
  return source;
}

afterEach(async () => {
  await source?.close();
  source = null;
});

describe('DemoControlRoomSource', () => {
  it('advertises demo mode so the UI can label it', async () => {
    const bootstrap = await make().bootstrap();
    expect(bootstrap.mode).toBe('demo');
    expect(bootstrap.notice).toContain('演示模式');
    expect(bootstrap.connection.mode).toBe('demo');
  });

  it('derives channel states from its demo agents', async () => {
    const bootstrap = await make().bootstrap();
    expect(bootstrap.channels).toHaveLength(8);
    const states = new Map(bootstrap.channels.map((channel) => [channel.name, channel.state]));
    expect(states.get('engineering')).toBe('active');
    expect(states.get('review')).toBe('attention');
    expect(states.get('knowledge')).toBe('idle');
    expect(states.get('archive')).toBe('archived');
    expect(bootstrap.metrics.channelsWorking).toBeGreaterThan(0);
    expect(bootstrap.metrics.agentsTotal).toBe(bootstrap.agents.length);
  });

  it('never reports a channel as working without task evidence', async () => {
    const bootstrap = await make().bootstrap();
    for (const channel of bootstrap.channels) {
      if (channel.state === 'active') expect(channel.evidence).toBe('tasks');
    }
  });

  it('pages messages newest first and stops at the end', async () => {
    const demo = make();
    await demo.bootstrap();
    const first = await demo.messages('engineering', { limit: 2 });
    expect(first.messages).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextBefore).toBe(first.messages[1]?.id ?? null);
    expect(first.messages[0]!.createdAt >= first.messages[1]!.createdAt).toBe(true);

    const second = await demo.messages('engineering', { limit: 50, before: first.nextBefore ?? undefined });
    expect(second.messages.length).toBeGreaterThan(0);
    const firstIds = new Set(first.messages.map((message) => message.id));
    expect(second.messages.some((message) => firstIds.has(message.id))).toBe(false);
  });

  it('filters messages by day and sender', async () => {
    const demo = make();
    await demo.bootstrap();
    const today = demo.today();
    const todayOnly = await demo.messages('engineering', { limit: 50, day: today });
    expect(todayOnly.messages.every((message) => message.day === today)).toBe(true);

    const dm = await demo.messages('engineering', { limit: 50, from: 'coder-alpha' });
    expect(dm.messages.length).toBeGreaterThan(0);
    expect(dm.messages.every((message) => message.from === 'coder-alpha')).toBe(true);
  });

  it('searches message bodies', async () => {
    const demo = make();
    await demo.bootstrap();
    const hits = await demo.search('游标', 'engineering');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain('游标');
  });

  it('labels direct messages as related DMs rather than channel broadcasts', async () => {
    const demo = make();
    await demo.bootstrap();
    const page = await demo.messages('engineering', { limit: 50 });
    const dm = page.messages.find((message) => message.from === 'coder-alpha' && message.kind === 'dm');
    expect(dm).toBeDefined();
    expect(dm!.kindLabel).toBe('关联私信');
    expect(dm!.toName).not.toBe('');
  });

  it('keeps long messages intact for the reading pane', async () => {
    const demo = make();
    await demo.bootstrap();
    const page = await demo.messages('engineering', { limit: 50 });
    const long = page.messages.find((message) => message.text.length > 400);
    expect(long).toBeDefined();
    expect(long!.text.split('\n').length).toBeGreaterThan(3);
  });
});
