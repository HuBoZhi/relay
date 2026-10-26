/**
 * Demo source: what the control room shows when no credential is configured.
 *
 * It exists so the interface can be reviewed (and the real rendering paths
 * exercised) without a deployment. Every visible string is Chinese, every
 * channel/agent is fictional, and the bootstrap advertises `mode: 'demo'` so the
 * UI can label it as such. It implements the same interface as the live source,
 * including the paging, search, and stream frames, so nothing in the renderer
 * is demo-only.
 */

import { aggregateChannelState, deriveMetricsFlags } from './derive.js';
import { resolveTimezone, shiftDay, zonedStamp, zonedToday } from './format.js';
import type { ControlRoomSource, MessageQuery } from './source.js';
import { ThroughputTracker } from './throughput.js';
import type {
  AgentView,
  BootstrapView,
  ChannelView,
  ConnectionView,
  MessagePageView,
  MessageView,
  MetricsView,
  NodeView,
  SearchHitView,
  StreamFrame,
  WorkState,
} from './types.js';

interface DemoAgentSeed {
  name: string;
  display: string;
  workState: WorkState;
  task: string;
  host: string;
  online?: 'online' | 'offline';
}

interface DemoChannelSeed {
  name: string;
  display: string;
  topic: string;
  archived?: boolean;
  agents: DemoAgentSeed[];
}

const DEMO_CHANNELS: DemoChannelSeed[] = [
  {
    name: 'coordination',
    display: '任务协调',
    topic: '任务分解、分派与跨频道协作',
    agents: [
      {
        name: 'relay',
        display: '协调中枢',
        workState: 'running',
        task: '正在分派当前工作包',
        host: '调度主机一',
      },
      {
        name: 'planner',
        display: '规划员',
        workState: 'running',
        task: '正在更新执行计划',
        host: '调度主机一',
      },
    ],
  },
  {
    name: 'engineering',
    display: '工程研发',
    topic: '接口开发、代码实现与自动化测试',
    agents: [
      {
        name: 'coder-alpha',
        display: '开发甲',
        workState: 'running',
        task: '正在实现事件订阅接口',
        host: '运行主机一',
      },
      {
        name: 'coder-beta',
        display: '开发乙',
        workState: 'running',
        task: '正在完善断线重连逻辑',
        host: '运行主机一',
      },
      {
        name: 'test-runner',
        display: '测试员',
        workState: 'running',
        task: '正在执行消息投递测试',
        host: '运行主机二',
      },
      {
        name: 'reviewer',
        display: '审查员',
        workState: 'waiting',
        task: '等待实现完成后审查',
        host: '运行主机二',
      },
    ],
  },
  {
    name: 'research',
    display: '研究分析',
    topic: '技术调研、信息验证与方案比较',
    agents: [
      {
        name: 'researcher',
        display: '研究员',
        workState: 'running',
        task: '正在研究事件重放语义',
        host: '运行主机一',
      },
      {
        name: 'analyst',
        display: '分析员',
        workState: 'running',
        task: '正在对比订阅方案',
        host: '运行主机一',
      },
      { name: 'verifier', display: '核验员', workState: 'waiting', task: '等待调研报告', host: '运行主机二' },
    ],
  },
  {
    name: 'design',
    display: '产品设计',
    topic: '交互设计、视觉规范与可用性检查',
    agents: [
      {
        name: 'designer',
        display: '设计师',
        workState: 'running',
        task: '正在设计消息时间线',
        host: '运行主机一',
      },
      {
        name: 'ui-builder',
        display: '界面开发',
        workState: 'running',
        task: '正在搭建界面原型',
        host: '运行主机一',
      },
      { name: 'critic', display: '体验评审', workState: 'waiting', task: '等待原型验收', host: '运行主机二' },
    ],
  },
  {
    name: 'review',
    display: '质量审查',
    topic: '安全检查、质量门禁与验收记录',
    agents: [
      {
        name: 'security',
        display: '安全审查',
        workState: 'attention',
        task: '依赖扫描结果缺失，审查阻塞',
        host: '运行主机二',
      },
      {
        name: 'quality',
        display: '质量检查',
        workState: 'waiting',
        task: '等待集成测试报告',
        host: '运行主机二',
      },
      {
        name: 'gatekeeper',
        display: '验收把关',
        workState: 'waiting',
        task: '保持验收门禁',
        host: '调度主机一',
      },
    ],
  },
  {
    name: 'ops',
    display: '运行维护',
    topic: '运行状态、消息链路与日志观察',
    agents: [
      { name: 'deployer', display: '部署员', workState: 'waiting', task: '等待发布指令', host: '调度主机一' },
      {
        name: 'monitor',
        display: '监测员',
        workState: 'running',
        task: '正在监测主机心跳',
        host: '运行主机二',
      },
      {
        name: 'log-watcher',
        display: '日志观察',
        workState: 'running',
        task: '正在分析近期运行日志',
        host: '运行主机二',
      },
    ],
  },
  {
    name: 'knowledge',
    display: '知识沉淀',
    topic: '归集已确认的结论、文档与决策',
    agents: [
      { name: 'archivist', display: '归档员', workState: 'idle', task: '等待已验收结论', host: '运行主机一' },
      { name: 'indexer', display: '索引员', workState: 'idle', task: '索引已更新', host: '运行主机一' },
      { name: 'curator', display: '知识整理', workState: 'idle', task: '等待文档提交', host: '运行主机一' },
    ],
  },
  {
    name: 'archive',
    display: '历史归档',
    topic: '已完成工作与历史快照的只读归档',
    archived: true,
    agents: [
      {
        name: 'snapshot',
        display: '快照员',
        workState: 'offline',
        task: '本轮归档已结束',
        host: '运行主机二',
        online: 'offline',
      },
      {
        name: 'backup',
        display: '备份员',
        workState: 'offline',
        task: '备份已完成',
        host: '运行主机二',
        online: 'offline',
      },
    ],
  },
];

