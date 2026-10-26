// Control room front end: renders the view models served by /api and applies
// live stream frames. No demo data and no credentials live in this file.
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );
const icon = (name) => `<span data-icon="${name}" aria-hidden="true"></span>`;

function paintIcons(root = document) {
  $$('[data-icon]', root).forEach((element) => {
    const body = window.RELAY_ICONS ? window.RELAY_ICONS[element.dataset.icon] : null;
    if (body) {
      element.innerHTML = `<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
    }
  });
}

const WORK_CLASS = {
  running: 'active',
  waiting: 'waiting',
  idle: 'idle',
  attention: 'warning',
  offline: 'offline',
  unknown: 'unknown',
};
const CHANNEL_CLASS = {
  active: 'active',
  attention: 'warning',
  waiting: 'waiting',
  idle: 'idle',
  archived: 'offline',
  unknown: 'unknown',
};
const ZONE_LABELS = {
  'Asia/Shanghai': '北京时间',
  'Asia/Tokyo': '东京时间',
  UTC: '协调世界时',
  'Europe/London': '伦敦时间',
  'America/New_York': '纽约时间',
};
const UNREADABLE_CHANNEL_STATES = new Set(['reconnecting', 'degraded', 'error', 'closed']);

const state = {
  mode: 'live',
  timezone: 'Asia/Shanghai',
  workspace: null,
  connection: null,
  channels: [],
  agents: [],
  nodes: [],
  metrics: null,
  capabilities: null,
  notice: null,
  channel: null,
  agent: null,
  filter: 'all',
  channelSearch: '',
  view: 'global',
  tab: 'messages',
  paused: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  expanded: new Set(),
  messages: new Map(),
  recent: [],
  hasMore: false,
  nextBefore: null,
  loadingMessages: false,
  messageError: null,
  fatal: null,
  dialogId: null,
  dialogIds: [],
  pending: 0,
  dropped: 0,
  stream: null,
  streamOpen: false,
  bootstrapping: false,
};

/* ------------------------------------------------------------------ helpers */

const currentChannel = () => state.channels.find((channel) => channel.name === state.channel) || null;
const channelAgents = (channel) =>
  state.agents.filter((agent) => (agent.channelNames || []).includes(channel.name));
const channelClass = (channel) => CHANNEL_CLASS[channel.state] || 'unknown';
const agentClass = (agent) => WORK_CLASS[agent.workState] || 'unknown';
const initials = (agent) => (agent.displayName || agent.name || '?').slice(0, 1);

let stampFormatter = null;
function stamp(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  if (!stampFormatter || stampFormatter.timeZone !== state.timezone) {
    stampFormatter = {
      timeZone: state.timezone,
      date: new Intl.DateTimeFormat('zh-CN', {
        timeZone: state.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
      clock: new Intl.DateTimeFormat('zh-CN', {
        timeZone: state.timezone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }),
      minute: new Intl.DateTimeFormat('zh-CN', {
        timeZone: state.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    };
  }
  const dayParts = stampFormatter.date.formatToParts(date);
  const pick = (parts, type) => parts.find((part) => part.type === type)?.value || '';
  const day = `${pick(dayParts, 'year')}-${pick(dayParts, 'month')}-${pick(dayParts, 'day')}`;
  return {
    day,
    time: stampFormatter.clock.format(date),
    minute: stampFormatter.minute.format(date),
  };
}

function todayDay() {
  return stamp(new Date().toISOString())?.day || '';
}

function shiftDay(day, delta) {
  const base = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return day;
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

function relative(iso) {
  if (!iso) return '暂无数据';
  const value = new Date(iso).getTime();
  if (Number.isNaN(value)) return '暂无数据';
  const minutes = Math.floor((Date.now() - value) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const parts = stamp(iso);
  return parts ? `${parts.day.replaceAll('-', '.')} ${parts.minute}` : '暂无数据';
}

function toast(text) {
  const element = $('#toast');
  element.textContent = text;
  element.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('visible'), 2600);
}

function zoneLabel() {
  return ZONE_LABELS[state.timezone] || state.timezone;
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  try {
    state.fatal = null;
    const data = await window.RelayApi.bootstrap();
    applyBootstrap(data);
    openStream();
  } catch (error) {
    state.fatal = error;
    // A failed first read must not leave the header claiming "正在连接"; the
    // banner and footer need to report the failure too.
    state.connection = {
      state: 'error',
      label: '连接失败',
      detail: error && error.message ? error.message : '无法读取工作空间数据',
      target: state.connection ? state.connection.target : '本地服务',
      mode: state.mode,
      lastEventAt: null,
      lastRefreshAt: null,
      cursor: null,
      bufferedEvents: 0,
    };
    renderFatal(error);
  }
}

function applyBootstrap(data) {
  const previousChannel = state.channel;
  state.mode = data.mode;
  state.timezone = data.timezone || state.timezone;
  state.workspace = data.workspace;
  state.connection = data.connection;
  state.channels = data.channels || [];
  state.agents = data.agents || [];
  state.nodes = data.nodes || [];
  state.metrics = data.metrics;
  state.capabilities = data.capabilities;
  state.notice = data.notice;
  state.recent = (data.recentMessages || []).slice(0, 6);

  const stillThere = state.channels.some((channel) => channel.name === previousChannel);
  if (!stillThere) {
    const preferred =
      state.channels.find((channel) => channel.state === 'attention') ||
      state.channels.find((channel) => channel.state === 'active') ||
      state.channels[0];
    state.channel = preferred ? preferred.name : null;
    state.agent = null;
    state.expanded.clear();
    state.pending = 0;
    $('#message-search').value = '';
  }

  renderAll();
  if (state.channel) void loadMessages({ reset: true });
}

function renderAll() {
  renderWorkspace();
  renderChannels();
  renderMetrics();
  renderTraffic();
  renderRecent();
  renderGraph();
  renderSummary();
  renderAgents();
  renderMessages();
  renderConnection();
  paintIcons();
}

function renderFatal(error) {
  const message = error && error.message ? error.message : '无法读取工作空间数据';
  $('#channel-list').innerHTML = `<div class="error-state"><strong>频道列表读取失败</strong>${esc(
    message
  )}<br>请确认本地服务仍在运行，并检查启动时使用的凭据。<button type="button" id="retry-boot">重试</button></div>`;
  paintIcons($('#channel-list'));
  const retry = $('#retry-boot');
  if (retry) retry.onclick = () => void boot();
  renderConnection();
}

/* --------------------------------------------------------------- workspace */

function renderWorkspace() {
  const workspace = state.workspace;
  $('#workspace-name').textContent = workspace ? workspace.displayName || workspace.name : '工作空间';
  $('#workspace-target').innerHTML = `${
    state.mode === 'demo' ? '演示数据' : esc(state.connection ? state.connection.target : '未知地址')
  }<i class="tiny-dot"></i>${state.mode === 'demo' ? '未连接服务' : '只读观察'}`;
  $('#workspace-version').textContent =
    workspace && workspace.id ? workspace.id.slice(0, 2).toUpperCase() : '01';

  const onlineNodes = state.nodes.filter((node) => node.status === 'online').length;
  $('#cluster-name').textContent =
    state.mode === 'demo' ? '本地集群' : state.connection ? state.connection.target : '—';
  $('#cluster-mode').textContent = state.nodes.length
    ? `${onlineNodes}/${state.nodes.length} 在线`
    : '主机未知';
  $('#cluster-summary').textContent = `${state.agents.length} 个智能体 · ${
    state.nodes.length ? `${state.nodes.length} 台运行主机` : '主机信息未提供'
  }`;
  $('#cluster-dot').style.background =
    state.connection && state.connection.state === 'live' ? 'var(--cyan)' : 'var(--amber)';

  const bars = $('#cluster-bars');
  if (bars) {
    const count = Math.max(state.agents.length, 1);
    bars.innerHTML = Array.from(
      { length: Math.min(count, 28) },
      (_, index) => `<i style="height:${5 + ((index * 7 + state.agents.length) % 14)}px"></i>`
    ).join('');
  }
}

/* ---------------------------------------------------------------- channels */

function matchesChannel(channel) {
  const query = state.channelSearch.trim().toLowerCase();
  if (state.filter !== 'all') {
    const wanted = state.filter;
    const mapped = channel.state === 'attention' ? 'warning' : channel.state;
    if (mapped !== wanted) return false;
  }
  if (!query) return true;
  return `${channel.name} ${channel.displayName} ${channel.topic}`.toLowerCase().includes(query);
}

function renderChannels() {
  const total = state.channels.length;
  const working = state.channels.filter((channel) => channel.state === 'active').length;
  const attention = state.channels.filter((channel) => channel.state === 'attention').length;
  $('#channel-total').textContent = String(total).padStart(2, '0');
  $('#filter-count-all').textContent = String(total);
  $('#filter-count-active').textContent = String(working);
  $('#filter-count-warning').textContent = String(attention);

  const list = state.channels.filter(matchesChannel);
  $('#channel-list').innerHTML = list.length
    ? list
        .map((channel) => {
          const selected = channel.name === state.channel;
          const members = channelAgents(channel);
          const bars = [5, 9, 7, 12, 8]
            .map((height, index) => {
              const active = channel.runningCount > 0;
              return `<i style="height:${active ? height + ((index + channel.memberCount) % 3) : 3 + (index % 2)}px"></i>`;
            })
            .join('');
          return `<button class="channel-item ${selected ? 'selected' : ''}" data-channel="${esc(
            channel.name
          )}" data-status="${channelClass(channel)}" aria-pressed="${selected}" aria-label="${esc(
            channel.displayName
          )}，${esc(channel.stateLabel)}"><span class="hash">#</span><span class="channel-info"><strong>${esc(
            channel.displayName
          )}</strong><small><i class="status-dot ${channelClass(channel)}"></i>${
            channel.memberCount
          } 个智能体<span>· ${esc(channel.stateLabel)}</span></small></span><span class="channel-spark" aria-hidden="true">${bars}</span></button>`;
        })
        .join('')
    : `<p class="empty-state">${
        state.channels.length === 0 ? '暂无可见频道，或尚未成功读取频道列表' : '未找到匹配的频道'
      }</p>`;
}

function selectChannel(name, agent = null) {
  if (!state.channels.some((channel) => channel.name === name)) return;
  const changed = name !== state.channel;
  state.channel = name;
  state.agent = agent;
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.pending = 0;
  if (changed) {
    state.expanded.clear();
    $('#message-search').value = '';
    $('#date-filter').value = 'today';
    state.nextBefore = null;
    state.hasMore = false;
  }
  renderChannels();
  renderGraph();
  renderSummary();
  renderAgents();
  setTab(agent ? 'agents' : state.tab);
  if (!state.messages.has(name) || changed) void loadMessages({ reset: true });
  else {
    renderSenders();
    renderMessages();
    if (changed) $('#message-timeline').scrollTop = 0;
  }
}

/* ----------------------------------------------------------------- metrics */

function renderMetrics() {
  const metrics = state.metrics;
  if (!metrics) return;
  const working = metrics.channelsWorking;
  $('#metric-channels-working').textContent = working === null ? '--' : String(working).padStart(2, '0');
  $('#metric-channels-total').textContent = `/ ${String(metrics.channelsTotal).padStart(2, '0')}`;
  const ratio = working === null || metrics.channelsTotal === 0 ? 0 : (working / metrics.channelsTotal) * 100;
  $('#metric-channels-bar').style.width = `${Math.round(ratio)}%`;

  const running = metrics.agentsRunning;
  $('#metric-agents-running').textContent = running === null ? '--' : String(running);
  $('#metric-agents-total').textContent = `/ ${metrics.agentsTotal}`;
  $('#metric-agents-note').textContent =
    running === null
      ? '未提供任务事件，工作状态显示为未知'
      : `在线 ${metrics.agentsOnline === null ? '未知' : metrics.agentsOnline} 个 · 工作与在线状态分别展示`;

  const today = metrics.messagesToday;
  $('#metric-messages-today').textContent =
    today === null ? '--' : `${today.toLocaleString('zh-CN')}${metrics.messagesTodayPartial ? '+' : ''}`;
  $('#metric-messages-note').textContent =
    today === null
      ? '暂无数据'
      : metrics.messagesTodayPartial
        ? `按${zoneLabel()}统计已加载频道，其余频道未计`
        : `按${zoneLabel()}统计已加载频道`;

  const attention = metrics.channelsAttention;
  $('#metric-attention').textContent = attention === null ? '--' : String(attention).padStart(2, '0');
  const attentionChannel = state.channels.find((channel) => channel.state === 'attention');
  const link = $('#alert-link');
  const note = $('#metric-attention-note');
  if (attentionChannel) {
    link.hidden = false;
    note.hidden = true;
    link.innerHTML = `${esc(attentionChannel.displayName)}：${esc(attentionChannel.stateReason)} ${icon('arrow-up-right')}`;
    link.onclick = () => selectChannel(attentionChannel.name);
    paintIcons(link);
  } else {
    link.hidden = true;
    note.hidden = false;
    note.textContent = attention === null ? '状态数据不足' : '暂无待关注频道';
  }
}

/* ---------------------------------------------------------------- traffic */

function renderTraffic() {
  const throughput = state.metrics ? state.metrics.throughput : null;
  const chart = $('#traffic-chart');
  const axis = $('#traffic-axis');
  if (!throughput || !throughput.points.length) {
    chart.innerHTML = '<p class="empty-state">暂无数据</p>';
    axis.innerHTML = '';
    $('#traffic-rate').textContent = '--';
    return;
  }
  const points = throughput.points;
  const peak = Math.max(...points.map((point) => point.count), 1);
  chart.innerHTML = points
    .map((point) => {
      const height = Math.round((point.count / peak) * 100);
      const parts = stamp(point.at);
      return `<i style="height:${Math.max(height, 2)}%" title="${parts ? parts.minute : '时间未知'} - ${
        parts
          ? stamp(new Date(new Date(point.at).getTime() + throughput.bucketMinutes * 60000).toISOString())
              ?.minute
          : ''
      }：${point.count} 条"></i>`;
    })
    .join('');
  const labels = points.filter((_, index) => index % Math.max(1, Math.floor(points.length / 4)) === 0);
  axis.innerHTML = labels
    .map((point) => `<span>${(stamp(point.at) || {}).minute || '--:--'}</span>`)
    .join('');
  $('#traffic-window').textContent = `最近 ${throughput.windowMinutes} 分钟 · 本机观察`;
  const last = points[points.length - 1];
  $('#traffic-rate').textContent = String(last ? last.count : 0);
  chart.setAttribute(
    'aria-label',
    `消息吞吐趋势：最近 ${throughput.windowMinutes} 分钟，共 ${throughput.total} 条，峰值每分钟 ${peak} 条。`
  );
}

