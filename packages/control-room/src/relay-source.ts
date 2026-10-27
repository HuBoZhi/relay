/**
 * Live source: reads a Relay workspace and streams its events.
 *
 * Design constraints this file is built around:
 *
 * - **Read-only.** It constructs a messaging client with a workspace key or a
 *   scoped `ot_live_` observer token and only ever calls `list`/`get`/`search`.
 *   Nothing here sends, joins, marks read, or registers an agent.
 * - **Server-side credentials.** The key never leaves this process; the browser
 *   only ever sees view models.
 * - **Evidence over inference.** Work state comes from reduced agent session
 *   events; connectivity comes from presence. Neither is used to guess the
 *   other.
 */

import { createObserverEventSource } from '@agent-relay/sdk/messaging';
import type {
  RelayAgent,
  RelayChannel,
  RelayMessage,
  RelayMessagingEvent,
  RelayMessagingEventsSurface,
  RelayNode,
} from '@agent-relay/sdk/messaging';
import { RelaycastMessagingClient } from '@agent-relay/sdk/messaging';
import {
  createAgentActivityState,
  reduceAgentActivity,
  type AgentActivityState,
  type AgentSessionEvent,
} from '@agent-relay/sdk/session';

import { aggregateChannelState, deriveAgentWork, deriveMetricsFlags } from './derive.js';
import type { DerivedAgentWork, LegacyWorkSignal } from './derive.js';
import {
  displayNameOf,
  localizeDiagnostic,
  resolveTimezone,
  toIso,
  truncate,
  zonedStamp,
  zonedToday,
} from './format.js';
import { agentDisplayName, channelDisplayName, mapMessage } from './mappers.js';
import type { ControlRoomSource, MessageQuery } from './source.js';
import { ThroughputTracker } from './throughput.js';
import type {
  AgentView,
  BootstrapView,
  CapabilityView,
  ChannelView,
  ConnectionState,
  ConnectionView,
  MessagePageView,
  MessageView,
  MetricsView,
  NodeView,
  SearchHitView,
  StreamFrame,
} from './types.js';

/** The messaging surface this source depends on; declared structurally for tests. */
export interface RelayMessagingLike {
  channels: {
    list(options?: { includeArchived?: boolean }): Promise<RelayChannel[]>;
    /** Returns members, which `list` omits on the self-hosted engine. */
    get?(name: string): Promise<RelayChannel>;
  };
  agents: {
    list(options?: unknown): Promise<RelayAgent[]>;
    presence?(): Promise<{ agentName: string; status: string }[]>;
  };
  messages: {
    list(channel: string, options?: { limit?: number; before?: string }): Promise<RelayMessage[]>;
    get(id: string): Promise<RelayMessage>;
    search?(
      query: string,
      options?: { channel?: string; limit?: number }
    ): Promise<{ id: string; channelName: string; agentName: string; text: string; createdAt?: string }[]>;
  };
  nodes?: { list(options?: unknown): Promise<RelayNode[]> };
  workspace?: { info(): Promise<{ id?: string; name?: string } & Record<string, unknown>> };
  sessionEvents?: {
    list(agentName: string, options?: { limit?: number }): Promise<unknown[]>;
  };
}

export interface RelaySourceOptions {
  /** Workspace key (`rk_live_…`) or scoped observer token (`ot_live_…`). */
  workspaceKey: string;
  baseUrl?: string;
  timezone?: string;
  /** Full re-read cadence for channels/agents/nodes/work states. */
  refreshIntervalMs?: number;
  /** Session events fetched per agent when deriving work state. */
  sessionEventLimit?: number;
  /** How many channels get their recent messages warmed on refresh. */
  warmChannelLimit?: number;
  /** Messages kept per channel in memory. */
  messageCacheSize?: number;
  /**
   * Per-read timeout. The SDK retries transport failures with backoff, so a dead
   * endpoint can keep a promise pending for minutes; the room reports a timeout
   * instead of hanging on a spinner.
   */
  readTimeoutMs?: number;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
  /** Injected messaging client (tests). */
  client?: RelayMessagingLike;
  /** Injected observer events surface (tests). */
  events?: RelayMessagingEventsSurface;
  /** Disable the live observer stream (tests / `--no-stream`). */
  disableStream?: boolean;
}

const DEFAULT_REFRESH_MS = 20_000;
const DEFAULT_READ_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_EVENT_LIMIT = 60;
const DEFAULT_WARM_CHANNELS = 24;
const DEFAULT_CACHE_SIZE = 400;
const REFRESH_CONCURRENCY = 6;

function unwrapBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl) return 'relaycast';
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Bound a read so an unreachable or retrying engine cannot hang the page.
 *
 * The SDK retries transport errors with backoff, so a dead endpoint can keep a
 * promise pending for minutes. The control room would rather report "读取超时"
 * and keep the last good snapshot than show a spinner forever.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A cached page is incomplete when any message lost its timestamp. */