const LONG_DEMO_TEXT = [
  '事件订阅接口已完成第一轮实现，准备交由审查员检查。',
  '',
  '一、消息接收与排序',
  '使用服务端事件序号维护读取游标，首次进入频道先加载最近一页历史，再从对应游标订阅实时增量。历史消息与实时事件按消息编号去重，同一秒内的消息使用服务端序号稳定排序。',
  '',
  '二、断线恢复',
  '连接中断时保留最后一帧数据，同时显示“正在重连”和最后更新时间。重连成功后从上次确认的游标补齐遗漏事件。如果游标已过期，重新拉取快照，并明确告知历史区间可能不完整。',
  '',
  '三、投递状态',
  '“发送成功”只表示消息已入队，不代表接收者已经读取。界面分别展示入队、投递和读取回执；没有回执时显示“读取状态未知”。',
  '',
  '四、待检查的边界',
  '1. 用户阅读旧消息时，新消息不能强制拉回列表顶部。',
  '2. 切换频道后，上一频道的迟到请求不能覆盖当前视图。',
  '3. 一个智能体可能加入多个频道，不能据此把私信自动归入某个频道。',
  '4. 全局拓扑里的“工作中”需要任务或事件支撑，单靠在线心跳不够。',
].join('\n');

interface DemoMessageSeed {
  channel: string;
  from: string;
  to: string;
  text: string;
  minutesAgo: number;
  readBy?: number;
  kind?: MessageView['kind'];
}