/* ---------------------------------------------------------------- topology */

function layoutGlobal() {
  const channels = state.channels;
  const count = channels.length || 1;
  const cx = 450;
  const cy = 220;
  const twoRings = count > 9;
  const placed = new Map();

  channels.forEach((channel, index) => {
    let x;
    let y;
    if (!twoRings) {
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
      x = cx + Math.cos(angle) * 300;
      y = cy + Math.sin(angle) * 128;
    } else {
      const ring = index % 2;
      const ringCount = ring === 0 ? Math.ceil(count / 2) : Math.floor(count / 2);
      const position = Math.floor(index / 2);
      const angle =
        -Math.PI / 2 + ((position + (ring === 0 ? 0 : 0.5)) * 2 * Math.PI) / Math.max(ringCount, 1);
      const rx = ring === 0 ? 330 : 190;
      const ry = ring === 0 ? 158 : 84;
      x = cx + Math.cos(angle) * rx;
      y = cy + Math.sin(angle) * ry;
    }
    placed.set(channel.name, { x: Math.round(x), y: Math.round(y) });
  });

  const agentPositions = [];
  for (const channel of channels) {
    const base = placed.get(channel.name);
    const members = channelAgents(channel);
    const dx = base.x - cx;
    const dy = base.y - cy;
    const length = Math.hypot(dx, dy) || 1;
    const outward = { x: dx / length, y: dy / length };
    const tangent = { x: -outward.y, y: outward.x };
    members.forEach((agent, index) => {
      const spread = Math.min(52, 26 + members.length * 7);
      const offset = (index - (members.length - 1) / 2) * (members.length > 1 ? spread / 1.4 : 0);
      const distance = 40 + (index % 2) * 16;
      const x = base.x + tangent.x * offset + outward.x * distance;
      const y = base.y + tangent.y * offset + outward.y * distance;
      agentPositions.push({
        agent,
        channel,
        origin: { x: base.x, y: base.y },
        x: Math.round(Math.min(862, Math.max(38, x))),
        y: Math.round(Math.min(410, Math.max(26, y))),
      });
    });
  }
  return {
    channels: channels.map((channel) => ({ channel, ...placed.get(channel.name) })),
    agents: agentPositions,
  };
}

