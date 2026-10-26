/**
 * Status derivation: the one place that decides what a node or channel is doing.
 *
 * The rules here exist because the misleading version of this UI is easy to
 * build: "has a live socket" becomes "working", "sent a message recently"
 * becomes "busy", and a zero replaces an unknown count. Each helper therefore
 * demands a specific piece of evidence and says so in Chinese when it has none.
 */

import type { AgentActivityState } from '@agent-relay/sdk/session';

import type { ChannelState, ChannelView, StateEvidence, WorkState } from './types.js';

export const WORK_STATE_LABELS: Record<WorkState, string> = {
  running: '执行中',
  waiting: '等待',
  idle: '空闲',
  attention: '异常',
  offline: '离线',
  unknown: '未知',
};

export const CHANNEL_STATE_LABELS: Record<ChannelState, string> = {
  active: '工作中',
  attention: '待关注',
  waiting: '等待',
  idle: '空闲',
  archived: '已归档',
  unknown: '未知',
};

/** Channel label used when the only evidence is a recent message. */
export const RECENT_MESSAGE_LABEL = '近期有消息';

/**
 * The legacy `status.*` family some engines still expose.
 *
 * Canonical session events (`turn.started`, `tool.called`, …) are the richer
 * source, but a deployment that predates them — or an engine that only accepts
 * `status.active|idle|waiting|blocked` — still reports something usable. It is
 * tracked separately and only consulted when no canonical event exists, so a
 * status ping can never override measured task evidence.
 */
export interface LegacyWorkSignal {
  /** `active`, `idle`, `waiting`, `blocked`, or whatever the engine sent. */
  status: string;
  reason: string | null;
  at: string | null;
}

export interface DerivedAgentWork {
  workState: WorkState;
  workStateLabel: string;
  activity: string | null;
  task: string;
  reason: string | null;
  evidence: StateEvidence;
}

const REASON_LABELS: Record<string, string> = {
  tool_approval: '等待工具审批',
  session_starting: '会话启动中',
  turn_processing: '正在处理本轮任务',
  settled: '本轮任务已结束',
  text_output: '正在输出内容',
  reasoning: '正在推理',
  tool_call: '正在调用工具',
};

function describeReason(reason: string | undefined, toolName?: string): string | null {
  if (!reason) return null;
  if (reason === 'tool_call') return toolName ? `正在调用工具：${toolName}` : '正在调用工具';
  const mapped = REASON_LABELS[reason];
  if (mapped) return mapped;
  // Free-form reasons come from the runtime (e.g. `session.suspended`). Surface
  // them verbatim rather than inventing a category for them.
  return reason;
}

/**
 * Whether a reduced state carries an actual work signal.
 *
 * A bare `session.started` proves a session exists, not that anything is
 * running — `deriveActivity` still reports `idle` for it. Treating that as
 * authoritative would mask the legacy `status.*` signal some engines send
 * instead of canonical `turn.*` events, so idle-from-startup must not win.
 */
export function hasCanonicalWorkSignal(state: AgentActivityState): boolean {
  return (
    state.starting ||
    state.failed ||
    state.turnActive ||
    state.turnFinished ||
    Boolean(state.waitingReason) ||
    state.activeTools.size > 0 ||
    state.activeTextBlocks.size > 0 ||
    state.activeReasoningBlocks.size > 0 ||
    state.pendingApprovals.size > 0
  );
}

/**
 * Turn a reduced activity state into a work status.
 *
 * `online` is connectivity and is applied last: an agent whose socket died is
 * `offline` even if its last known activity was `thinking`. `legacy` is a
 * fallback used only when no canonical work signal exists.
 */
