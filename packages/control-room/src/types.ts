/**
 * The control room's view contract.
 *
 * Everything the browser receives is defined here: the bootstrap snapshot, the
 * paged message API, and the live stream frames. The browser never sees a Relay
 * credential, a workspace key, or a raw wire payload — only these shapes.
 *
 * Two rules the shapes encode deliberately:
 *
 * 1. Unknown is never zero or idle. Every nullable count and every status that
 *    cannot be evidenced carries an explicit `unknown`/`null` instead of a
 *    plausible-looking default.
 * 2. Stable identifiers and display names are separate fields. `id` keys
 *    selection, filtering, and live updates; `displayName` is what a Chinese UI
 *    shows and may fall back to the identifier when no localized name exists.
 */

/** Where the data comes from. `demo` means no credential was configured. */
export type ControlRoomMode = 'live' | 'demo';

/**
 * Connection lifecycle reported to the browser.
 *
 * `paused` is the user's own freeze: the server keeps ingesting, the view stops
 * applying. `reconnecting` and `degraded` are transport facts and must never be
 * rendered as healthy.
 */
export type ConnectionState =
  | 'connecting'
  | 'live'
  | 'paused'
  | 'reconnecting'
  | 'degraded'
  | 'error'
  | 'closed';

export interface ConnectionView {
  state: ConnectionState;
  /** Short Chinese label for the state, e.g. `已连接 · 实时` */
  label: string;
  /** Why the connection is in this state, in Chinese. Empty when healthy. */
  detail: string;
  /** Relay base URL host (never the credential) the server is observing. */
  target: string;
  mode: ControlRoomMode;
  /** ISO-8601 timestamp of the last applied live event. */
  lastEventAt: string | null;
  /** ISO-8601 timestamp of the last successful full refresh. */
  lastRefreshAt: string | null;
  /** Durable stream cursor (per-workspace sequence), when known. */
  cursor: number | null;
  /** Count of events received while the view was paused and not yet applied. */
  bufferedEvents: number;
}

/**
 * Working state of a node.
 *
 * `online` (connectivity) and `workState` (what it is doing) are separate
 * fields on purpose: a live agent is not automatically working.
 */
export type WorkState = 'running' | 'waiting' | 'idle' | 'attention' | 'offline' | 'unknown';

/**
 * What evidence a state was derived from. Rendered next to the status text.
 *
 * `tasks` = canonical session events (`turn.*`, `tool.*`, …); `status` = the
 * legacy `status.*` family some engines still expose; `presence` = connectivity
 * only; `messages` = recent message activity.
 */
export type StateEvidence = 'tasks' | 'status' | 'presence' | 'messages' | 'none';

export interface AgentView {
  id: string;
  name: string;
  displayName: string;
  type: string;
  typeLabel: string;
  /** Connectivity only. */
  online: 'online' | 'offline' | 'unknown';
  onlineLabel: string;
  /** What the agent is doing, derived from task/session events. */
  workState: WorkState;
  workStateLabel: string;
  /** Activity code from the SDK reducer (`thinking`, `using_tool`, …) when known. */
  activity: string | null;
  /** Human-readable current task or the reason there is none. */
  task: string;
  /** Wait/block reason when `workState` is `waiting` or `attention`. */
  reason: string | null;
  /** Runtime host, when the deployment exposes agent→host placement. */
  host: string | null;
  channelNames: string[];
  lastSeenAt: string | null;
  lastActivityAt: string | null;
  evidence: StateEvidence;
}

export type ChannelState = 'active' | 'attention' | 'waiting' | 'idle' | 'archived' | 'unknown';

export interface ChannelView {
  id: string;
  name: string;
  displayName: string;
  topic: string;
  state: ChannelState;
  stateLabel: string;
  /** Why the channel is in this state, in Chinese, e.g. `开发甲 正在执行任务`. */
  stateReason: string;
  /** Whether `state` came from task events, only recent messages, or nothing. */
  evidence: StateEvidence;
  archived: boolean;
  memberCount: number;
  memberNames: string[];
  memberLabels: string[];
  runningCount: number;
  /** ISO-8601 creation time, when reported. */
  createdAt: string | null;
  /** ISO-8601 of the newest message the server has seen. */
  lastMessageAt: string | null;
}

export type MessageKindLabel = '频道消息' | '关联私信' | '群组私信' | '线程回复' | '类型未知';