function layoutFocus(channel) {
  const members = channelAgents(channel);
  const cx = 450;
  const cy = 300;
  const radius = members.length > 5 ? 218 : 196;
  return members.map((agent, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(members.length, 1);
    return {
      agent,
      channel,
      x: Math.round(cx + Math.cos(angle) * radius),
      y: Math.round(cy + Math.sin(angle) * radius * 0.78),
    };
  });
}

const GRAPH_DEFS = `<defs><filter id="small-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 1 1 L 8 5 L 1 9" fill="none" stroke="#6dbab4" stroke-width="1.3"/></marker><marker id="arrow-amber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 1 1 L 8 5 L 1 9" fill="none" stroke="#d2a46c" stroke-width="1.3"/></marker></defs>`;

function routeToChannel(x, y) {
  const cx = 450;
  const cy = 220;
  const dx = x - cx;
  const dy = y - cy;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const clearance = Math.min(78 / Math.abs(ux || 0.001), 30 / Math.abs(uy || 0.001));
  const sx = cx + ux * 67;
  const sy = cy + uy * 67;
  const ex = x - ux * clearance;
  const ey = y - uy * clearance;
  return `M ${sx} ${sy} C ${sx + (ex - sx) * 0.55} ${sy} ${ex - (ex - sx) * 0.4} ${ey} ${ex} ${ey}`;
}

const packet = (id, duration, delay, warning = false) =>
  `<circle class="packet ${warning ? 'warning' : ''}" r="2.3"><animateMotion dur="${duration}s" begin="-${delay}s" repeatCount="indefinite"><mpath href="#${id}"/></animateMotion></circle>`;

function channelNode(entry, index) {
  const { channel, x, y } = entry;
  const selected = channel.name === state.channel;
  const cls = channelClass(channel);
  const inactive = cls === 'idle' || cls === 'offline' || cls === 'unknown';
  return `<g class="graph-channel ${selected ? 'selected' : ''} ${cls === 'warning' ? 'warning' : ''} ${
    inactive ? 'inactive' : ''
  }" data-graph-channel="${esc(channel.name)}" role="button" tabindex="0" aria-label="选择频道 ${esc(
    channel.displayName
  )}，${esc(channel.stateLabel)}" aria-pressed="${selected}" transform="translate(${x} ${y})"><title>#${esc(
    channel.displayName
  )} · ${esc(channel.stateLabel)} · ${esc(channel.stateReason)}</title><rect class="channel-shape" x="-77" y="-28" width="154" height="56" rx="7"/><text x="-63" y="-5" class="channel-name"># ${esc(
    channel.displayName
  ).slice(0, 10)}</text><text x="-63" y="15" class="channel-caption">${esc(channel.stateLabel)} · ${
    channel.memberCount
  } 个节点</text><circle cx="62" cy="-13" r="2.5" fill="${
    cls === 'warning' ? '#deb375' : cls === 'active' ? '#7ce7d5' : '#667985'
  }"/><text x="58" y="17" class="channel-number">${String(index + 1).padStart(2, '0')}</text></g>`;
}

