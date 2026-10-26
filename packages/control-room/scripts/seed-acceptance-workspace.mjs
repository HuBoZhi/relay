/**
 * Seed a local Relaycast engine with an acceptance workspace.
 *
 * This is a development fixture, not part of the shipped service: it stands in
 * for real running agents so every work state can be reviewed on one screen.
 * It only talks to a local engine — never point it at a shared deployment.
 *
 * Usage:
 *   npx @relaycast/engine --db ./relaycast.db --port 8787        # in one shell
 *   WS=rk_live_... node packages/control-room/scripts/seed-acceptance-workspace.mjs
 *
 * What it produces (all Chinese display names, five agents, five channels):
 *
 *   relay        空闲     channel owner; idle so it never colours a channel
 *   coder-alpha  执行中   canonical `tool.called` event
 *   reviewer     等待     legacy `status.waiting` event with a reason
 *   monitor      异常     legacy `status.blocked` event with a reason
 *   archivist    空闲     legacy `status.idle` event
 *   backup       离线     never connects; keeps `status.idle` as its last state
 *
 * The process stays alive on purpose: presence is derived from a live realtime
 * socket, so exiting would immediately report every agent as offline. A plain
 * `await new Promise(() => {})` is not enough — with only an unsettled promise
 * and no handles left, Node exits with code 13. The heartbeat interval below
 * keeps an active handle in the loop.
 */

import { RelaycastMessagingClient } from '@agent-relay/sdk/messaging';

const baseUrl = process.env.RELAY_BASE_URL ?? 'http://127.0.0.1:8787';
const workspaceKey = process.env.WS;

if (!workspaceKey) {
  console.error('WS is required: create a workspace first, e.g.');
  console.error(
    `  curl -XPOST ${baseUrl}/v1/workspaces -H 'content-type: application/json' -d '{"name":"control-room-acceptance"}'`
  );
  process.exit(1);
}

const admin = new RelaycastMessagingClient({ workspaceKey, baseUrl });

const AGENTS = [
  // Owns the channels and stays idle: whoever creates a channel becomes its
  // owner, and an owner that is 执行中 would make every channel look 工作中.
  { name: 'relay', metadata: { displayName: '协调中枢', host: 'control-host' } },
  { name: 'coder-alpha', metadata: { displayName: '开发甲', host: 'worker-01' } },
  { name: 'reviewer', metadata: { displayName: '审查员', host: 'worker-02' } },
  { name: 'monitor', metadata: { displayName: '监测员', host: 'worker-01' } },
  { name: 'archivist', metadata: { displayName: '归档员', host: 'worker-01' } },
  { name: 'backup', metadata: { displayName: '备份员', host: 'worker-02' } },
];

// `metadata.displayName` is how a deployment gives a channel a Chinese label;
// the room shows it while keeping the stable name for routing and filtering.
const CHANNELS = [
  { name: 'engineering', topic: '接口开发、代码实现与自动化测试', metadata: { displayName: '工程研发' } },
  { name: 'review', topic: '安全检查、质量门禁与验收记录', metadata: { displayName: '质量审查' } },
  { name: 'ops', topic: '运行状态、消息链路与日志观察', metadata: { displayName: '运行维护' } },
  { name: 'knowledge', topic: '归集已确认的结论、文档与决策', metadata: { displayName: '知识沉淀' } },
  { name: 'archive', topic: '已完成工作与历史快照的只读归档', metadata: { displayName: '历史归档' } },
];

const MEMBERSHIPS = [
  ['engineering', 'coder-alpha'],
  ['engineering', 'reviewer'],
  ['engineering', 'backup'],
  ['review', 'reviewer'],
  ['review', 'monitor'],
  ['ops', 'monitor'],
  ['ops', 'backup'],
  ['knowledge', 'archivist'],
  ['archive', 'archivist'],
];

const now = Date.now();
const at = (offsetSeconds) => new Date(now - offsetSeconds * 1000).toISOString();
const observability = (sequence, offsetSeconds) => ({
  source: 'broker',
  fidelity: 'exact',
  sequence,
  timestamp: at(offsetSeconds),
});

const tokens = new Map();
for (const agent of AGENTS) {
  try {
    const registration = await admin.agents.register({
      name: agent.name,
      type: 'agent',
      metadata: agent.metadata,
    });
    tokens.set(agent.name, registration.token);
    console.log('agent registered', agent.name);
  } catch (error) {
    console.error('agent registration failed', agent.name, error.message);
    process.exit(1);
  }
}

const as = (agent) => new RelaycastMessagingClient({ workspaceKey, agentToken: tokens.get(agent), baseUrl });
const owner = as('relay');