const DEMO_MESSAGES: DemoMessageSeed[] = [
  {
    channel: 'engineering',
    from: 'test-runner',
    to: '#engineering',
    text: '消息投递测试正在运行。已完成 18 / 24 项，当前检查重连后的重复事件处理。',
    minutesAgo: 1,
    readBy: 2,
  },
  {
    channel: 'engineering',
    from: 'coder-alpha',
    to: 'reviewer',
    text: LONG_DEMO_TEXT,
    minutesAgo: 3,
    kind: 'dm',
  },
  {
    channel: 'engineering',
    from: 'coder-beta',
    to: '#engineering',
    text: '断线重连逻辑已更新：保留最后确认的事件游标，连接恢复后补齐增量。正在验证游标失效的回退路径。',
    minutesAgo: 5,
    readBy: 3,
  },
  {
    channel: 'engineering',
    from: 'reviewer',
    to: 'coder-alpha',
    text: '收到。请同时提供断线重连和频道快速切换的测试记录，我会先检查消息去重边界。',
    minutesAgo: 7,
    kind: 'dm',
    readBy: 1,
  },
  {
    channel: 'engineering',
    from: 'relay',
    to: '#engineering',
    text: '本轮目标：完成消息订阅、历史查询和断线恢复。实现完成后，将测试报告交给质量审查频道验收。',
    minutesAgo: 12,
    readBy: 4,
  },
  {
    channel: 'coordination',
    from: 'relay',
    to: '#coordination',
    text: '工程研发、研究分析、产品设计与运行维护正在并行工作；质量审查等待工程测试报告。',
    minutesAgo: 2,
    readBy: 2,
  },
  {
    channel: 'coordination',
    from: 'planner',
    to: 'relay',
    text: '本轮安排已更新：研发实现 → 测试报告 → 质量审查。设计与技术调研保持并行，减少串行等待。',
    minutesAgo: 6,
    kind: 'dm',
    readBy: 1,
  },
  {
    channel: 'research',
    from: 'analyst',
    to: '#research',
    text: '对比结果：使用持久化事件游标更利于断线续接，但需要覆盖游标过期、事件重复和历史分页重叠三种边界。',
    minutesAgo: 4,
    readBy: 2,
  },
  {
    channel: 'research',
    from: 'researcher',
    to: 'analyst',
    text: '请补充事件重放方案的限制条件，并把未验证的部分单独列出。\n\n重点核查：\n1. 历史事件保留时长是否可配置。\n2. 断线后是否能读取缺失区间。\n3. 同一消息是否可能从多个事件源到达。\n4. 频道事件与关联私信是否能使用明确的上下文标识。\n\n输出方案比较表，包含接口依据、实际验证记录与仍待确认的问题。',
    minutesAgo: 9,
    kind: 'dm',
    readBy: 1,
  },
  {
    channel: 'design',
    from: 'designer',
    to: '#design',
    text: '频道详情使用独立的消息时间线。长消息默认折叠为三行，点击正文进入放大阅读。',
    minutesAgo: 8,
    readBy: 2,
  },
  {
    channel: 'design',
    from: 'ui-builder',
    to: 'designer',
    text: '已接入全局拓扑、频道聚焦和节点选择三种交互。下一步检查窄屏布局与键盘焦点。',
    minutesAgo: 14,
    kind: 'dm',
    readBy: 1,
  },
  {
    channel: 'review',
    from: 'security',
    to: '#review',
    text: '依赖扫描结果尚未到达，审查任务暂时阻塞。当前没有可以确认的漏洞结论。',
    minutesAgo: 3,
    readBy: 2,
  },
  {
    channel: 'review',
    from: 'gatekeeper',
    to: 'quality',
    text: '保持验收门禁。待工程研发的测试报告到达后，核对以下项目：\n\n1. 历史消息完整性与顺序；\n2. 长消息、代码块及多行文本的可读性；\n3. 异常、离线、重连和空频道状态；\n4. 频道切换时的数据隔离；\n5. 只读观察权限与凭据保护。\n\n所有必需项通过后再记录审查完成，不能以演示动画替代实际运行证据。',
    minutesAgo: 11,
    kind: 'dm',
    readBy: 1,
  },
  {
    channel: 'ops',
    from: 'monitor',
    to: '#ops',
    text: '三个演示主机的心跳均在预期时间内。当前没有连接异常。',
    minutesAgo: 1,
    readBy: 2,
  },
  {
    channel: 'ops',
    from: 'log-watcher',
    to: 'monitor',
    text: '近期日志未发现连续重连。继续观察事件订阅是否出现中断。',
    minutesAgo: 10,
    kind: 'dm',
    readBy: 1,
  },
  {
    channel: 'knowledge',
    from: 'archivist',
    to: '#knowledge',
    text: '消息语义说明已归档：频道广播与私信分别记录；入队、投递、已读分别展示。当前没有新的待归档结论。',
    minutesAgo: 95,
    readBy: 3,
  },
  {
    channel: 'archive',
    from: 'snapshot',
    to: '#archive',
    text: '上一轮协作快照已保存。频道随后归档，保留历史消息供追溯。',
    minutesAgo: 1_100,
    readBy: 3,
  },
];

const DEMO_NODES: NodeView[] = [
  {
    id: 'control-01',
    name: 'control-01',
    displayName: '调度主机一',
    status: 'online',
    statusLabel: '在线',
    agentCount: 4,
    version: '演示',
    lastHeartbeatAt: null,
  },
  {
    id: 'worker-01',
    name: 'worker-01',
    displayName: '运行主机一',
    status: 'online',
    statusLabel: '在线',
    agentCount: 9,
    version: '演示',
    lastHeartbeatAt: null,
  },
  {
    id: 'worker-02',
    name: 'worker-02',
    displayName: '运行主机二',
    status: 'online',
    statusLabel: '在线',
    agentCount: 11,
    version: '演示',
    lastHeartbeatAt: null,
  },
];