function agentNode(entry, focus = false) {
  const { agent, channel, x, y } = entry;
  const cls = agentClass(agent);
  const selected = state.agent === agent.name;
  const hitArea = focus
    ? '<rect class="node-hit-target" x="-88" y="-28" width="176" height="126" fill="transparent"/>'
    : '';
  const label = focus ? 'focus-node-label' : 'node-label';
  return `<g class="agent-node ${cls} ${selected ? 'selected' : ''}" data-graph-agent="${esc(
    agent.name
  )}" data-owner-channel="${esc(channel.name)}" role="button" tabindex="0" aria-label="查看智能体 ${esc(
    agent.displayName
  )}，${esc(agent.workStateLabel)}" transform="translate(${x} ${y})"><title>${esc(agent.displayName)} · ${esc(
    agent.workStateLabel
  )} · ${esc(agent.task)}</title>${hitArea}${
    cls === 'active' ? `<circle class="node-halo" r="${focus ? 26 : 15}"/>` : ''
  }<circle class="node-shell" r="${focus ? 20 : 10}"/><text class="node-initial" y="3" style="font-size:${
    focus ? 11 : 7
  }px">${esc(initials(agent))}</text><text class="${label} ${channel.name === state.channel ? 'selected' : ''}" y="${
    focus ? 47 : 25
  }">${esc(agent.displayName.slice(0, 8))}</text>${
    focus
      ? `<text class="focus-task" y="67">${esc(agent.task.slice(0, 22))}</text><text class="focus-status" y="85">${esc(
          agent.workStateLabel
        )} · ${esc(agent.host || '主机未知')}</text>`
      : ''
  }</g>`;
}

function renderGraph() {
  const svg = $('#network');
  let html = '';
  const channel = currentChannel();

  if (state.view === 'global') {
    const layout = layoutGlobal();
    html +=
      '<ellipse class="network-orbit" cx="450" cy="220" rx="287" ry="128"/><ellipse class="network-ring" cx="450" cy="220" rx="314" ry="148"/><path d="M 450 35 V 420 M 70 220 H 830" stroke="#24434b" opacity=".25" stroke-dasharray="3 8"/>';

    layout.channels.forEach((entry, index) => {
      const cls = channelClass(entry.channel);
      const flowing = cls === 'active' || cls === 'warning';
      html += `<path id="flow-${index}" class="channel-link ${entry.channel.name === state.channel ? 'selected' : ''} ${
        cls === 'warning' ? 'warning' : ''
      } ${flowing ? '' : 'inactive'}" d="${routeToChannel(entry.x, entry.y)}" marker-end="url(#${
        cls === 'warning' ? 'arrow-amber' : 'arrow'
      })"/>`;
      if (flowing) html += packet(`flow-${index}`, 4 + index * 0.4, index * 0.8, cls === 'warning');
    });

    layout.agents.forEach((entry, index) => {
      const id = `agent-link-${index}`;
      const flowing = agentClass(entry.agent) === 'active';
      html += `<path id="${id}" class="agent-link ${flowing ? '' : 'inactive'}" d="M ${entry.origin.x} ${
        entry.origin.y
      } Q ${entry.x} ${entry.origin.y} ${entry.x} ${entry.y}"/>`;
      if (flowing) html += packet(id, 3 + (index % 5) * 0.6, index % 7);
    });

    html +=
      '<g class="relay-core"><circle class="core-ring" cx="450" cy="220" r="68"/><circle class="core-ring-dashed" cx="450" cy="220" r="62"/><circle class="core-shell" cx="450" cy="220" r="53"/><circle cx="450" cy="220" r="47" fill="none" stroke="#31656a" stroke-width=".6"/><path d="M 435 195 H 465 M 445 191 H 455" stroke="#8fe5d2" stroke-width="1.2"/><text class="core-label" x="453" y="224">协作中枢</text><text class="core-subtitle" x="451" y="241">工作空间</text><circle class="core-pin" cx="450" cy="288" r="3"/><text class="core-status" x="450" y="307">工作空间 · 逻辑聚合</text></g>';

    layout.channels.forEach((entry, index) => {
      html += channelNode(entry, index);
    });
    layout.agents.forEach((entry) => {
      html += agentNode(entry);
    });

    svg.setAttribute('viewBox', '0 0 900 440');
    $('#graph-coordinate-right').innerHTML =
      `${String(state.channels.length).padStart(2, '0')} 个频道<br><span>${
        state.agents.length
      } 个智能体</span>`;
  } else if (channel) {
    const members = layoutFocus(channel);
    html += `<ellipse class="network-ring" cx="450" cy="300" rx="285" ry="210"/><text x="450" y="34" text-anchor="middle" fill="#6f959f" font-size="11">频道聚焦 / ${esc(
      channel.displayName
    )}</text>`;
    members.forEach((entry, index) => {
      const flowing = agentClass(entry.agent) === 'active';
      const id = `focus-${index}`;
      html += `<path id="${id}" class="channel-link ${flowing ? 'selected' : 'inactive'}" d="M 450 300 Q ${entry.x} 300 ${entry.x} ${entry.y}" marker-end="url(#arrow)"/>`;
      if (flowing) html += packet(id, 3.5, index);
    });
    html += `<rect x="327" y="257" width="246" height="86" rx="9" fill="#16363a" stroke="#6dbbb6"/><text x="450" y="288" text-anchor="middle" fill="#d1fbf2" font-size="18"># ${esc(
      channel.displayName.slice(0, 10)
    )}</text><text x="450" y="312" text-anchor="middle" fill="#86b8b1" font-size="11">${esc(
      channel.stateLabel
    )} · ${channel.memberCount} 个参与智能体</text><text x="450" y="330" text-anchor="middle" fill="#6f959f" font-size="9">${esc(
      channel.stateReason.slice(0, 30)
    )}</text>`;
    members.forEach((entry) => {
      html += agentNode(entry, true);
    });
    svg.setAttribute('viewBox', '0 0 900 620');
  } else {
    html += '<text x="450" y="220" text-anchor="middle" fill="#6f959f" font-size="12">暂无频道数据</text>';
    svg.setAttribute('viewBox', '0 0 900 440');
  }

  svg.innerHTML = `<title>系统频道与智能体逻辑拓扑</title>${GRAPH_DEFS}<g id="graph-camera">${html}</g>`;
  svg.classList.toggle('paused', state.paused);
  updateZoom();
  syncMotion();
  updateGraphScale();
}

function updateGraphScale() {
  const hint = $('#graph-coordinate-left');
  if (!hint) return;
  hint.innerHTML = `${esc(
    state.workspace ? state.workspace.displayName : '工作空间'
  )}<br><span>逻辑协作网络</span>`;
}

function updateZoom() {
  const cy = state.view === 'global' ? 220 : 310;
  const camera = $('#graph-camera');
  if (camera) {
    camera.setAttribute(
      'transform',
      `translate(${450 + state.panX} ${cy + state.panY}) scale(${state.zoom}) translate(-450 ${-cy})`
    );
  }
  $('#zoom-value').textContent = `${Math.round(state.zoom * 100)}%`;
  $('#zoom-out').disabled = state.zoom <= 0.7;
  $('#zoom-in').disabled = state.zoom >= 1.8;
}

function setView(view) {
  state.view = view;
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  $$('[data-view]').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  renderGraph();
}

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

function syncMotion() {
  const svg = $('#network');
  if (state.paused || reduced.matches) svg.pauseAnimations?.();
  else svg.unpauseAnimations?.();
}

reduced.addEventListener('change', syncMotion);

/* --------------------------------------------------------- channel summary */