export function needsRefresh(cached: { createdAt: string }[]): boolean {
  return cached.some((message) => !message.createdAt);
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Normalize one stored session event.
 *
 * The engine returns events wrapped as `{ id, type, payload: {...}, sequence }`,
 * while the reducer expects the flat `AgentSessionEvent` shape. Both are
 * accepted so a fixture written the flat way still reduces correctly.
 */
function normalizeStoredEvent(raw: unknown): { event: AgentSessionEvent; order: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : null;
  if (!type) return null;
  const payload =
    record.payload && typeof record.payload === 'object' ? (record.payload as Record<string, unknown>) : {};
  const { payload: _ignored, ...outer } = record;
  const event = { ...payload, ...outer, type } as unknown as AgentSessionEvent;

  const observed = (event as { observability?: { sequence?: unknown } }).observability;
  const observedSequence = observed && typeof observed.sequence === 'number' ? observed.sequence : null;
  // `sequence` is the engine's per-agent write order and is the safest sort key;
  // fall back to the observability sequence, then to 0.
  const stored = typeof record.sequence === 'number' ? record.sequence : null;
  return { event, order: stored ?? observedSequence ?? 0 };
}

/**
 * Reduce one agent's stored session events, and report the newest legacy
 * `status.*` signal alongside them.
 *
 * Legacy statuses are kept separate rather than folded into the activity state:
 * they carry far less information, so they may only speak when no canonical
 * event exists.
 */
export function readSessionEvidence(events: unknown[]): {
  state: AgentActivityState;
  legacy: LegacyWorkSignal | null;
} {
  const normalized = events
    .map(normalizeStoredEvent)
    .filter((entry): entry is { event: AgentSessionEvent; order: number } => entry !== null)
    .sort((a, b) => a.order - b.order);

  let state = createAgentActivityState('idle');
  let legacy: LegacyWorkSignal | null = null;
  for (const { event } of normalized) {
    const rawType = String(event.type);
    if (rawType.startsWith('status.')) {
      const record = event as unknown as Record<string, unknown>;
      const reason =
        typeof record.reason === 'string'
          ? record.reason
          : typeof record.message === 'string'
            ? record.message
            : null;
      const at =
        typeof record.at === 'string'
          ? record.at
          : event.observability && typeof event.observability.timestamp === 'string'
            ? event.observability.timestamp
            : null;
      legacy = { status: rawType.slice('status.'.length), reason, at };
    }
    state = reduceAgentActivity(state, event).state;
  }
  return { state, legacy };
}

/** Reduce one agent's stored session events into a work-state input. */
export function reduceSessionEvents(events: unknown[]): AgentActivityState {
  return readSessionEvidence(events).state;
}

function onlineOf(agent: RelayAgent, presence: Map<string, string>): 'online' | 'offline' | 'unknown' {
  const live = presence.get(agent.name);
  const raw = String(live ?? agent.status ?? 'unknown');
  // `away` still accepts delivery, so it counts as connected; what the agent is
  // *doing* is a separate question answered by its task events.
  if (raw === 'online' || raw === 'away') return 'online';
  if (raw === 'offline') return 'offline';
  return 'unknown';
}

function hostOf(agent: RelayAgent): string | null {
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  for (const key of ['host', 'node', 'nodeName', 'node_name'] as const) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

interface ChannelCache {
  name: string;
  displayName: string;
  topic: string;
  archived: boolean;
  createdAt: string | null;
  memberNames: string[];
  lastMessageAt: string | null;
}

interface AgentCache {
  raw: RelayAgent;
  displayName: string;
  online: 'online' | 'offline' | 'unknown';
  work: DerivedAgentWork;
  host: string | null;
  lastActivityAt: string | null;
}

export class RelayControlRoomSource implements ControlRoomSource {
  readonly mode = 'live' as const;
  readonly target: string;
  readonly timezone: string;

  private readonly client: RelayMessagingLike;
  private readonly events: RelayMessagingEventsSurface | undefined;
  private readonly refreshIntervalMs: number;
  private readonly sessionEventLimit: number;
  private readonly warmChannelLimit: number;
  private readonly cacheSize: number;
  private readonly readTimeoutMs: number;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;
  private readonly throughput = new ThroughputTracker();

  private readonly channelCache = new Map<string, ChannelCache>();
  private readonly agentCache = new Map<string, AgentCache>();
  private readonly messageCache = new Map<string, MessageView[]>();
  private readonly listeners = new Set<(frame: StreamFrame) => void>();
  private readonly unsubscribers: (() => void)[] = [];

  private nodeViews: NodeView[] = [];
  private workspace: { id: string | null; name: string; displayName: string; description: string } = {
    id: null,
    name: 'relay',
    displayName: 'Relay 工作空间',
    description: '',
  };
  private sessionEventsAvailable = false;
  /** Whether the deployment exposes a search endpoint (until a call fails). */
  private searchAvailable: boolean;
  private paused = false;
  private streamHealthy = false;
  /** Consecutive stream failures; two or more is treated as "not supported". */
  private streamFailures = 0;
  /** True once the stream opened at least once; distinguishes "never works". */
  private streamEverHealthy = false;
  private refreshCount = 0;
  private refreshFailed = false;
  private cursor: number | null = null;
  private lastEventAt: string | null = null;
  private lastRefreshAt: string | null = null;
  private connectionState: ConnectionState = 'connecting';
  private connectionDetail = '正在读取工作空间数据';
  private notice: string | null = null;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | null = null;

  constructor(options: RelaySourceOptions) {
    if (!options.workspaceKey) throw new Error('RelayControlRoomSource 需要工作空间密钥或观察者令牌');
    this.target = unwrapBaseUrl(options.baseUrl);
    this.timezone = resolveTimezone(options.timezone);
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.sessionEventLimit = options.sessionEventLimit ?? DEFAULT_SESSION_EVENT_LIMIT;
    this.warmChannelLimit = options.warmChannelLimit ?? DEFAULT_WARM_CHANNELS;
    this.cacheSize = options.messageCacheSize ?? DEFAULT_CACHE_SIZE;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    // Keep the console readable: the SDK error objects are large and repeat on
    // every retry cycle.
    this.log =
      options.log ??
      ((message, error) =>
        console.warn(
          `[control-room] ${message}${error === undefined ? '' : `：${error instanceof Error ? error.message : String(error)}`}`
        ));

    this.client =
      options.client ??
      (new RelaycastMessagingClient({
        workspaceKey: options.workspaceKey,
        baseUrl: options.baseUrl,
      }) as unknown as RelayMessagingLike);

    // Report the search surface up front; a failed call flips it to false.
    this.searchAvailable = typeof this.client.messages.search === 'function';

    if (!options.disableStream) {
      this.events =
        options.events ??
        createObserverEventSource({
          observerToken: options.workspaceKey,
          baseUrl: options.baseUrl,
          onCursor: (seq) => {
            this.cursor = seq;
          },
          onError: (error) => this.handleStreamError(error),
        });
    }
  }

  /** Start streaming and run the first refresh. */
  async start(): Promise<void> {
    this.attachEvents();
    await this.refresh().catch((error) => this.log('初次读取失败', error));
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch((error) => this.log('定时刷新失败', error));
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  private attachEvents(): void {
    const events = this.events;
    if (!events) {
      this.connectionState = 'degraded';
      this.connectionDetail = '未启用实时事件流，仅能定时刷新';
      return;
    }

    // One `any` subscription keeps dispatch in a single place: some event names
    // share a union type (`dmReceived | groupDmReceived`), which the SDK's event
    // map cannot index individually.
    this.unsubscribers.push(events.on('any', (event) => this.handleEvent(event)));

    events.connect();
  }

  private handleEvent(event: RelayMessagingEvent): void {
    switch (event.type) {
      case 'connected':
        this.streamHealthy = true;
        this.streamEverHealthy = true;
        this.streamFailures = 0;
        this.setConnection('live', '');
        break;
      case 'disconnected':
      case 'reconnecting':
        this.streamHealthy = false;
        this.streamFailures += 1;
        this.setConnection('reconnecting', '事件流已断开，正在重连');
        break;
      case 'error':
        this.streamHealthy = false;
        this.streamFailures += 1;
        this.setConnection('degraded', '事件流报错，数据可能延迟');
        break;
      case 'permanentlyDisconnected':
        this.streamHealthy = false;
        this.setConnection('error', '事件流已永久断开，请重新启动控制中心');
        break;
      case 'messageCreated':
      case 'messageUpdated':
      case 'threadReply':
        this.ingestMessage(event.channel, event.message);
        break;
      case 'dmReceived':
      case 'groupDmReceived':
        this.ingestDirect(event.conversationId, event.message);
        break;
      case 'agentOnline':
      case 'agentOffline':
        // Presence changed; re-read so work state is not inferred from it.
        void this.refreshAgents().then(() => {
          this.emit({
            type: 'agents',
            agents: this.agentViews(),
            channels: this.channelViews(),
            metrics: this.metrics(),
            connection: this.connectionView(),
          });
        });
        break;
      case 'channelCreated':
      case 'channelUpdated':
      case 'channelArchived':
      case 'memberJoined':
      case 'memberLeft':
        void this.refreshChannels();
        break;
      case 'messageRead':
        if (event.messageId) this.applyReadReceipt(String(event.messageId));
        break;
      default:
        break;
    }
  }

  private handleStreamError(error: unknown): void {
    this.setConnection('degraded', `事件流异常：${localizeDiagnostic(error, '与 Relay 服务的连接被中断')}`);
  }

  private setConnection(state: ConnectionState, detail: string): void {
    this.connectionState = state;
    this.connectionDetail = detail;
    this.emit({ type: 'connection', connection: this.connectionView() });
  }

  private emit(frame: StreamFrame): void {
    for (const listener of this.listeners) {
      try {
        listener(frame);
      } catch (error) {
        this.log('推送事件失败', error);
      }
    }
  }

  private connectionView(): ConnectionView {
    const state = this.paused && this.connectionState === 'live' ? 'paused' : this.connectionState;
    const labels: Record<ConnectionState, string> = {
      connecting: '正在连接',
      live: '已连接 · 实时',
      paused: '已暂停观察',
      reconnecting: '重连中',
      degraded: '连接降级',
      error: '连接失败',
      closed: '已断开',
    };
    return {
      state,
      label: labels[state],
      detail: this.connectionDetail,
      target: this.target,
      mode: this.mode,
      lastEventAt: this.lastEventAt,
      lastRefreshAt: this.lastRefreshAt,
      cursor: this.cursor,
      bufferedEvents: 0,
    };
  }

  // ---------------------------------------------------------------- refresh

  async refresh(): Promise<void> {
    // Collapse concurrent refreshes (timer + explicit request) into one read.
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.runRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async runRefresh(): Promise<void> {
    this.refreshFailed = false;
    this.refreshCount += 1;
    // The four reads are independent; running them together keeps the worst
    // case (an unreachable engine that retries) at one timeout instead of four.
    await Promise.all([
      this.refreshWorkspace(),
      this.refreshChannels(),
      this.refreshAgents(),
      this.refreshNodes(),
    ]);
    await this.warmMessages();
    this.lastRefreshAt = new Date(this.now()).toISOString();

    // Recompute the transport story after every refresh so a recovered read is
    // not stuck behind an old `degraded` label, and a dead stream never reads
    // as healthy just because REST still answers.
    if (this.notice) {
      // A scope/permission refusal is not a transient transport problem: keep
      // saying so until a read actually succeeds.
      this.connectionState = 'error';
      this.connectionDetail = '权限不足，无法读取频道';
    } else if (!this.events) {
      this.connectionState = 'degraded';
      this.connectionDetail = '未启用实时事件流，仅能定时刷新';
    } else if (this.refreshFailed) {
      this.connectionState = 'degraded';
      this.connectionDetail = '读取工作空间失败，正在重试';
    } else if (this.streamHealthy) {
      this.connectionState = 'live';
      this.connectionDetail = '';
    } else if (this.connectionState !== 'paused') {
      // One interrupted socket is normal; an endpoint that never accepts the
      // observer token is a deployment limitation and must be named as such
      // rather than spinning on "重连中" forever.
      // Either repeated failures, or a stream that has never opened after a few
      // reads (an engine that rejects observer tokens on /v1/ws).
      const unsupported = this.streamFailures >= 2 || (this.refreshCount >= 3 && !this.streamEverHealthy);
      this.connectionState = unsupported ? 'degraded' : 'reconnecting';
      this.connectionDetail = unsupported
        ? '该部署未接受实时事件订阅（观察者令牌可能不受支持），已改为定时刷新'
        : '事件流已断开，正在重连';
    }

    this.emit({
      type: 'agents',
      agents: this.agentViews(),
      channels: this.channelViews(),
      metrics: this.metrics(),
      connection: this.connectionView(),
    });
  }

  private async refreshWorkspace(): Promise<void> {
    if (!this.client.workspace) return;
    try {
      const info = await withTimeout(this.client.workspace.info(), this.readTimeoutMs, '读取工作空间信息');
      const name = typeof info.name === 'string' && info.name.trim() ? info.name.trim() : 'relay';
      this.workspace = {
        id: typeof info.id === 'string' ? info.id : null,
        name,
        displayName: displayNameOf(name, info as Record<string, unknown>),
        description:
          typeof info.description === 'string'
            ? info.description
            : typeof info.topic === 'string'
              ? info.topic
              : '',
      };
    } catch (error) {
      this.log('读取工作空间信息失败', error);
    }
  }

  private async refreshChannels(): Promise<void> {
    try {
      const channels = await withTimeout(
        this.client.channels.list({ includeArchived: true }),
        this.readTimeoutMs,
        '读取频道列表'
      );
      const seen = new Set<string>();
      // `channels.list` omits members on the self-hosted engine; only
      // `channels.get` returns them. Fetch members for the channels the list
      // left empty, bounded so 50 channels do not open 50 sockets at once.
      const needMembers = channels.filter((channel) => (channel.members ?? []).length === 0);
      const memberLookups = new Map<string, string[]>();
      if (needMembers.length > 0 && this.client.channels.get) {
        await mapLimit(needMembers, REFRESH_CONCURRENCY, async (channel) => {
          try {
            const full = await withTimeout(
              this.client.channels.get!(channel.name),
              this.readTimeoutMs,
              '读取频道成员'
            );
            const names = (full.members ?? []).map((member) => member.agentName).filter(Boolean);
            if (names.length > 0) memberLookups.set(channel.name, names);
          } catch (error) {
            this.log(`读取 #${channel.name} 成员失败`, error);
          }
        });
      }

      for (const channel of channels) {
        seen.add(channel.name);
        const listed = (channel.members ?? []).map((member) => member.agentName).filter(Boolean);
        const members = listed.length > 0 ? listed : (memberLookups.get(channel.name) ?? []);
        const existing = this.channelCache.get(channel.name);
        this.channelCache.set(channel.name, {
          name: channel.name,
          displayName: channelDisplayName(channel),
          topic: channel.topic ?? '',
          archived: channel.archived === true,
          createdAt: toIso(channel.createdAt),
          memberNames: members.length > 0 ? members : (existing?.memberNames ?? []),
          lastMessageAt: existing?.lastMessageAt ?? null,
        });
      }
      for (const name of this.channelCache.keys()) {
        if (!seen.has(name)) this.channelCache.delete(name);
      }
      this.notice = null;
    } catch (error) {
      this.refreshFailed = true;
      const detail = error instanceof Error ? error.message : String(error);
      if (/403|401|forbidden|unauthorized/i.test(detail)) {
        this.notice = '当前凭据无权查看该工作空间的频道，请使用具备只读权限的观察者令牌';
        this.setConnection('error', '权限不足，无法读取频道');
      } else {
        this.setConnection('degraded', `读取频道失败：${localizeDiagnostic(detail, '无法读取频道列表')}`);
      }
      this.log('读取频道失败', error);
    }
  }

  private async refreshAgents(): Promise<void> {
    try {
      const agents = await withTimeout(this.client.agents.list(), this.readTimeoutMs, '读取智能体列表');
      const presence = new Map<string, string>();
      if (this.client.agents.presence) {
        try {
          for (const entry of await withTimeout(
            this.client.agents.presence(),
            this.readTimeoutMs,
            '读取在线状态'
          )) {
            presence.set(entry.agentName, entry.status);
          }
        } catch (error) {
          this.log('读取在线状态失败', error);
        }
      }

      this.sessionEventsAvailable = Boolean(this.client.sessionEvents);
      const evidence = new Map<string, { state: AgentActivityState; legacy: LegacyWorkSignal | null }>();
      if (this.client.sessionEvents) {
        const names = agents.map((agent) => agent.name);
        const results = await mapLimit(names, REFRESH_CONCURRENCY, async (name) => {
          try {
            const events = await withTimeout(
              this.client.sessionEvents!.list(name, { limit: this.sessionEventLimit }),
              this.readTimeoutMs,
              `读取 ${name} 的任务事件`
            );
            return [name, readSessionEvidence(events)] as const;
          } catch (error) {
            this.log(`读取 ${name} 的任务事件失败`, error);
            return [name, null] as const;
          }
        });
        for (const [name, found] of results) {
          if (found) evidence.set(name, found);
        }
      }

      const seen = new Set<string>();
      for (const agent of agents) {
        seen.add(agent.name);
        const online = onlineOf(agent, presence);
        const found = evidence.get(agent.name) ?? null;
        const work = deriveAgentWork(found?.state ?? null, online, found?.legacy ?? null);
        const displayName = agentDisplayName(agent.name, agent.metadata as Record<string, unknown>);
        const lastActivityAt = found
          ? (toIso(
              found.state.lastSequence >= 0 ? agent.lastSeenAt : (found.legacy?.at ?? agent.lastSeenAt)
            ) ?? null)
          : null;
        this.agentCache.set(agent.name, {
          raw: agent,
          displayName,
          online,
          work,
          host: hostOf(agent),
          lastActivityAt,
        });
      }
      for (const name of this.agentCache.keys()) {
        if (!seen.has(name)) this.agentCache.delete(name);
      }

      // A channel with no member list still knows its members from agent records.
      for (const channel of this.channelCache.values()) {
        if (channel.memberNames.length > 0) continue;
        channel.memberNames = agents
          .filter((agent) => (agent.channels ?? []).some((entry) => entry.name === channel.name))
          .map((agent) => agent.name);
      }
    } catch (error) {
      this.refreshFailed = true;
      this.setConnection('degraded', '读取智能体失败，状态可能延迟');
      this.log('读取智能体失败', error);
    }
  }

  private async refreshNodes(): Promise<void> {
    if (!this.client.nodes) return;
    try {
      const nodes = await withTimeout(this.client.nodes.list(), this.readTimeoutMs, '读取运行主机');
      this.nodeViews = nodes.map((node) => {
        const status =
          node.status === 'online' ? 'online' : node.status === 'offline' ? 'offline' : 'unknown';
        return {
          id: node.id ?? node.nodeId ?? node.name,
          name: node.name,
          displayName: displayNameOf(node.name, node.tags ? { tags: node.tags } : null),
          status,
          statusLabel: status === 'online' ? '在线' : status === 'offline' ? '离线' : '未知',
          agentCount: typeof node.activeAgents === 'number' ? node.activeAgents : null,
          version: node.version ?? null,
          lastHeartbeatAt: toIso(node.lastHeartbeatAt),
        } satisfies NodeView;
      });
    } catch (error) {
      this.log('读取运行主机失败', error);
      this.nodeViews = [];
    }
  }

  /** Warm the newest page of each channel so the list can show recent activity. */
  private async warmMessages(): Promise<void> {
    const names = [...this.channelCache.keys()].slice(0, this.warmChannelLimit);
    await mapLimit(names, REFRESH_CONCURRENCY, async (channelName) => {
      const cached = this.messageCache.get(channelName);
      // Only warm channels we have not loaded; live events keep the rest fresh.
      // A page that arrived without timestamps is re-read once so a transient
      // miss cannot pin "日期未知" and a zero "今日消息" forever.
      if (cached && cached.length > 0 && !needsRefresh(cached)) return;
      try {
        const raw = await withTimeout(
          this.client.messages.list(channelName, { limit: 30 }),
          this.readTimeoutMs,
          '读取最近消息'
        );
        this.messageCache.set(
          channelName,
          raw.map((message) => this.toView(channelName, message))
        );
        this.noteNewest(channelName);
      } catch (error) {
        this.log(`读取 #${channelName} 最近消息失败`, error);
      }
    });
  }

  private toView(channelName: string, raw: RelayMessage): MessageView {
    const channelLabel = this.channelCache.get(channelName)?.displayName ?? channelName;
    const view = mapMessage(raw, { timezone: this.timezone, channelName, channelLabel });
    // A channel broadcast's recipient is the channel, so show the channel's
    // label rather than its stable name.
    if (view.kind === 'channel' && view.to === channelName) view.toName = channelLabel;
    return view;
  }

  private noteNewest(channelName: string): void {
    const list = this.messageCache.get(channelName);
    const newest = list?.[0]?.createdAt || null;
    const channel = this.channelCache.get(channelName);
    if (!channel) return;
    if (!newest) return;
    if (!channel.lastMessageAt || newest > channel.lastMessageAt) channel.lastMessageAt = newest;
  }

  private ingestMessage(channelName: string, raw: RelayMessage): void {
    const view = this.toView(channelName, raw);
    if (!view.id) return;
    const list = this.messageCache.get(channelName) ?? [];
    const index = list.findIndex((item) => item.id === view.id);
    if (index >= 0) list[index] = view;
    else list.unshift(view);
    if (list.length > this.cacheSize) list.length = this.cacheSize;
    this.messageCache.set(channelName, list);

    this.noteNewest(channelName);
    if (index < 0) this.throughput.record(view.createdAt || undefined);
    this.lastEventAt = new Date(this.now()).toISOString();
    if (this.connectionState === 'connecting') this.setConnection('live', '');
    this.emit({ type: 'message', message: view });
  }

  private ingestDirect(conversationId: string, raw: RelayMessage): void {
    // Direct messages are not part of a channel's history. They surface only
    // through an explicit conversation reference, so they are cached under the
    // conversation id and never merged into a channel timeline.
    this.ingestMessage(`会话 ${conversationId}`, raw);
  }

  private applyReadReceipt(messageId: string): void {
    for (const [channelName, list] of this.messageCache) {
      const index = list.findIndex((item) => item.id === messageId);
      if (index < 0) continue;
      const current = list[index];
      if (!current) return;
      const readByCount = (current.readByCount ?? 0) + 1;
      const updated: MessageView = {
        ...current,
        readByCount,
        receipt: current.kind === 'dm' ? '对方已读' : `${readByCount} 位成员已读`,
        receiptKnown: true,
      };
      list[index] = updated;
      this.messageCache.set(channelName, list);
      this.emit({ type: 'message', message: updated });
      return;
    }
  }

  // ----------------------------------------------------------------- views

  private agentViews(): AgentView[] {
    // The engine's agent records carry no channel list; membership only exists
    // on the channel side, so build the reverse index from what we read there.
    const reverse = new Map<string, string[]>();
    for (const [channelName, channel] of this.channelCache) {
      for (const member of channel.memberNames) {
        const list = reverse.get(member) ?? [];
        list.push(channelName);
        reverse.set(member, list);
      }
    }

    const views: AgentView[] = [];
    for (const [name, cache] of this.agentCache) {
      const declared = (cache.raw.channels ?? []).map((channel) => channel.name);
      const channelNames = declared.length > 0 ? declared : (reverse.get(name) ?? []);
      views.push({
        id: cache.raw.id ?? name,
        name,
        displayName: cache.displayName,
        type: String(cache.raw.type ?? 'unknown'),
        typeLabel:
          cache.raw.type === 'human' ? '人工账号' : cache.raw.type === 'system' ? '系统账号' : '智能体',
        online: cache.online,
        onlineLabel:
          cache.online === 'online' ? '在线' : cache.online === 'offline' ? '离线' : '在线状态未知',
        workState: cache.work.workState,
        workStateLabel: cache.work.workStateLabel,
        activity: cache.work.activity,
        task: cache.work.task,
        reason: cache.work.reason,
        host: cache.host,
        channelNames,
        lastSeenAt: toIso(cache.raw.lastSeenAt),
        lastActivityAt: cache.lastActivityAt,
        evidence: cache.work.evidence,
      });
    }
    return views.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
  }

  private channelViews(): ChannelView[] {
    const agents = this.agentViews();
    const byName = new Map(agents.map((agent) => [agent.name, agent]));
    const views: ChannelView[] = [];
    const now = this.now();

    for (const [name, channel] of this.channelCache) {
      const members = channel.memberNames
        .map((member) => byName.get(member))
        .filter((member): member is AgentView => Boolean(member));
      // Both event families count as task evidence; presence and messages do not.
      const hasTaskEvidence = members.some(
        (member) => member.evidence === 'tasks' || member.evidence === 'status'
      );
      const aggregate = aggregateChannelState({
        archived: channel.archived,
        members,
        lastMessageAt: channel.lastMessageAt,
        hasTaskEvidence,
        now,
      });
      views.push({
        id: name,
        name,
        displayName: channel.displayName,
        topic: channel.topic,
        state: aggregate.state,
        stateLabel: aggregate.stateLabel,
        stateReason: aggregate.stateReason,
        evidence: aggregate.evidence,
        archived: channel.archived,
        memberCount: members.length > 0 ? members.length : channel.memberNames.length,
        memberNames: channel.memberNames,
        memberLabels: members.map((member) => member.displayName),
        runningCount: members.filter((member) => member.workState === 'running').length,
        createdAt: channel.createdAt,
        lastMessageAt: channel.lastMessageAt,
      });
    }

    return views.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
  }

  private metrics(): MetricsView {
    const agents = this.agentViews();
    const channels = this.channelViews();
    const flags = deriveMetricsFlags(channels);
    const today = zonedToday(this.timezone, new Date(this.now()));

    let messagesToday = 0;
    let countedChannels = 0;
    for (const [, list] of this.messageCache) {
      countedChannels += 1;
      for (const message of list) {
        if (message.day === today) messagesToday += 1;
      }
    }
    const partial = this.channelCache.size > countedChannels;

    return {
      channelsWorking: flags.channelsWorking,
      channelsAttention: flags.channelsAttention,
      channelsTotal: channels.length,
      agentsRunning: agents.some((agent) => agent.evidence === 'tasks' || agent.evidence === 'status')
        ? agents.filter((agent) => agent.workState === 'running').length
        : null,
      agentsOnline: agents.length > 0 ? agents.filter((agent) => agent.online === 'online').length : null,
      agentsTotal: agents.length,
      messagesToday: countedChannels > 0 ? messagesToday : null,
      messagesTodayPartial: partial,
      // No channels loaded means no traffic was observed either: plot nothing
      // rather than a row of zeros that would read as "quiet".
      throughput: this.channelCache.size > 0 ? this.throughput.snapshot() : null,
    };
  }

  private capabilities(): CapabilityView {
    const agents = [...this.agentCache.values()];
    return {
      sessionEvents: this.sessionEventsAvailable,
      hostPlacement: agents.some((agent) => agent.host !== null),
      search: this.searchAvailable,
      streaming: this.events !== undefined && this.connectionState === 'live',
    };
  }

  async bootstrap(): Promise<BootstrapView> {
    await this.refresh();
    const agents = this.agentViews();
    const channels = this.channelViews();
    const recent = [...this.messageCache.entries()]
      .flatMap(([, list]) => list.slice(0, 3))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 6);

    const missingEvents = !this.sessionEventsAvailable;
    const nothingLoaded = channels.length === 0 && agents.length === 0;
    return {
      mode: this.mode,
      generatedAt: new Date(this.now()).toISOString(),
      timezone: this.timezone,
      workspace: this.workspace,
      connection: this.connectionView(),
      channels,
      agents,
      nodes: this.nodeViews,
      metrics: this.metrics(),
      recentMessages: recent,
      capabilities: this.capabilities(),
      notice:
        this.notice ??
        (nothingLoaded
          ? this.refreshFailed
            ? '读取工作空间失败，请检查 Relay 地址、凭据与网络；恢复后会自动重试'
            : null
          : missingEvents
            ? '部署未提供任务事件，智能体与频道的工作状态显示为未知，仅展示在线状态与消息'
            : null),
    };
  }

  // --------------------------------------------------------------- queries

  async messages(channelName: string, query: MessageQuery): Promise<MessagePageView> {
    const cache = this.messageCache.get(channelName) ?? [];
    const filtered = (list: MessageView[]): MessageView[] => {
      const text = query.query?.trim().toLowerCase() ?? '';
      const from = query.from?.trim();
      return list.filter((message) => {
        if (from && message.from !== from && message.fromName !== from) return false;
        if (query.day && message.day !== query.day) return false;
        if (!text) return true;
        const haystack =
          `${message.text} ${message.fromName} ${message.toName} ${message.channelLabel}`.toLowerCase();
        return haystack.includes(text);
      });
    };

    const hasLocalMatch = filtered(cache).length > 0;
    // Fetch when paging backwards, when the cache is thinner than one page, or
    // when a filter matches nothing locally (the message may be older).
    const needsRemote =
      query.before !== undefined || cache.length < query.limit || (Boolean(query.query) && !hasLocalMatch);
    if (needsRemote) {
      try {
        const raw = await withTimeout(
          this.client.messages.list(channelName, {
            limit: query.limit,
            ...(query.before ? { before: query.before } : {}),
          }),
          this.readTimeoutMs,
          '读取频道消息'
        );
        const fetched = raw.map((message) => this.toView(channelName, message));
        const merged = new Map<string, MessageView>();
        for (const message of [...cache, ...fetched]) {
          if (message.id) merged.set(message.id, message);
        }
        const next = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        this.messageCache.set(channelName, next.slice(0, this.cacheSize));
      } catch (error) {
        this.log(`读取 #${channelName} 消息失败`, error);
      }
    }

    const source = this.messageCache.get(channelName) ?? [];
    const page = filtered(source).slice(0, query.limit);
    const oldest = page.at(-1);
    const total = source.length;
    return {
      channel: channelName,
      messages: page,
      nextBefore: oldest && total > query.limit ? oldest.id : null,
      hasMore: total > page.length,
      total,
    };
  }

  async message(id: string): Promise<MessageView | null> {
    for (const [, list] of this.messageCache) {
      const hit = list.find((item) => item.id === id);
      if (hit) return hit;
    }
    try {
      const raw = await withTimeout(this.client.messages.get(id), this.readTimeoutMs, '读取消息');
      const target = raw.target as { channelName?: unknown } | undefined;
      const channelName =
        raw.channel?.name ?? (typeof target?.channelName === 'string' ? target.channelName : '');
      if (!channelName) return null;
      return this.toView(channelName, raw);
    } catch (error) {
      this.log(`读取消息 ${id} 失败`, error);
      return null;
    }
  }

  async search(query: string, channel?: string): Promise<SearchHitView[]> {
    if (!this.client.messages.search) {
      this.searchAvailable = false;
      return [];
    }
    try {
      const results = await withTimeout(
        this.client.messages.search(query, {
          limit: 40,
          ...(channel ? { channel } : {}),
        }),
        this.readTimeoutMs,
        '搜索消息'
      );
      this.searchAvailable = true;
      return results.map((hit) => {
        const createdAt = toIso(hit.createdAt) ?? '';
        const stamp = createdAt ? zonedStamp(createdAt, this.timezone) : null;
        return {
          id: hit.id,
          channel: hit.channelName,
          channelLabel: this.channelCache.get(hit.channelName)?.displayName ?? hit.channelName,
          from: hit.agentName,
          fromName: agentDisplayName(hit.agentName),
          text: hit.text,
          createdAt,
          day: stamp?.day ?? '日期未知',
          time: stamp?.time ?? '--:--:--',
        } satisfies SearchHitView;
      });
    } catch (error) {
      this.searchAvailable = false;
      this.log('消息搜索失败', error);
      return [];
    }
  }

  // ---------------------------------------------------------------- stream

  subscribe(listener: (frame: StreamFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    this.emit({ type: 'connection', connection: this.connectionView() });
  }

  async close(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Listener teardown must not block shutdown.
      }
    }
    if (this.events) await this.events.disconnect().catch(() => undefined);
    this.connectionState = 'closed';
    this.connectionDetail = '观察已结束';
  }
}