export function deriveAgentWork(
  activityState: AgentActivityState | null,
  online: 'online' | 'offline' | 'unknown',
  legacy: LegacyWorkSignal | null = null
): DerivedAgentWork {
  const label = (state: WorkState): string => WORK_STATE_LABELS[state];
  const canonical =
    activityState && activityState.lastSequence >= 0 && hasCanonicalWorkSignal(activityState)
      ? activityState
      : null;

  if (!canonical) {
    // A legacy status is worth reporting even when the agent is offline — say
    // what it was last doing instead of discarding the only evidence we have.
    if (legacy) return deriveFromLegacyStatus(legacy, online);
    // Presence alone cannot prove "idle": the doc's definition of idle requires
    // positive confirmation that nothing runs.
    if (online === 'offline') {
      return {
        workState: 'offline',
        workStateLabel: label('offline'),
        activity: null,
        task: '连接已断开，无法获取当前任务',
        reason: null,
        evidence: 'none',
      };
    }
    return {
      workState: 'unknown',
      workStateLabel: label('unknown'),
      activity: null,
      task: online === 'online' ? '在线，但缺少任务事件，无法确认工作状态' : '缺少任务事件与在线状态',
      reason: null,
      evidence: online === 'unknown' ? 'none' : 'presence',
    };
  }

  const activity = canonical.activity;
  let workState: WorkState;
  let task: string;
  let reason: string | null = null;

  if (canonical.failed || activity === 'error') {
    workState = 'attention';
    reason = canonical.errorReason ? `运行错误：${canonical.errorReason}` : '运行错误';
    task = reason;
  } else if (activity === 'waiting') {
    workState = 'waiting';
    reason = describeReason(canonical.waitingReason ?? '等待输入');
    task = reason ?? '等待依赖或输入';
  } else if (activity === 'idle') {
    workState = 'idle';
    task = '本轮任务已结束，当前没有执行中的任务';
  } else if (activity === 'starting') {
    workState = 'running';
    task = describeReason('session_starting') ?? '会话启动中';
  } else if (activity === 'using_tool') {
    workState = 'running';
    const tool = [...canonical.activeTools.values()].at(-1);
    task = describeReason('tool_call', tool?.name) ?? '正在调用工具';
  } else if (activity === 'typing') {
    workState = 'running';
    task = describeReason('text_output') ?? '正在输出内容';
  } else if (activity === 'thinking') {
    workState = 'running';
    task = describeReason('reasoning') ?? '正在处理本轮任务';
  } else {
    workState = 'unknown';
    task = '任务事件无法归类';
  }

  if (online === 'offline') {
    return {
      workState: 'offline',
      workStateLabel: label('offline'),
      activity,
      task: `连接已断开 · 最后状态：${WORK_STATE_LABELS[workState]}`,
      reason,
      evidence: 'tasks',
    };
  }

  return {
    workState,
    workStateLabel: label(workState),
    activity,
    task,
    reason,
    evidence: 'tasks',
  };
}

const LEGACY_STATUS_MAP: Record<string, { state: WorkState; task: string }> = {
  active: { state: 'running', task: '状态事件报告：正在执行任务' },
  waiting: { state: 'waiting', task: '状态事件报告：等待依赖或输入' },
  blocked: { state: 'attention', task: '状态事件报告：任务阻塞' },
  idle: { state: 'idle', task: '状态事件报告：当前没有执行中的任务' },
};

/** Map a legacy `status.*` signal, keeping its reason verbatim. */
function deriveFromLegacyStatus(
  legacy: LegacyWorkSignal,
  online: 'online' | 'offline' | 'unknown'
): DerivedAgentWork {
  const mapped = LEGACY_STATUS_MAP[legacy.status];
  const state: WorkState = mapped ? mapped.state : 'unknown';
  const task = mapped
    ? legacy.reason && (state === 'waiting' || state === 'attention')
      ? `${mapped.task}：${legacy.reason}`
      : mapped.task
    : `状态事件「${legacy.status}」无法归类`;
  const reason = state === 'waiting' || state === 'attention' ? legacy.reason : null;

  if (online === 'offline') {
    return {
      workState: 'offline',
      workStateLabel: WORK_STATE_LABELS.offline,
      activity: null,
      task: `连接已断开 · 最后状态：${WORK_STATE_LABELS[state]}`,
      reason,
      evidence: 'status',
    };
  }

  return {
    workState: state,
    workStateLabel: WORK_STATE_LABELS[state],
    activity: null,
    task,
    reason,
    evidence: 'status',
  };
}

export interface ChannelAggregateInput {
  archived: boolean;
  members: Pick<AgentViewLike, 'name' | 'displayName' | 'workState' | 'online'>[];
  /** Newest message the server has seen for this channel, ISO-8601. */
  lastMessageAt: string | null;
  /** Whether any member carried task evidence. */
  hasTaskEvidence: boolean;
  /** Message counts as recent inside this window (ms). */
  recentWindowMs?: number;
  now?: number;
}

/** The subset of an agent the channel aggregate needs. */
export interface AgentViewLike {
  name: string;
  displayName: string;
  workState: WorkState;
  online: 'online' | 'offline' | 'unknown';
}

export interface ChannelAggregate {
  state: ChannelState;
  stateLabel: string;
  stateReason: string;
  evidence: StateEvidence;
}

const DEFAULT_RECENT_WINDOW_MS = 30 * 60 * 1000;
const MAX_NAMED = 3;

function nameList(members: AgentViewLike[]): string {
  const names = members.slice(0, MAX_NAMED).map((member) => member.displayName);
  const extra = members.length - names.length;
  return extra > 0 ? `${names.join('、')} 等 ${members.length} 个智能体` : names.join('、');
}