function renderSummary() {
  const channel = currentChannel();
  const container = $('#channel-summary');
  if (!channel) {
    container.innerHTML =
      '<div class="loading-state"><strong>尚无频道</strong>该工作空间没有可见频道，或当前凭据无权查看。</div>';
    return;
  }
  const cls = channelClass(channel);
  const badgeIcon = cls === 'warning' ? 'triangle-alert' : cls === 'active' ? 'activity' : 'clock-3';
  container.innerHTML = `<div class="channel-summary"><div class="channel-eyebrow"><span class="eyebrow">频道状态与详情</span><span class="channel-status ${cls}"><i class="status-dot ${cls}"></i>${esc(
    channel.stateLabel
  )}</span></div><div class="channel-title"><h2><span>#</span>${esc(
    channel.displayName
  )}</h2><button class="icon-button" id="focus-channel" aria-label="在拓扑中聚焦 ${esc(
    channel.displayName
  )}" title="聚焦此频道">${icon('focus')}</button></div><p>${esc(
    channel.topic || '该频道未设置用途说明'
  )}</p><div class="channel-people"><div class="avatar-stack" aria-hidden="true">${channelAgents(channel)
    .slice(0, 6)
    .map((agent) => `<span class="avatar">${esc(initials(agent))}</span>`)
    .join('')}</div><span>${channel.memberCount} 个智能体</span><small>${
    channel.runningCount
  } 个执行中</small></div><div class="channel-task ${cls}">${icon(
    badgeIcon
  )}<span>${esc(channel.stateReason)}</span></div><p class="state-evidence">依据：${esc(
    evidenceLabel(channel.evidence)
  )}${channel.archived ? ' · 频道已归档，历史可查' : ''}</p></div>`;
  $('#agent-count').textContent = String(channel.memberCount);
  $('#breadcrumb-current').textContent = `# ${channel.displayName}`;
  paintIcons(container);
  const focus = $('#focus-channel');
  if (focus) focus.onclick = () => setView('channel');
}

function evidenceLabel(evidence) {
  return (
    { tasks: '任务与会话事件', messages: '近期消息', presence: '在线状态', none: '无可用证据' }[evidence] ||
    '无可用证据'
  );
}

/* ---------------------------------------------------------------- messages */

function senderOptions() {
  const list = state.messages.get(state.channel) || [];
  const senders = new Map();
  for (const message of list) senders.set(message.from, message.fromName);
  return [...senders.entries()].map(([id, name]) => ({ id, name }));
}

function renderSenders() {
  const select = $('#sender-filter');
  const previous = select.value;
  const senders = senderOptions();
  select.innerHTML =
    '<option value="all">全部发送者</option>' +
    senders.map((sender) => `<option value="${esc(sender.id)}">${esc(sender.name)}</option>`).join('');
  select.value = senders.some((sender) => sender.id === previous) ? previous : 'all';
}

function visibleMessages() {
  const list = state.messages.get(state.channel) || [];
  const query = $('#message-search').value.trim().toLowerCase();
  const sender = $('#sender-filter').value;
  const range = $('#date-filter').value;
  const today = todayDay();
  const yesterday = shiftDay(today, -1);
  return list.filter((message) => {
    if (sender !== 'all' && message.from !== sender) return false;
    if (range === 'today' && message.day !== today) return false;
    if (range === 'yesterday' && message.day !== yesterday) return false;
    if (!query) return true;
    return `${message.text} ${message.fromName} ${message.toName}`.toLowerCase().includes(query);
  });
}

function messageArticle(message) {
  const long = message.text.length > 130 || message.text.split('\n').length > 3;
  const expanded = state.expanded.has(message.id);
  return `<article class="message" data-message-id="${esc(message.id)}"><div class="message-meta"><time datetime="${esc(
    message.createdAt
  )}">${esc(message.time)}</time><span class="message-kind">${esc(message.kindLabel)}</span><button class="icon-button" data-open-message="${esc(
    message.id
  )}" aria-label="放大阅读 ${esc(message.time)} ${esc(message.fromName)} 的消息" title="放大阅读">${icon(
    'expand'
  )}</button></div><div class="message-route"><strong>${esc(message.fromName)}</strong><span class="arrow">→</span><span class="recipient">${esc(
    message.toName || '未标明接收对象'
  )}</span></div><button class="message-body ${long && !expanded ? 'collapsed' : ''}" data-open-message="${esc(
    message.id
  )}" aria-label="放大阅读消息正文">${esc(message.text)}</button><div class="message-footer-row">${
    long
      ? `<button class="message-expand" data-expand-message="${esc(message.id)}" aria-expanded="${expanded}">${
          expanded ? '收起全文' : `展开全文 · ${message.text.length} 字`
        }${icon(expanded ? 'chevron-up' : 'chevron-down')}</button>`
      : '<span></span>'
  }<span class="message-read ${message.receiptKnown ? '' : 'unknown'}">${icon(
    message.receiptKnown ? 'check-check' : 'clock-3'
  )}${esc(message.receipt)}</span></div></article>`;
}

function renderMessages() {
  const timeline = $('#message-timeline');
  const channel = currentChannel();

  if (!channel) {
    timeline.innerHTML =
      '<div class="loading-state"><strong>选择频道</strong>从左侧或拓扑中选择一个频道查看消息。</div>';
    $('#load-more').hidden = true;
    return;
  }
  if (state.loadingMessages && !state.messages.has(channel.name)) {
    timeline.innerHTML =
      '<div class="loading-state"><strong>正在读取消息</strong><span class="skeleton"></span><span class="skeleton short"></span><span class="skeleton"></span>消息读取完成后会自动显示。</div>';
    $('#load-more').hidden = true;
    return;
  }
  if (state.messageError) {
    timeline.innerHTML = `<div class="error-state"><strong>消息读取失败</strong>${esc(
      state.messageError
    )}<button type="button" id="retry-messages">重新读取</button></div>`;
    const retry = $('#retry-messages');
    if (retry) retry.onclick = () => void loadMessages({ reset: true });
    $('#load-more').hidden = true;
    return;
  }

  const list = visibleMessages();
  const all = state.messages.get(channel.name) || [];
  $('#message-count').textContent = String(all.length);

  let day = '';
  timeline.innerHTML = list.length
    ? list
        .map((message) => {
          let heading = '';
          if (day !== message.day) {
            day = message.day;
            heading = `<div class="day-separator">${esc(message.day.replaceAll('-', '.'))} · ${esc(
              zoneLabel()
            )}</div>`;
          }
          return heading + messageArticle(message);
        })
        .join('')
    : `<div class="empty-state"><strong>暂无匹配的消息</strong><p>${
        all.length === 0
          ? '该频道当前没有已加载的消息记录。'
          : $('#date-filter').value === 'today'
            ? '今日没有符合条件的消息，可切换到「昨日」或「全部已加载」。'
            : $('#message-search').value
              ? '可尝试清除搜索或更换发送者筛选。'
              : '可调整日期范围后重试。'
      }</p></div>`;

  $('#load-more').hidden = !state.hasMore;
  $('#load-more').textContent = state.loadingMessages ? '正在加载…' : '加载更早的消息';
  $('#load-more').disabled = state.loadingMessages;
  paintIcons(timeline);
}

