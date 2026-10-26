import { describe, expect, it } from 'vitest';

import { deriveAgentWork } from '../derive.js';
import {
  RelayControlRoomSource,
  needsRefresh,
  readSessionEvidence,
  reduceSessionEvents,
  type RelayMessagingLike,
} from '../relay-source.js';

const NOW = Date.parse('2026-10-26T06:32:08Z');

function observability(sequence: number, timestamp = '2026-10-26T06:30:00Z') {
  return { source: 'broker' as const, fidelity: 'exact' as const, sequence, timestamp };
}

function fakeClient(overrides: Partial<RelayMessagingLike> = {}): RelayMessagingLike {
  return {
    channels: {
      async list() {
        return [
          {
            id: 'ch_1',
            name: 'engineering',
            topic: '接口开发与自动化测试',
            metadata: { displayName: '工程研发' },
            archived: false,
            createdAt: '2026-10-01T00:00:00Z',
            members: [
              { agentId: 'a1', agentName: 'coder-alpha', role: 'member', muted: false },
              { agentId: 'a2', agentName: 'reviewer', role: 'member', muted: false },
            ],
          },
          {
            id: 'ch_2',
            name: 'archive',
            topic: '历史归档',
            metadata: {},
            archived: true,
            createdAt: '2026-09-01T00:00:00Z',
            members: [],
          },
        ] as never;
      },
    },
    agents: {
      async list() {
        return [
          {
            id: 'a1',
            name: 'coder-alpha',
            type: 'agent',
            status: 'online',
            metadata: { displayName: '开发甲', host: 'worker-01' },
            lastSeenAt: '2026-10-26T06:31:50Z',
            channels: [{ id: 'ch_1', name: 'engineering', role: 'member' }],
          },
          {
            id: 'a2',
            name: 'reviewer',
            type: 'agent',
            status: 'online',
            metadata: {},
            lastSeenAt: '2026-10-26T06:31:00Z',
            channels: [{ id: 'ch_1', name: 'engineering', role: 'member' }],
          },
        ] as never;
      },
      async presence() {
        // Presence wins over the agent record: `reviewer`'s stored status is
        // stale-online while the presence plane reports it as disconnected.
        return [
          { agentName: 'coder-alpha', status: 'online' },
          { agentName: 'reviewer', status: 'offline' },
        ];
      },
    },
    messages: {
      async list(_channel: string, options?: { limit?: number }) {
        return [
          {
            id: 'm1',
            messageId: 'm1',
            kind: 'channel',
            text: '第一行\n第二行',
            from: { id: 'a1', name: 'coder-alpha' },
            target: { kind: 'channel', channelName: 'engineering' },
            channel: { id: 'ch_1', name: 'engineering' },
            createdAt: '2026-10-26T06:31:52Z',
            readByCount: 2,
          },
          {
            id: 'm0',
            messageId: 'm0',
            kind: 'dm',
            text: '私信内容',
            from: { id: 'a2', name: 'reviewer' },
            target: { kind: 'agent', agentName: 'coder-alpha' },
            createdAt: '2026-10-25T16:30:00Z',
          },
        ].slice(0, options?.limit ?? 10) as never;
      },
      async get(id: string) {
        return {
          id,
          messageId: id,
          text: '按编号读取',
          from: { name: 'coder-alpha' },
          target: { kind: 'channel', channelName: 'engineering' },
          createdAt: '2026-10-26T06:00:00Z',
        } as never;
      },
    },
    nodes: {
      async list() {
        return [{ name: 'worker-01', status: 'online', capabilities: [], activeAgents: 1 }] as never;
      },
    },
    workspace: {
      async info() {
        return { id: 'ws_1', name: 'relay-test', displayName: '测试工作空间' };
      },
    },
    sessionEvents: {
      async list(agentName: string) {
        if (agentName === 'coder-alpha') {
          return [
            { type: 'turn.started', turnId: 't1', observability: observability(2) },
            { type: 'session.started', observability: observability(1) },
          ];
        }
        return [{ type: 'session.started', observability: observability(1) }];
      },
    },
    ...overrides,
  } as RelayMessagingLike;
}

function makeSource(client: RelayMessagingLike): RelayControlRoomSource {
  return new RelayControlRoomSource({
    workspaceKey: 'ot_live_test',
    client,
    disableStream: true,
    now: () => NOW,
    log: () => {},
  });
}