for (const channel of CHANNELS) {
  try {
    await owner.channels.create(channel);
    console.log('channel created', channel.name);
  } catch (error) {
    console.error('channel create failed', channel.name, error.message);
  }
}

// The engine creates a default `general` channel every agent joins; give it a
// Chinese label too, or the one English name stays visible in an otherwise
// Chinese interface.
try {
  await owner.channels.update('general', {
    topic: '工作空间默认频道',
    metadata: { displayName: '通用频道' },
  });
  console.log('channel labelled', 'general');
} catch (error) {
  console.error('general label failed', error.message);
}

for (const [channel, agent] of MEMBERSHIPS) {
  try {
    await owner.channels.invite(channel, agent);
    console.log('joined', agent, '->', channel);
  } catch (error) {
    console.error('invite failed', channel, agent, error.message);
  }
}

try {
  await owner.channels.archive('archive');
  console.log('channel archived', 'archive');
} catch (error) {
  console.error('archive failed', error.message);
}

const emit = async (agent, events) => {
  for (const event of events) {
    try {
      await admin.sessionEvents.emit(agent, event);
    } catch (error) {
      console.error('event emit failed', agent, event.type, error.message);
    }
  }
};

// 协调中枢 stays idle so it never colours a channel it created.
await emit('relay', [{ type: 'status.idle' }]);

// 执行中: canonical event, mid-turn inside a tool call.
await emit('coder-alpha', [
  { type: 'session.started', observability: observability(1, 600) },
  { type: 'tool.called', callId: 'call-1', tool: '运行消息投递测试', observability: observability(2, 60) },
]);

// 等待: the engine only accepts the legacy status family for this.
await emit('reviewer', [
  { type: 'session.started', observability: observability(1, 900) },
  { type: 'status.waiting', reason: '等待依赖扫描结果' },
]);

// 异常
await emit('monitor', [{ type: 'status.blocked', reason: 'harness 心跳超时' }]);

// 空闲
await emit('archivist', [{ type: 'status.idle' }]);

// 离线: never connects, but its last known state is worth showing.
await emit('backup', [{ type: 'status.idle' }]);

const MESSAGES = [
  [
    'relay',
    'general',
    '本轮协作已开始：工程研发正在跑消息投递测试，质量审查等待依赖扫描结果。各频道进展会回传到本频道。',
  ],
  [
    'coder-alpha',
    'engineering',
    '事件订阅接口已完成第一轮实现，正在跑投递测试。\n\n一、断线恢复：保留最后确认的游标，重连后补齐增量。\n二、去重：历史与实时按消息编号去重，同一秒内用服务端序号稳定排序。\n三、投递状态：入队、投递、已读分别展示；没有回执时显示“读取状态未知”，不用“已发送”代替已读。\n\n请审查员先看去重边界，测试报告稍后发到质量审查频道。',
  ],
  ['reviewer', 'engineering', '收到。请同时提供断线重连与频道快速切换的测试记录。'],
  ['reviewer', 'review', '依赖扫描结果尚未到达，审查任务暂时阻塞。'],
  ['monitor', 'ops', '本地引擎心跳正常，事件订阅连接保持。'],
  ['archivist', 'knowledge', '消息语义说明已归档：频道广播与私信分别记录；入队、投递、已读分别展示。'],
];

for (const [agent, channel, text] of MESSAGES) {
  try {
    await as(agent).messages.send({ channel, text });
    console.log('message sent', agent, '->', channel);
  } catch (error) {
    console.error('message send failed', agent, channel, error.message);
  }
}

// Presence: the engine reports an agent online while it holds a live socket OR
// keeps sending REST heartbeats to `/v1/agents/heartbeat`. A socket idles out
// after about a minute on this engine (the observer-side client sends no
// protocol pings), so the fixture uses the documented heartbeat endpoint, which
// held an agent online for a 75-second probe. `backup` is deliberately left
// without a heartbeat so one node shows the 离线 state.
const heartbeat = async (agent, token) => {
  try {
    const response = await fetch(`${baseUrl}/v1/agents/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) console.error('heartbeat failed', agent, response.status);
  } catch (error) {
    console.error('heartbeat failed', agent, error.message);
  }
};

const online = AGENTS.filter((agent) => agent.name !== 'backup');
for (const agent of online) await heartbeat(agent.name, tokens.get(agent.name));
console.log('heartbeats sent', online.map((agent) => agent.name).join(', '));

setInterval(() => {
  for (const agent of online) void heartbeat(agent.name, tokens.get(agent.name));
}, 20_000);

console.log('\nseeded: 6 agents / 5 channels (one archived) — heartbeating every 20s, Ctrl+C to stop');