async function loadMessages({ reset = false } = {}) {
  const channel = currentChannel();
  if (!channel || state.loadingMessages) return;
  const name = channel.name;
  state.loadingMessages = true;
  state.messageError = null;
  renderMessages();
  try {
    const page = await window.RelayApi.messages(name, {
      limit: 40,
      before: reset ? undefined : state.nextBefore || undefined,
    });
    // A late response for a channel the operator already left must not apply.
    if (!reset && state.channel !== name) return;
    const existing = reset ? [] : state.messages.get(name) || [];
    const merged = new Map();
    for (const message of existing) merged.set(message.id, message);
    for (const message of page.messages) merged.set(message.id, message);
    state.messages.set(
      name,
      [...merged.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    );
    if (state.channel === name) {
      state.hasMore = Boolean(page.hasMore);
      state.nextBefore = page.nextBefore;
    }
  } catch (error) {
    if (state.channel === name) state.messageError = error.message || '读取消息失败';
  } finally {
    state.loadingMessages = false;
    if (state.channel === name) {
      renderSenders();
      renderMessages();
    }
  }
}

/* ------------------------------------------------------------------ agents */

function renderAgents() {
  const channel = currentChannel();
  const panel = $('#agents-panel');
  if (!channel) {
    panel.innerHTML = '<div class="loading-state"><strong>尚无频道</strong>选择频道后查看参与节点。</div>';
    return;
  }
  const members = channelAgents(channel);
  panel.innerHTML = `<p class="agent-list-note">${members.length} 个智能体参与此频道。<br>下方展示工作状态、当前任务与运行主机；连接状态单独标注。</p>${
    members.length
      ? members
          .map((agent) => {
            const cls = agentClass(agent);
            const selected = state.agent === agent.name;
            return `<button class="agent-card ${selected ? 'selected' : ''}" data-agent-detail="${esc(
              agent.name
            )}" aria-pressed="${selected}"><div class="agent-card-title"><i class="status-dot ${cls}"></i><strong>${esc(
              agent.displayName
            )}</strong><small>${esc(agent.workStateLabel)}</small></div><p>${esc(agent.task)}</p><div class="agent-meta"><span>${esc(
              agent.host || '主机未知'
            )}</span><span>${esc(agent.onlineLabel)}</span></div>${
              selected
                ? `<div class="agent-note">所属频道：${
                    agent.channelNames.map((name) => `#${esc(name)}`).join('、') || '未报告'
                  }<br>工作状态依据：${esc(evidenceLabel(agent.evidence))}<br>最近活动：${esc(
                    relative(agent.lastActivityAt || agent.lastSeenAt)
                  )}${agent.reason ? `<br><span class="agent-note-warn">原因：${esc(agent.reason)}</span>` : ''}</div>`
                : ''
            }</button>`;
          })
          .join('')
      : '<p class="empty-state">该频道没有可见成员</p>'
  }`;
  paintIcons(panel);
}

/* -------------------------------------------------------------- connection */

function renderConnection() {
  const connection = state.connection || {
    state: 'connecting',
    label: '正在连接…',
    detail: '',
    mode: state.mode,
  };
  const chip = $('#connection-chip');
  const chipText = $('#connection-chip-text');
  chip.dataset.state = connection.state;
  chip.dataset.mode = state.mode;
  // The source already names itself (`演示数据 · 实时` vs `已连接 · 实时`), so the
  // chip never stacks two mode prefixes on top of each other.
  chipText.textContent = connection.label;

  const degraded = UNREADABLE_CHANNEL_STATES.has(connection.state);
  const bar = $('#connection-bar');
  bar.hidden = !degraded;
  bar.dataset.state = connection.state;
  if (degraded) {
    const updated = connection.lastRefreshAt
      ? `最后更新：${stamp(connection.lastRefreshAt)?.time || '未知'}`
      : '尚未取得数据';
    $('#connection-bar-text').textContent =
      `${connection.detail || '与 Relay 服务的事件流已中断'} · ${updated}。当前显示最后一次成功读取的数据，恢复后会自动补齐。`;
  }

  const noticeBar = $('#notice-bar');
  noticeBar.hidden = !state.notice;
  if (state.notice) $('#notice-bar-text').textContent = state.notice;

  const live = connection.state === 'live';
  $('#footer-state').textContent = state.paused
    ? '观察已暂停 · 后台任务继续运行'
    : degraded
      ? `${connection.detail || '连接中断'} · 显示最后数据`
      : `${connection.label}${connection.lastEventAt ? ` · 最后事件 ${stamp(connection.lastEventAt)?.time || ''}` : ''}`;
  $('#footer-dot').style.background = state.paused ? 'var(--amber)' : live ? 'var(--cyan)' : '#8a9aa6';
  const chipLive = $('#topology-live');
  chipLive.textContent = state.paused ? '已暂停' : live ? '实时事件' : connection.label;
  chipLive.classList.toggle('paused', !live || state.paused);
  $('#overview-subtitle').textContent = live
    ? `全局频道状态、智能体任务与消息流转 · ${zoneLabel()}`
    : `全局频道状态、智能体任务与消息流转 · ${connection.label}`;
}

function renderLiveToggle() {
  const button = $('#live-toggle');
  button.setAttribute('aria-pressed', String(state.paused));
  $('#live-label').textContent = state.paused ? '继续观察' : '停止观察';
  button.innerHTML = `<span class="tiny-dot"></span><span id="live-label">${
    state.paused ? '继续观察' : '停止观察'
  }</span>${icon(state.paused ? 'play' : 'pause')}`;
  paintIcons(button);
}

/* ------------------------------------------------------------ clock / live */

function tickClock() {
  const parts = stamp(new Date().toISOString());
  if (parts) $('#system-clock').textContent = parts.time;
  $('#clock-zone').textContent = zoneLabel();
}

function newerThan(a, b) {
  return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) > 0;
}

function onLiveMessage(message) {
  if (state.paused) {
    state.dropped += 1;
    return;
  }
  const list = state.messages.get(message.channel);
  if (list) {
    const index = list.findIndex((entry) => entry.id === message.id);
    if (index >= 0) list[index] = message;
    else list.unshift(message);
    if (list.length > 500) list.length = 500;
  }

  state.recent = [message, ...state.recent.filter((entry) => entry.id !== message.id)]
    .sort((a, b) => (newerThan(a, b) ? -1 : 1))
    .slice(0, 6);
  renderRecent();

  const channel = state.channels.find((entry) => entry.name === message.channel);
  if (channel) channel.lastMessageAt = message.createdAt;
  if (state.metrics && message.day === todayDay() && state.metrics.messagesToday !== null) {
    state.metrics.messagesToday += 1;
    renderMetrics();
  }
  state.connection = state.connection
    ? { ...state.connection, lastEventAt: message.createdAt }
    : state.connection;

  if (message.channel !== state.channel) return;
  const timeline = $('#message-timeline');
  const dialogOpen = $('#message-dialog').open;
  const atTop = timeline.scrollTop < 24;
  const typing = timeline.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (atTop && !dialogOpen && !typing && !state.paused) {
    renderSenders();
    renderMessages();
    $(`[data-message-id="${cssEscape(message.id)}"]`)?.classList.add('new-message');
  } else {
    state.pending += 1;
    showPendingButton();
  }
  tickClock();
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function showPendingButton() {
  let button = $('#pending-messages');
  if (!button) {
    button = document.createElement('button');
    button.id = 'pending-messages';
    button.className = 'pending-messages';
    button.type = 'button';
    button.onclick = () => {
      const timeline = $('#message-timeline');
      renderMessages();
      timeline.scrollTop = 0;
      state.pending = 0;
      button.remove();
    };
    $('.message-tools').append(button);
  }
  button.textContent = `${state.pending} 条新消息 · 点击查看`;
}

function applyAgentsFrame(frame) {
  if (state.paused) {
    state.dropped += 1;
    return;
  }
  state.agents = frame.agents || [];
  state.channels = frame.channels || [];
  state.metrics = frame.metrics || state.metrics;
  state.connection = frame.connection || state.connection;
  if (!state.channels.some((channel) => channel.name === state.channel)) {
    const next = state.channels[0];
    state.channel = next ? next.name : null;
    state.agent = null;
  }
  renderChannels();
  renderMetrics();
  renderTraffic();
  renderGraph();
  renderSummary();
  renderAgents();
  renderConnection();
}

function onFrame(name, payload) {
  if (name === 'ping') return;
  if (name === 'connection') {
    state.connection = payload.connection;
    renderConnection();
    return;
  }
  if (name === 'agents') {
    applyAgentsFrame(payload);
    return;
  }
  if (name === 'message') {
    onLiveMessage(payload.message);
    return;
  }
  if (name === 'bootstrap') {
    applyBootstrap(payload.bootstrap);
  }
}

function openStream() {
  if (state.stream) state.stream.close();
  state.stream = window.RelayApi.stream({
    onFrame,
    onStatus(status) {
      state.streamOpen = status === 'open';
      if (status === 'open' && state.connection && UNREADABLE_CHANNEL_STATES.has(state.connection.state)) {
        // The socket came back: re-read rather than trusting the gap.
        void refreshAll({ reason: 'reconnect' });
      }
    },
  });
}

async function refreshAll({ reason = 'manual' } = {}) {
  if (state.bootstrapping) return;
  state.bootstrapping = true;
  try {
    const data = await window.RelayApi.bootstrap();
    const dropped = state.dropped;
    state.dropped = 0;
    applyBootstrap(data);
    if (reason === 'resume' && dropped > 0) {
      toast(`已重新读取：暂停期间的 ${dropped} 个事件未逐条回放`);
    } else if (reason === 'reconnect') {
      toast('连接已恢复，已重新读取最新状态');
    }
  } catch (error) {
    toast(error.message || '刷新失败');
  } finally {
    state.bootstrapping = false;
  }
}

async function togglePause() {
  state.paused = !state.paused;
  state.pending = 0;
  $('#pending-messages')?.remove();
  renderLiveToggle();
  renderConnection();
  $('#network').classList.toggle('paused', state.paused);
  syncMotion();
  try {
    await window.RelayApi.pause(state.paused);
  } catch {
    toast('本地暂停已生效，但服务端未确认');
  }
  if (!state.paused) {
    const dropped = state.dropped;
    await refreshAll({ reason: 'resume' });
    if (dropped === 0) toast('已恢复观察');
  } else {
    toast('已暂停观察，后台任务继续运行');
  }
}

/* ------------------------------------------------------------ reading pane */

function findMessage(id) {
  for (const [, list] of state.messages) {
    const hit = list.find((message) => message.id === id);
    if (hit) return hit;
  }
  return state.recent.find((message) => message.id === id) || null;
}

let dialogOpener = null;

async function openMessage(id) {
  let message = findMessage(id);
  if (!message) {
    try {
      message = await window.RelayApi.message(id);
    } catch (error) {
      toast(error.message || '无法读取这条消息');
      return;
    }
    if (message) state.recent = [message, ...state.recent].slice(0, 6);
  }
  if (!message) return;
  state.dialogId = id;
  const visible = visibleMessages();
  state.dialogIds = visible.some((entry) => entry.id === id)
    ? visible.map((entry) => entry.id)
    : (state.messages.get(message.channel) || []).map((entry) => entry.id);
  if (!state.dialogIds.includes(id)) state.dialogIds = [id];
  dialogOpener = document.activeElement;
  renderDialog();
  $('#message-dialog').showModal();
  $('#dialog-close').focus();
}

function renderDialog() {
  const message = findMessage(state.dialogId);
  if (!message) return;
  const index = state.dialogIds.indexOf(message.id);
  $('#dialog-title').textContent = `# ${message.channelLabel} · 消息详情`;
  $('#dialog-meta').innerHTML = `<div class="dialog-route"><strong>${esc(
    message.fromName
  )}</strong><span class="arrow">→</span><span>${esc(message.toName || '未标明接收对象')}</span></div><div class="dialog-meta-line"><time>${esc(
    message.day
  )} ${esc(message.time)} ${esc(zoneLabel())}</time><span>${esc(message.kindLabel)}</span><span>${esc(
    message.receipt
  )}</span></div><div class="dialog-meta-line mono"><span>${esc(message.id)}</span><span>${
    message.text.length
  } 字</span>${message.threadId ? `<span>线程 ${esc(message.threadId)}</span>` : ''}${
    message.parentId ? `<span>父消息 ${esc(message.parentId)}</span>` : ''
  }</div>`;
  const body = $('#dialog-body');
  body.textContent = message.text;
  body.scrollTop = 0;
  $('#dialog-position').textContent = `${index + 1} / ${state.dialogIds.length}`;
  $('#previous-message').disabled = index <= 0;
  $('#next-message').disabled = index < 0 || index >= state.dialogIds.length - 1;
}