const DEMO_TICKER: { channel: string; from: string; to: string; text: string }[] = [
  {
    channel: 'engineering',
    from: 'test-runner',
    to: '#engineering',
    text: '投递测试继续推进：已覆盖重复事件与游标失效两种边界。',
  },
  {
    channel: 'research',
    from: 'analyst',
    to: '#research',
    text: '重放边界已加入方案比较表，正在核对游标过期的处理方式。',
  },
  {
    channel: 'ops',
    from: 'monitor',
    to: '#ops',
    text: '心跳检查完成：三台演示主机在线，事件订阅连接保持正常。',
  },
  {
    channel: 'design',
    from: 'ui-builder',
    to: '#design',
    text: '消息放大阅读交互已就绪，正在检查长文本与键盘导航。',
  },
  {
    channel: 'coordination',
    from: 'planner',
    to: '#coordination',
    text: '并行工作继续推进，质量审查仍等待工程研发的完整测试报告。',
  },
];

export interface DemoSourceOptions {
  timezone?: string;
  /** Demo tick cadence; a new message is emitted each tick. */
  tickMs?: number;
  now?: () => number;
}

export class DemoControlRoomSource implements ControlRoomSource {
  readonly mode = 'demo' as const;
  readonly target = '演示数据';
  readonly timezone: string;

  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly listeners = new Set<(frame: StreamFrame) => void>();
  private readonly channels: ChannelView[] = [];
  private readonly agents: AgentView[] = [];
  private readonly messageCache = new Map<string, MessageView[]>();
  private readonly throughput = new ThroughputTracker();
  private ticker: NodeJS.Timeout | undefined;
  private tickIndex = 0;
  private paused = false;
  private lastEventAt: string | null = null;

  constructor(options: DemoSourceOptions = {}) {
    this.timezone = resolveTimezone(options.timezone);
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 12_000;
    this.seed();
  }

  private seed(): void {
    const now = this.now();
    const today = zonedToday(this.timezone, new Date(now));

    const agentViews: AgentView[] = [];
    for (const channel of DEMO_CHANNELS) {
      for (const agent of channel.agents) {
        const existing = agentViews.find((entry) => entry.name === agent.name);
        if (existing) {
          existing.channelNames.push(channel.name);
          continue;
        }
        const online = agent.online ?? 'online';
        agentViews.push({
          id: agent.name,
          name: agent.name,
          displayName: agent.display,
          type: 'agent',
          typeLabel: '智能体',
          online,
          onlineLabel: online === 'online' ? '在线' : '离线',
          workState: agent.workState,
          workStateLabel: WORK_LABELS[agent.workState],
          activity:
            agent.workState === 'running' ? 'using_tool' : agent.workState === 'offline' ? null : 'idle',
          task: agent.task,
          reason: agent.workState === 'attention' ? agent.task : null,
          host: agent.host,
          channelNames: [channel.name],
          lastSeenAt: new Date(now - 30_000).toISOString(),
          lastActivityAt: new Date(now - 90_000).toISOString(),
          evidence: 'tasks',
        });
      }
    }

    const byName = new Map(agentViews.map((agent) => [agent.name, agent]));
    for (const channel of DEMO_CHANNELS) {
      const members = channel.agents
        .map((agent) => byName.get(agent.name))
        .filter((agent): agent is AgentView => Boolean(agent));
      const aggregate = aggregateChannelState({
        archived: channel.archived === true,
        members,
        lastMessageAt: null,
        hasTaskEvidence: true,
        now,
      });
      this.channels.push({
        id: channel.name,
        name: channel.name,
        displayName: channel.display,
        topic: channel.topic,
        state: aggregate.state,
        stateLabel: aggregate.stateLabel,
        stateReason: aggregate.stateReason,
        evidence: aggregate.evidence,
        archived: channel.archived === true,
        memberCount: members.length,
        memberNames: members.map((member) => member.name),
        memberLabels: members.map((member) => member.displayName),
        runningCount: members.filter((member) => member.workState === 'running').length,
        createdAt: new Date(now - 86_400_000 * 12).toISOString(),
        lastMessageAt: null,
      });
    }
    this.agents.push(...agentViews);

    let counter = 0;
    for (const seed of DEMO_MESSAGES) {
      counter += 1;
      const createdAt = new Date(now - seed.minutesAgo * 60_000).toISOString();
      const stamp = zonedStamp(createdAt, this.timezone);
      const fromAgent = byName.get(seed.from);
      const kind = seed.kind ?? 'channel';
      const view: MessageView = {
        id: `demo-msg-${String(counter).padStart(4, '0')}`,
        channel: seed.channel,
        channelName: seed.channel,
        channelLabel:
          this.channels.find((channel) => channel.name === seed.channel)?.displayName ?? seed.channel,
        from: seed.from,
        fromName: fromAgent?.displayName ?? seed.from,
        to: seed.to,
        toName: seed.to.startsWith('#')
          ? (this.channels.find((channel) => `#${channel.name}` === seed.to)?.displayName ??
            seed.to.replace('#', ''))
          : (byName.get(seed.to)?.displayName ?? seed.to),
        kind,
        kindLabel: kind === 'dm' ? '关联私信' : kind === 'group_dm' ? '群组私信' : '频道消息',
        text: seed.text,
        createdAt,
        day: stamp?.day ?? today,
        time: stamp?.time ?? '00:00:00',
        receipt: seed.readBy ? `${seed.readBy} 位成员已读` : '读取状态未知',
        receiptKnown: Boolean(seed.readBy),
        threadId: null,
        parentId: null,
        readByCount: seed.readBy ?? null,
      };
      const list = this.messageCache.get(seed.channel) ?? [];
      list.push(view);
      this.messageCache.set(seed.channel, list);
    }

    for (const [channelName, list] of this.messageCache) {
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const channel = this.channels.find((entry) => entry.name === channelName);
      if (channel) channel.lastMessageAt = list[0]?.createdAt ?? null;
    }
    // Seed the throughput chart from the newest demo messages so the chart is
    // not blank on first paint.
    for (const message of this.allMessages().slice(0, 40)) this.throughput.record(message.createdAt);
  }

