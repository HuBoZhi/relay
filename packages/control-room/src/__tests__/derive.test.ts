import { describe, expect, it } from 'vitest';

import type { AgentActivityState } from '@agent-relay/sdk/session';

import { aggregateChannelState, deriveAgentWork, deriveMetricsFlags, receiptLabel } from '../derive.js';
import type { AgentViewLike } from '../derive.js';

function activityState(patch: Partial<AgentActivityState> = {}): AgentActivityState {
  return {
    activity: 'idle',
    starting: false,
    turnActive: false,
    turnFinished: true,
    failed: false,
    lastSequence: 4,
    activeTextBlocks: new Set(),
    activeReasoningBlocks: new Set(),
    activeTools: new Map(),
    pendingApprovals: new Map(),
    ...patch,
  };
}

const agent = (patch: Partial<AgentViewLike>): AgentViewLike => ({
  name: 'coder',
  displayName: '开发甲',
  workState: 'running',
  online: 'online',
  ...patch,
});

describe('deriveAgentWork', () => {
  it('reports unknown when no task event was ever observed', () => {
    const work = deriveAgentWork(activityState({ lastSequence: -1, activity: 'idle' }), 'online');
    expect(work.workState).toBe('unknown');
    expect(work.evidence).toBe('presence');
    expect(work.task).toContain('无法确认');
  });

  it('never claims idle from presence alone', () => {
    const work = deriveAgentWork(null, 'online');
    expect(work.workState).not.toBe('idle');
    expect(work.workState).toBe('unknown');
  });

  it('maps thinking and tool use to running', () => {
    expect(deriveAgentWork(activityState({ activity: 'thinking' }), 'online').workState).toBe('running');
    const tool = deriveAgentWork(
      activityState({
        activity: 'using_tool',
        activeTools: new Map([['call-1', { callId: 'call-1', name: '测试运行器' }]]),
      }),
      'online'
    );
    expect(tool.workState).toBe('running');
    expect(tool.task).toContain('测试运行器');
  });

  it('surfaces the wait reason', () => {
    const work = deriveAgentWork(
      activityState({ activity: 'waiting', waitingReason: 'tool_approval' }),
      'online'
    );
    expect(work.workState).toBe('waiting');
    expect(work.reason).toBe('等待工具审批');
  });

  it('treats a failed runtime as attention with the error code', () => {
    const work = deriveAgentWork(activityState({ failed: true, errorReason: 'harness_crash' }), 'online');
    expect(work.workState).toBe('attention');
    expect(work.reason).toContain('harness_crash');
  });

  it('lets connectivity win over the last known activity', () => {
    const work = deriveAgentWork(activityState({ activity: 'thinking' }), 'offline');
    expect(work.workState).toBe('offline');
    expect(work.task).toContain('连接已断开');
  });
});

describe('aggregateChannelState', () => {
  const base = {
    archived: false,
    lastMessageAt: null,
    hasTaskEvidence: true,
    now: Date.parse('2026-10-26T06:32:00Z'),
  };

  it('marks archived channels first', () => {
    const result = aggregateChannelState({ ...base, archived: true, members: [agent({})] });
    expect(result.state).toBe('archived');
    expect(result.stateLabel).toBe('已归档');
  });

  it('reports attention before running so blockers surface', () => {
    const result = aggregateChannelState({
      ...base,
      members: [
        agent({ workState: 'running' }),
        agent({ name: 'sec', displayName: '安全审查', workState: 'attention' }),
      ],
    });
    expect(result.state).toBe('attention');
    expect(result.stateReason).toContain('安全审查');
  });

  it('aggregates running members into 工作中', () => {
    const result = aggregateChannelState({ ...base, members: [agent({})] });
    expect(result.state).toBe('active');
    expect(result.stateLabel).toBe('工作中');
    expect(result.stateReason).toContain('开发甲');
  });

  it('does not claim working from a recent message alone', () => {
    const result = aggregateChannelState({
      ...base,
      hasTaskEvidence: false,
      members: [agent({ workState: 'unknown' })],
      lastMessageAt: '2026-10-26T06:20:00Z',
    });
    expect(result.state).toBe('unknown');
    expect(result.stateLabel).toBe('近期有消息');
    expect(result.evidence).toBe('messages');
  });

  it('reports unknown for a channel with no visible members', () => {
    const result = aggregateChannelState({ ...base, members: [] });
    expect(result.state).toBe('unknown');
    expect(result.stateReason).toContain('无法判断');
  });

  it('reports idle only from confirmed idle evidence', () => {
    const result = aggregateChannelState({ ...base, members: [agent({ workState: 'idle' })] });
    expect(result.state).toBe('idle');
  });
});

describe('receiptLabel', () => {
  it('does not upgrade enqueue into read', () => {
    expect(receiptLabel('channel', null)).toEqual({ text: '读取状态未知', known: false });
    expect(receiptLabel('channel', 0)).toEqual({ text: '已入队 · 暂无读取回执', known: true });
    expect(receiptLabel('channel', 3)).toEqual({ text: '3 位成员已读', known: true });
    expect(receiptLabel('dm', 1)).toEqual({ text: '对方已读', known: true });
  });
});

describe('deriveMetricsFlags', () => {
  it('keeps unknown counts distinct from zero', () => {
    const unknown = deriveMetricsFlags([{ state: 'unknown' }, { state: 'unknown' }]);
    expect(unknown.channelsWorking).toBeNull();
    expect(unknown.channelsAttention).toBeNull();
    const known = deriveMetricsFlags([{ state: 'active' }, { state: 'unknown' }]);
    expect(known.channelsWorking).toBe(1);
  });
});