function moveMessage(offset) {
  const index = state.dialogIds.indexOf(state.dialogId) + offset;
  if (index >= 0 && index < state.dialogIds.length) {
    state.dialogId = state.dialogIds[index];
    renderDialog();
  }
}

/* ------------------------------------------------------------------ recent */

function renderRecent() {
  const container = $('#recent-activity');
  if (!state.recent.length) {
    container.innerHTML = '<p class="empty-state">暂无消息流转记录</p>';
    return;
  }
  container.innerHTML = state.recent
    .map(
      (message) =>
        `<button class="activity-row" data-activity-message="${esc(message.id)}" aria-label="查看 ${esc(
          message.time
        )} ${esc(message.fromName)} 发给 ${esc(message.toName || '未标明接收对象')} 的消息"><time>${esc(
          message.time
        )}</time><span class="activity-route"><b>${esc(message.fromName)}</b><em>→</em>${esc(
          message.toName || '未标明接收对象'
        )}</span><span class="activity-tag">#${esc(message.channelLabel)}</span></button>`
    )
    .join('');
}

/* -------------------------------------------------------------------- tabs */

function setTab(tab) {
  state.tab = tab;
  ['messages', 'agents'].forEach((name) => {
    const active = tab === name;
    $(`#${name}-tab`).classList.toggle('active', active);
    $(`#${name}-tab`).setAttribute('aria-selected', String(active));
    $(`#${name}-tab`).tabIndex = active ? 0 : -1;
    $(`#${name}-panel`).hidden = !active;
  });
  if (tab === 'messages') renderMessages();
  else renderAgents();
}