describe('reduceSessionEvents', () => {
  it('sorts by sequence before reducing', () => {
    const state = reduceSessionEvents([
      { type: 'turn.started', turnId: 't1', observability: observability(3) },
      { type: 'session.started', observability: observability(1) },
    ]);
    expect(state.lastSequence).toBe(3);
    expect(state.activity).toBe('thinking');
  });

  it('ignores legacy events without observability', () => {
    const state = reduceSessionEvents([{ type: 'turn.started', turnId: 't1' }]);
    expect(state.lastSequence).toBe(-1);
    expect(state.activity).toBe('idle');
  });
});

describe('needsRefresh', () => {
  it('re-reads a cached page that lost its timestamps', () => {
    expect(needsRefresh([{ createdAt: '2026-10-26T05:10:29.000Z' }])).toBe(false);
    expect(needsRefresh([{ createdAt: '2026-10-26T05:10:29.000Z' }, { createdAt: '' }])).toBe(true);
    expect(needsRefresh([])).toBe(false);
  });
});

describe('stored session event shapes', () => {
  it('reduces events wrapped in the engine envelope', () => {
    // Shape returned by `sessionEvents.list`: the reducer payload is nested.
    const { state, legacy } = readSessionEvidence([
      {
        id: 'e2',
        type: 'tool.called',
        payload: { callId: 'call-1', tool: '运行测试', observability: observability(2) },
        sequence: 2,
      },
      { id: 'e1', type: 'session.started', payload: { observability: observability(1) }, sequence: 1 },
    ]);
    expect(state.lastSequence).toBe(2);
    expect(state.activity).toBe('using_tool');
    expect(legacy).toBeNull();
    expect(deriveAgentWork(state, 'online').workState).toBe('running');
  });

  it('falls back to legacy status events when no canonical event exists', () => {
    const { state, legacy } = readSessionEvidence([
      { type: 'status.waiting', payload: { reason: '等待依赖扫描' }, sequence: 1 },
    ]);
    expect(state.lastSequence).toBe(-1);
    expect(legacy).toEqual({ status: 'waiting', reason: '等待依赖扫描', at: null });

    const work = deriveAgentWork(state, 'online', legacy);
    expect(work.workState).toBe('waiting');
    expect(work.evidence).toBe('status');
    expect(work.reason).toBe('等待依赖扫描');
    expect(work.task).toContain('等待依赖扫描');
  });

  it('maps blocked legacy status to attention and idle to idle', () => {
    const blocked = readSessionEvidence([{ type: 'status.blocked', payload: {}, sequence: 1 }]);
    expect(deriveAgentWork(blocked.state, 'online', blocked.legacy).workState).toBe('attention');

    const idle = readSessionEvidence([{ type: 'status.idle', payload: {}, sequence: 1 }]);
    const work = deriveAgentWork(idle.state, 'online', idle.legacy);
    expect(work.workState).toBe('idle');
    expect(work.evidence).toBe('status');
  });

  it('never lets a legacy status override canonical task evidence', () => {
    const { state, legacy } = readSessionEvidence([
      { type: 'session.started', payload: { observability: observability(1) }, sequence: 1 },
      { type: 'turn.started', payload: { turnId: 't1', observability: observability(2) }, sequence: 2 },
      { type: 'status.idle', payload: {}, sequence: 3 },
    ]);
    expect(legacy?.status).toBe('idle');
    const work = deriveAgentWork(state, 'online', legacy);
    expect(work.workState).toBe('running');
    expect(work.evidence).toBe('tasks');
  });
});