export interface MessageView {
  id: string;
  channel: string;
  channelName: string;
  channelLabel: string;
  from: string;
  fromName: string;
  /** Receiving agent, channel, or conversation. Never inferred from the open channel. */
  to: string;
  toName: string;
  kind: 'channel' | 'dm' | 'group_dm' | 'thread_reply' | 'unknown';
  kindLabel: MessageKindLabel;
  text: string;
  /** ISO-8601 in UTC; the browser formats with the reported timezone. */
  createdAt: string;
  /** `2026-10-26` in the room timezone. */
  day: string;
  /** `14:32:06` in the room timezone. */
  time: string;
  /** Delivery/read statement backed by evidence, else `读取状态未知`. */
  receipt: string;
  /** False when no receipt data exists — the UI must not imply delivery then. */
  receiptKnown: boolean;
  threadId: string | null;
  parentId: string | null;
  readByCount: number | null;
}

export interface NodeView {
  id: string;
  name: string;
  displayName: string;
  status: 'online' | 'offline' | 'unknown';
  statusLabel: string;
  agentCount: number | null;
  version: string | null;
  lastHeartbeatAt: string | null;
}

export interface ThroughputPoint {
  /** Bucket start, ISO-8601. */
  at: string;
  count: number;
}

export interface ThroughputView {
  /** Bucket width in minutes. */
  bucketMinutes: number;
  /** Window length in minutes. */
  windowMinutes: number;
  points: ThroughputPoint[];
  /** Total messages counted inside the window. */
  total: number;
  /**
   * Where the sample came from. The control room only counts events it actually
   * observed, so the label never claims historical precision it does not have.
   */
  source: 'stream';
}

export interface MetricsView {
  /** `null` when the count cannot be evidenced (rendered as 暂无数据). */
  channelsWorking: number | null;
  channelsAttention: number | null;
  channelsTotal: number;
  agentsRunning: number | null;
  agentsOnline: number | null;
  agentsTotal: number;
  /** Messages seen today (room timezone) in channels the server has loaded. */
  messagesToday: number | null;
  /** True when `messagesToday` is a lower bound because not every channel was scanned. */
  messagesTodayPartial: boolean;
  throughput: ThroughputView | null;
}

export interface CapabilityView {
  /** Session/task events are available, so `工作状态` is evidence-based. */
  sessionEvents: boolean;
  /** Agent→host placement is exposed. */
  hostPlacement: boolean;
  /** Server-side message search is available. */
  search: boolean;
  /** A live event stream is connected. */
  streaming: boolean;
}

export interface WorkspaceView {
  id: string | null;
  name: string;
  displayName: string;
  description: string;
}

export interface BootstrapView {
  mode: ControlRoomMode;
  generatedAt: string;
  /** IANA timezone used for every `day`/`time` field. */
  timezone: string;
  workspace: WorkspaceView;
  connection: ConnectionView;
  channels: ChannelView[];
  agents: AgentView[];
  nodes: NodeView[];
  metrics: MetricsView;
  recentMessages: MessageView[];
  capabilities: CapabilityView;
  /** Set when the deployment reports a permission or scope restriction. */
  notice: string | null;
}

export interface MessagePageView {
  channel: string;
  messages: MessageView[];
  /** Cursor to pass back as `before` for an older page; `null` at the end. */
  nextBefore: string | null;
  hasMore: boolean;
  /** Total messages loaded for this channel on the server, when known. */
  total: number | null;
}

export interface SearchHitView {
  channel: string;
  channelLabel: string;
  from: string;
  fromName: string;
  text: string;
  createdAt: string;
  day: string;
  time: string;
  id: string;
}

/** Live stream frames. One SSE `event:` name per member. */
export type StreamFrame =
  | { type: 'connection'; connection: ConnectionView }
  | { type: 'bootstrap'; bootstrap: BootstrapView }
  | { type: 'message'; message: MessageView }
  | {
      type: 'agents';
      agents: AgentView[];
      channels: ChannelView[];
      metrics: MetricsView;
      connection: ConnectionView;
    }
  | { type: 'ping'; at: string };

/** SSE event names, kept in one place so server and client cannot drift. */
export const STREAM_EVENT_NAMES = ['connection', 'bootstrap', 'message', 'agents', 'ping'] as const;