/* ------------------------------------------------------------------ events */

$('#channel-list').onclick = (event) => {
  const button = event.target.closest('[data-channel]');
  if (button) selectChannel(button.dataset.channel);
};
$('#channel-search').oninput = (event) => {
  state.channelSearch = event.target.value;
  renderChannels();
};
$$('[data-filter]').forEach((button) => {
  button.onclick = () => {
    state.filter = button.dataset.filter;
    $$('[data-filter]').forEach((other) => {
      const active = other === button;
      other.classList.toggle('active', active);
      other.setAttribute('aria-pressed', String(active));
    });
    renderChannels();
  };
});
$$('[data-view]').forEach((button) => {
  button.onclick = () => setView(button.dataset.view);
});
$('#overview-button').onclick = () => {
  setView('global');
  $('#network-panel').scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'nearest' });
};

function graphAction(event) {
  const agent = event.target.closest('[data-graph-agent]');
  const channel = event.target.closest('[data-graph-channel]');
  if (agent) selectChannel(agent.dataset.ownerChannel, agent.dataset.graphAgent);
  else if (channel) selectChannel(channel.dataset.graphChannel);
}
$('#network').onclick = graphAction;
$('#network').onkeydown = (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    graphAction(event);
  }
};
$('#agents-panel').onclick = (event) => {
  const button = event.target.closest('[data-agent-detail]');
  if (button) {
    state.agent = button.dataset.agentDetail;
    renderAgents();
    renderGraph();
  }
};
$('#messages-tab').onclick = () => setTab('messages');
$('#agents-tab').onclick = () => setTab('agents');
$('.detail-tabs').onkeydown = (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tab =
    event.key === 'Home'
      ? 'messages'
      : event.key === 'End'
        ? 'agents'
        : state.tab === 'messages'
          ? 'agents'
          : 'messages';
  setTab(tab);
  $(`#${tab}-tab`).focus();
};
['message-search', 'sender-filter', 'date-filter'].forEach((id) => {
  $(`#${id}`).addEventListener(id === 'message-search' ? 'input' : 'change', () => {
    renderMessages();
    $('#message-timeline').scrollTop = 0;
    state.pending = 0;
    $('#pending-messages')?.remove();
  });
});
$('#message-timeline').onclick = (event) => {
  const expand = event.target.closest('[data-expand-message]');
  if (expand) {
    const id = expand.dataset.expandMessage;
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    const top = $('#message-timeline').scrollTop;
    renderMessages();
    $('#message-timeline').scrollTop = top;
    $(`[data-expand-message="${cssEscape(id)}"]`)?.focus({ preventScroll: true });
    return;
  }
  const open = event.target.closest('[data-open-message]');
  if (open) void openMessage(open.dataset.openMessage);
};
$('#load-more').onclick = () => void loadMessages({ reset: false });
$('#recent-activity').onclick = (event) => {
  const button = event.target.closest('[data-activity-message]');
  if (button) void openMessage(button.dataset.activityMessage);
};
$('#dialog-close').onclick = () => $('#message-dialog').close();
$('#message-dialog').onclose = () => {
  if (dialogOpener && dialogOpener.isConnected) dialogOpener.focus({ preventScroll: true });
};
$('#previous-message').onclick = () => moveMessage(-1);
$('#next-message').onclick = () => moveMessage(1);
$('#copy-message').onclick = async () => {
  const message = findMessage(state.dialogId);
  if (!message) return;
  try {
    await navigator.clipboard.writeText(message.text);
    toast('完整消息已复制');
  } catch {
    toast('复制不可用，请选中正文手动复制');
  }
};
$('#help-button').onclick = () => $('#help-dialog').showModal();
$('#help-close').onclick = () => $('#help-dialog').close();
$$('dialog').forEach((dialog) => {
  dialog.onclick = (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      dialog.close();
    }
  };
});
$('#live-toggle').onclick = () => void togglePause();
$('#connection-retry').onclick = () => void refreshAll({ reason: 'manual' });
$('#notice-dismiss').onclick = () => {
  state.notice = null;
  renderConnection();
};
$('#zoom-in').onclick = () => {
  state.zoom = Math.min(1.8, Math.round((state.zoom + 0.1) * 10) / 10);
  updateZoom();
};
$('#zoom-out').onclick = () => {
  state.zoom = Math.max(0.7, Math.round((state.zoom - 0.1) * 10) / 10);
  updateZoom();
};
$('#zoom-reset').onclick = () => {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  updateZoom();
};
$('#fullscreen-button').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('#network-panel').requestFullscreen();
  } catch {
    toast('当前浏览器不支持全屏，可使用拓扑缩放');
  }
};

let drag = null;
$('#graph-stage').onpointerdown = (event) => {
  if (event.button !== 0 || event.target.closest('button,[role="button"]')) return;
  const rect = $('#network').getBoundingClientRect();
  drag = {
    x: event.clientX,
    y: event.clientY,
    panX: state.panX,
    panY: state.panY,
    scale: Math.min(rect.width / 900, rect.height / (state.view === 'global' ? 440 : 620)) || 1,
  };
  $('#graph-stage').setPointerCapture(event.pointerId);
  $('#graph-stage').classList.add('dragging');
};
$('#graph-stage').onpointermove = (event) => {
  if (!drag) return;
  state.panX = drag.panX + (event.clientX - drag.x) / drag.scale;
  state.panY = drag.panY + (event.clientY - drag.y) / drag.scale;
  updateZoom();
};
function endDrag() {
  drag = null;
  $('#graph-stage').classList.remove('dragging');
}
$('#graph-stage').onpointerup = endDrag;
$('#graph-stage').onpointercancel = endDrag;

document.onkeydown = (event) => {
  if (
    event.target.closest('input,textarea,select') ||
    $('dialog[open]') ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) {
    return;
  }
  if (event.key === '/') {
    event.preventDefault();
    $('#channel-search').focus();
  } else if (event.key.toLowerCase() === 'g') {
    setView('global');
  }
};

/* -------------------------------------------------------------------- init */

renderLiveToggle();
tickClock();
setInterval(tickClock, 1000);
void boot();