describe('RelayControlRoomSource', () => {
  it('derives channel and agent state from session events', async () => {
    const source = makeSource(fakeClient());
    await source.start();
    const bootstrap = await source.bootstrap();

    expect(bootstrap.mode).toBe('live');
    expect(bootstrap.timezone).toBe('Asia/Shanghai');
    expect(bootstrap.workspace.displayName).toBe('测试工作空间');

    const engineering = bootstrap.channels.find((channel) => channel.name === 'engineering');
    expect(engineering).toBeDefined();
    expect(engineering!.displayName).toBe('工程研发');
    expect(engineering!.state).toBe('active');
    expect(engineering!.evidence).toBe('tasks');
    expect(engineering!.memberCount).toBe(2);

    const archived = bootstrap.channels.find((channel) => channel.name === 'archive');
    expect(archived!.state).toBe('archived');

    const coder = bootstrap.agents.find((agent) => agent.name === 'coder-alpha');
    expect(coder!.displayName).toBe('开发甲');
    expect(coder!.workState).toBe('running');
    expect(coder!.host).toBe('worker-01');

    const reviewer = bootstrap.agents.find((agent) => agent.name === 'reviewer');
    expect(reviewer!.online).toBe('offline');
    // A bare `session.started` is not work evidence, so an offline agent with
    // nothing else reports no evidence at all rather than a guessed state.
    expect(reviewer!.evidence).toBe('none');
    expect(reviewer!.workState).toBe('offline');
    expect(reviewer!.task).toContain('连接已断开');

    expect(bootstrap.capabilities.sessionEvents).toBe(true);
    expect(bootstrap.capabilities.streaming).toBe(false);
    await source.close();
  });

  it('maps messages with recipients, kinds, and honest receipts', async () => {
    const source = makeSource(fakeClient());
    await source.start();
    const page = await source.messages('engineering', { limit: 10 });

    const broadcast = page.messages.find((message) => message.id === 'm1');
    expect(broadcast!.kindLabel).toBe('频道消息');
    // A channel broadcast's recipient renders as the channel's label, not its
    // stable name, so a Chinese deployment does not leak `engineering` to users.
    expect(broadcast!.toName).toBe('工程研发');
    expect(broadcast!.receipt).toBe('2 位成员已读');
    expect(broadcast!.receiptKnown).toBe(true);
    expect(broadcast!.day).toBe('2026-10-26');
    expect(broadcast!.time).toBe('14:31:52');

    const direct = page.messages.find((message) => message.id === 'm0');
    expect(direct!.kindLabel).toBe('关联私信');
    expect(direct!.toName).toBe('coder-alpha');
    expect(direct!.receiptKnown).toBe(false);
    expect(direct!.time).toBe('00:30:00');
    await source.close();
  });

  it('shows unknown work state when the deployment has no session events', async () => {
    const client = fakeClient({ sessionEvents: undefined });
    const source = makeSource(client);
    await source.start();
    const bootstrap = await source.bootstrap();
    expect(bootstrap.capabilities.sessionEvents).toBe(false);
    const coder = bootstrap.agents.find((agent) => agent.name === 'coder-alpha');
    expect(coder!.workState).toBe('unknown');
    expect(bootstrap.metrics.agentsRunning).toBeNull();
    expect(bootstrap.notice).toContain('未提供任务事件');
    await source.close();
  });

  it('reports a permission problem instead of an empty workspace', async () => {
    const client = fakeClient({
      channels: {
        async list() {
          throw new Error('403 Forbidden');
        },
      },
    });
    const source = makeSource(client);
    await source.start();
    const bootstrap = await source.bootstrap();
    expect(bootstrap.notice).toContain('无权查看');
    expect(bootstrap.connection.state).toBe('error');
    await source.close();
  });

  it('times out a hanging read instead of hanging the page', async () => {
    const client = fakeClient({
      channels: {
        list() {
          return new Promise(() => {}) as never;
        },
      },
    });
    const source = new RelayControlRoomSource({
      workspaceKey: 'ot_live_test',
      client,
      disableStream: true,
      readTimeoutMs: 40,
      now: () => NOW,
      log: () => {},
    });
    const started = Date.now();
    await source.start();
    const bootstrap = await source.bootstrap();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(bootstrap.connection.state).toBe('degraded');
    expect(bootstrap.metrics.channelsWorking).toBeNull();
    expect(bootstrap.metrics.throughput).toBeNull();
    await source.close();
  });

  it('serves live frames to subscribers and stops after close', async () => {
    const source = makeSource(fakeClient());
    await source.start();
    const frames: string[] = [];
    const unsubscribe = source.subscribe((frame) => frames.push(frame.type));
    await source.bootstrap();
    expect(frames).toContain('agents');
    unsubscribe();
    const before = frames.length;
    await source.setPaused(false);
    expect(frames.length).toBe(before);
    await source.close();
  });
});