/**
 * Aggregate a channel's state from its members' evidenced work states.
 *
 * Precedence is attention → running → waiting → idle, because the operator
 * needs to see a blocker before throughput. `archived` wins over everything:
 * an archived channel keeps its history but makes no claim about its members.
 */
export function aggregateChannelState(input: ChannelAggregateInput): ChannelAggregate {
  if (input.archived) {
    return {
      state: 'archived',
      stateLabel: CHANNEL_STATE_LABELS.archived,
      stateReason: '频道已归档，历史消息仍可查询',
      evidence: 'none',
    };
  }

  if (input.members.length === 0) {
    return {
      state: 'unknown',
      stateLabel: CHANNEL_STATE_LABELS.unknown,
      stateReason: '频道没有可见成员，无法判断工作状态',
      evidence: 'none',
    };
  }

  const now = input.now ?? Date.now();
  const recentMessage =
    input.lastMessageAt !== null &&
    now - new Date(input.lastMessageAt).getTime() <= (input.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS);

  if (input.hasTaskEvidence) {
    const attention = input.members.filter((member) => member.workState === 'attention');
    if (attention.length > 0) {
      return {
        state: 'attention',
        stateLabel: CHANNEL_STATE_LABELS.attention,
        stateReason: `${nameList(attention)} 报告异常或阻塞`,
        evidence: 'tasks',
      };
    }

    const running = input.members.filter((member) => member.workState === 'running');
    if (running.length > 0) {
      return {
        state: 'active',
        stateLabel: CHANNEL_STATE_LABELS.active,
        stateReason: `${nameList(running)} 正在执行任务`,
        evidence: 'tasks',
      };
    }

    const waiting = input.members.filter((member) => member.workState === 'waiting');
    if (waiting.length > 0) {
      return {
        state: 'waiting',
        stateLabel: CHANNEL_STATE_LABELS.waiting,
        stateReason: `${nameList(waiting)} 正在等待依赖或输入`,
        evidence: 'tasks',
      };
    }

    const unknown = input.members.filter((member) => member.workState === 'unknown');
    if (unknown.length > 0) {
      return {
        state: 'unknown',
        stateLabel: CHANNEL_STATE_LABELS.unknown,
        stateReason: `${nameList(unknown)} 缺少任务事件，工作状态未知`,
        evidence: 'presence',
      };
    }

    const idle = input.members.filter((member) => member.workState === 'idle');
    if (idle.length > 0) {
      return {
        state: 'idle',
        stateLabel: CHANNEL_STATE_LABELS.idle,
        stateReason: `${nameList(idle)} 已确认没有执行中的任务`,
        evidence: 'tasks',
      };
    }

    const offline = input.members.filter((member) => member.workState === 'offline');
    return {
      state: 'unknown',
      stateLabel: CHANNEL_STATE_LABELS.unknown,
      stateReason: `${nameList(offline)} 已离线，无法确认工作状态`,
      evidence: 'presence',
    };
  }

  // No task evidence anywhere in the channel. Only say what the messages prove.
  if (recentMessage) {
    return {
      state: 'unknown',
      stateLabel: RECENT_MESSAGE_LABEL,
      stateReason: '该频道近期有消息，但缺少任务事件，不能据此判定为工作中',
      evidence: 'messages',
    };
  }

  if (input.lastMessageAt) {
    return {
      state: 'unknown',
      stateLabel: CHANNEL_STATE_LABELS.unknown,
      stateReason: '缺少任务事件，且近期没有消息',
      evidence: 'messages',
    };
  }

  return {
    state: 'unknown',
    stateLabel: CHANNEL_STATE_LABELS.unknown,
    stateReason: '缺少任务事件与消息记录，无法判断工作状态',
    evidence: 'none',
  };
}

/** Delivery wording that never upgrades enqueue into read. */
export function receiptLabel(kind: string, readByCount: number | null): { text: string; known: boolean } {
  if (readByCount !== null && readByCount > 0) {
    return { text: kind === 'dm' ? '对方已读' : `${readByCount} 位成员已读`, known: true };
  }
  if (readByCount === 0) {
    return { text: '已入队 · 暂无读取回执', known: true };
  }
  return { text: '读取状态未知', known: false };
}

/** Count metrics from the current view, keeping "unknown" distinct from zero. */
export function deriveMetricsFlags(channels: Pick<ChannelView, 'state'>[]): {
  channelsWorking: number | null;
  channelsAttention: number | null;
  evidenced: boolean;
} {
  const evidenced = channels.some((channel) => channel.state !== 'unknown');
  return {
    channelsWorking: evidenced ? channels.filter((channel) => channel.state === 'active').length : null,
    channelsAttention: evidenced ? channels.filter((channel) => channel.state === 'attention').length : null,
    evidenced,
  };
}