  private allMessages(): MessageView[] {
    return [...this.messageCache.values()].flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Start the demo ticker. Idempotent. */
  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), this.tickMs);
    this.ticker.unref?.();
  }

  private tick(): void {
    if (this.paused) return;
    const seed = DEMO_TICKER[this.tickIndex % DEMO_TICKER.length];
    this.tickIndex += 1;
    if (!seed) return;
    const now = new Date(this.now());
    const stamp = zonedStamp(now.toISOString(), this.timezone);
    const channel = this.channels.find((entry) => entry.name === seed.channel);
    const fromAgent = this.agents.find((agent) => agent.name === seed.from);
    const message: MessageView = {
      id: `demo-msg-live-${now.getTime()}`,
      channel: seed.channel,
      channelName: seed.channel,
      channelLabel: channel?.displayName ?? seed.channel,
      from: seed.from,
      fromName: fromAgent?.displayName ?? seed.from,
      to: seed.to,
      toName: channel?.displayName ?? seed.to.replace('#', ''),
      kind: 'channel',
      kindLabel: '频道消息',
      text: seed.text,
      createdAt: now.toISOString(),
      day: stamp?.day ?? '',
      time: stamp?.time ?? '',
      receipt: '读取状态未知',
      receiptKnown: false,
      threadId: null,
      parentId: null,
      readByCount: null,
    };
    const list = this.messageCache.get(seed.channel) ?? [];
    list.unshift(message);
    this.messageCache.set(seed.channel, list);
    if (channel) channel.lastMessageAt = message.createdAt;
    this.throughput.record(message.createdAt);
    this.lastEventAt = message.createdAt;
    this.emit({ type: 'message', message });
    this.emit({
      type: 'agents',
      agents: this.agents,
      channels: this.channels,
      metrics: this.metrics(),
      connection: this.connection(),
    });
  }

  private emit(frame: StreamFrame): void {
    for (const listener of this.listeners) {
      try {
        listener(frame);
      } catch {
        // A broken listener must not stop the demo ticker.
      }
    }
  }

  private connection(): ConnectionView {
    return {
      state: this.paused ? 'paused' : 'live',
      label: this.paused ? '已暂停观察' : '演示数据 · 实时',
      detail: this.paused ? '演示事件已暂停，后台数据继续生成' : '',
      target: this.target,
      mode: this.mode,
      lastEventAt: this.lastEventAt,
      lastRefreshAt: new Date(this.now()).toISOString(),
      cursor: null,
      bufferedEvents: 0,
    };
  }

  private metrics(): MetricsView {
    const flags = deriveMetricsFlags(this.channels);
    const today = zonedToday(this.timezone, new Date(this.now()));
    const todayCount = this.allMessages().filter((message) => message.day === today).length;
    return {
      channelsWorking: flags.channelsWorking,
      channelsAttention: flags.channelsAttention,
      channelsTotal: this.channels.length,
      agentsRunning: this.agents.filter((agent) => agent.workState === 'running').length,
      agentsOnline: this.agents.filter((agent) => agent.online === 'online').length,
      agentsTotal: this.agents.length,
      messagesToday: todayCount,
      messagesTodayPartial: false,
      throughput: this.throughput.snapshot(),
    };
  }

  async bootstrap(): Promise<BootstrapView> {
    this.start();
    return {
      mode: this.mode,
      generatedAt: new Date(this.now()).toISOString(),
      timezone: this.timezone,
      workspace: {
        id: 'demo',
        name: 'relay-demo',
        displayName: '协作工作空间',
        description: '演示空间 · 本地集群',
      },
      connection: this.connection(),
      channels: this.channels,
      agents: this.agents,
      nodes: DEMO_NODES,
      metrics: this.metrics(),
      recentMessages: this.allMessages().slice(0, 6),
      capabilities: { sessionEvents: true, hostPlacement: true, search: true, streaming: true },
      notice: '当前为演示模式：所有频道、智能体与消息均为虚构数据，未连接任何 Relay 服务',
    };
  }

  async messages(channelName: string, query: MessageQuery): Promise<MessagePageView> {
    const all = this.messageCache.get(channelName) ?? [];
    // Lists are newest-first, so "older than cursor" is everything after its index.
    const cursorIndex = query.before ? all.findIndex((entry) => entry.id === query.before) : -1;
    const older = cursorIndex >= 0 ? all.slice(cursorIndex + 1) : query.before ? [] : all;
    const text = query.query?.trim().toLowerCase() ?? '';
    const from = query.from?.trim();
    const filtered = older.filter((message) => {
      if (from && message.from !== from && message.fromName !== from) return false;
      if (query.day && message.day !== query.day) return false;
      if (!text) return true;
      return `${message.text} ${message.fromName} ${message.toName}`.toLowerCase().includes(text);
    });
    const page = filtered.slice(0, query.limit);
    return {
      channel: channelName,
      messages: page,
      nextBefore: filtered.length > page.length ? (page.at(-1)?.id ?? null) : null,
      hasMore: filtered.length > page.length,
      total: all.length,
    };
  }

  async message(id: string): Promise<MessageView | null> {
    return this.allMessages().find((entry) => entry.id === id) ?? null;
  }

  async search(query: string, channel?: string): Promise<SearchHitView[]> {
    const text = query.trim().toLowerCase();
    if (!text) return [];
    return this.allMessages()
      .filter(
        (message) => (!channel || message.channel === channel) && message.text.toLowerCase().includes(text)
      )
      .slice(0, 40)
      .map((message) => ({
        id: message.id,
        channel: message.channel,
        channelLabel: message.channelLabel,
        from: message.from,
        fromName: message.fromName,
        text: message.text,
        createdAt: message.createdAt,
        day: message.day,
        time: message.time,
      }));
  }

  subscribe(listener: (frame: StreamFrame) => void): () => void {
    this.start();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    this.emit({ type: 'connection', connection: this.connection() });
  }

  /** Day used by "today"/"yesterday" filters in the demo view. */
  today(): string {
    return zonedToday(this.timezone, new Date(this.now()));
  }

  yesterday(): string {
    return shiftDay(this.today(), -1);
  }

  async close(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    this.listeners.clear();
  }
}

const WORK_LABELS: Record<WorkState, string> = {
  running: '执行中',
  waiting: '等待',
  idle: '空闲',
  attention: '异常',
  offline: '离线',
  unknown: '未知',
};

/** Re-exported so the demo channel list can be asserted in tests. */
export const DEMO_CHANNEL_SEEDS = DEMO_CHANNELS;
