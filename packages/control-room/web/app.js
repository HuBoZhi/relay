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
  channelAliases: new Map(),
  channelOrganization: new Map(),
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
  messageRequest: 0,
  messageAbort: null,
  streamFailed: false,
  seenMessages: new Set(),
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

const currentChannel = () => state.channels.find((channel) => channel.name === state.channel && state.channelOrganization.get(channel.name) !== 'deleted') || null;
const activeChannels = () => state.channels.filter((channel) => !state.channelOrganization.has(channel.name));
const archivedLocally = (channel) => channel && state.channelOrganization.get(channel.name) === 'archived';
const visibleActivity = (message) => !state.channelOrganization.has(message.channel);
const channelLabel = (name, fallback = name) =>
  state.channels.find((channel) => channel.name === name)?.displayName || fallback;
const recipientLabel = (message) =>
  message.kind === 'channel' || message.kind === 'thread_reply'
    ? channelLabel(message.to.replace(/^#/, ''), message.toName || '未标明接收对象')
    : message.toName || '未标明接收对象';

function aliasStorageKey() {
  return `relay.channel-names:${JSON.stringify([state.mode, state.connection?.target, state.workspace?.id || state.workspace?.name])}`;
}

function organizationStorageKey() { return aliasStorageKey().replace('relay.channel-names:', 'relay.channel-organization:'); }

function readChannelOrganization() {
  try {
    const entries = JSON.parse(localStorage.getItem(organizationStorageKey()) || '[]');
    state.channelOrganization = new Map(Array.isArray(entries) ? entries.filter((entry) =>
      Array.isArray(entry) && typeof entry[0] === 'string' && ['archived', 'deleted'].includes(entry[1])) : []);
  } catch { state.channelOrganization = new Map(); }
}

function organizeChannel(action, name = state.channel) {
  if (!['archived', 'deleted', 'restore'].includes(action)) return false;
  if (!state.channels.some(channel => channel.name === name)) return false;
  const organization = new Map(state.channelOrganization);
  if (action === 'restore') organization.delete(name);
  else organization.set(name, action);
  try { localStorage.setItem(organizationStorageKey(), JSON.stringify([...organization])); }
  catch { toast('操作保存失败，请检查本机存储是否可用'); return false; }
  state.channelOrganization = organization;
  if (action !== 'restore') {
    state.messageAbort?.abort();
    state.messageRequest += 1;
    state.loadingMessages = false;
    state.channel = null;
    state.agent = null;
    state.pending = 0;
    $('#pending-messages')?.remove();
    state.view = 'global';
  } else {
    state.filter = 'all';
  }
  renderAll();
  toast(action === 'archived' ? '已在本机归档，可从归档区恢复' : action === 'deleted' ? '已从本机移除，服务端消息保留' : '已恢复到主题列表');
  $('#overview-button').focus();
  return true;
}

function readChannelAliases() {
  try {
    const entries = JSON.parse(localStorage.getItem(aliasStorageKey()) || '[]');
    state.channelAliases = new Map(Array.isArray(entries) ? entries.filter((entry) =>
      Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' &&
      entry[1].trim().length > 0 && entry[1].length <= 60) : []);
  } catch {
    state.channelAliases = new Map();
  }
}

function applyChannelAliases(channels) {
  return channels.map((channel) => ({
    ...channel,
    originalDisplayName: channel.originalDisplayName || channel.displayName,
    displayName: state.channelAliases.get(channel.name) || channel.originalDisplayName || channel.displayName,
  }));
}

function saveChannelName(reset = false) {
  const channel = currentChannel();
  if (!channel) return;
  const value = $('#channel-name-input').value.trim();
  if (!reset && (!value || value.length > 60)) {
    $('#channel-name-input').setCustomValidity('请输入 1–60 个字符的主题名称');
    $('#channel-name-input').reportValidity();
    return;
  }
  const aliases = new Map(state.channelAliases);
  if (reset) aliases.delete(channel.name);
  else aliases.set(channel.name, value);
  try {
    localStorage.setItem(aliasStorageKey(), JSON.stringify([...aliases]));
  } catch {
    toast('名称保存失败，请检查本机存储是否可用');
    return;
  }
  state.channelAliases = aliases;
  state.channels = applyChannelAliases(state.channels);
  $('#rename-form').hidden = true;
  renderAll();
  if ($('#message-dialog').open) renderDialog();
  $('#rename-channel').focus();
  toast(reset ? '已恢复原名' : '主题名称已保存');
}
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

// Every failure the operator can see is Chinese. Transport errors arrive in
// English (`Failed to fetch`, `ECONNREFUSED`, …), so they are named here rather
// than printed; the raw text stays in the console for diagnosis.
function describeError(error, fallback = '读取失败') {
  const raw = error && error.message ? String(error.message) : String(error || '');
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw;
  if (/failed to fetch|load failed|network ?error|fetch failed/i.test(raw)) {
    return '无法连接本地服务，请确认控制中心仍在运行';
  }
  if (/abort/i.test(raw)) return '读取已取消';
  if (/timed?\s*out|timeout/i.test(raw)) return '读取超时，请稍后重试';
  if (/econnrefused|connection refused/i.test(raw)) return '本地服务拒绝连接';
  if (/econnreset|socket hang up/i.test(raw)) return '本地服务中断了连接';
  if (/enotfound|getaddrinfo/i.test(raw)) return '无法解析服务地址';
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(raw)) return '凭据无效或权限不足';
  if (/\b429\b|too many requests|rate limit/i.test(raw)) return '请求过于频繁，请稍后重试';
  if (/\b5\d\d\b/.test(raw)) return '本地服务处理请求时出错';
  console.warn('[控制中心] 未识别的错误原文：', raw);
  return fallback;
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
      detail: describeError(error, '无法读取工作空间数据'),
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
  readChannelAliases();
  readChannelOrganization();
  state.channels = applyChannelAliases(data.channels || []);
  state.agents = data.agents || [];
  state.nodes = data.nodes || [];
  state.metrics = data.metrics;
  state.capabilities = data.capabilities;
  state.notice = data.notice;
  state.recent = (data.recentMessages || []).slice(0, 6);

  const stillThere = state.channels.some((channel) => channel.name === previousChannel && state.channelOrganization.get(channel.name) !== 'deleted');
  if (!stillThere) {
    // Archived channels keep their history but are the worst default: nothing
    // there is live, so only fall back to one when nothing else exists.
    const live = activeChannels().filter((channel) => !channel.archived);
    const pool = live.length > 0 ? live : activeChannels();
    const preferred =
      pool.find((channel) => channel.state === 'attention') ||
      pool.find((channel) => channel.state === 'active') ||
      pool.find((channel) => channel.state === 'waiting' || channel.state === 'idle') ||
      pool[0];
    state.channel = preferred ? preferred.name : null;
    state.agent = null;
    state.expanded.clear();
    state.pending = 0;
    $('#pending-messages')?.remove();
    $('#message-search').value = '';
    $('#sender-filter').value = 'all';
    $('#date-filter').value = preferred?.archived ? 'all' : 'today';
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
  renderPage();
  paintIcons();
}

// Navigation owns the scope of the entire workspace, not just the graph.
function renderPage() {
  const overview = state.view === 'global';
  const channel = currentChannel();
  $('#rename-channel').hidden = overview || !channel;
  $('#theme-management').hidden = overview || !channel;
  if (overview) $('#theme-management').open = false;
  $('#archive-channel').hidden = !channel || archivedLocally(channel);
  $('#restore-channel').hidden = !channel || !archivedLocally(channel);
  if (overview) $('#rename-form').hidden = true;
  document.body.dataset.page = overview ? 'overview' : 'channel';
  $('.metrics').hidden = !overview;
  $('.inspector').hidden = overview;
  $('.traffic-section').hidden = !overview;
  $('.activity-section').hidden = !overview;
  $('#overview-button').classList.toggle('active', overview);
  $('#overview-button').setAttribute('aria-pressed', String(overview));
  $('#breadcrumb-current').textContent = overview ? '系统总览' : channel ? `# ${channel.displayName}` : '频道详情';
  $('#page-title').textContent = overview ? '协作控制中心' : channel ? `# ${channel.displayName}` : '频道详情';
  $('#page-eyebrow').textContent = overview ? '全局指挥台' : archivedLocally(channel) ? '本机归档主题' : '频道指挥台';
  $('#overview-subtitle').textContent = overview
    ? `全局频道状态、智能体任务与消息流转 · ${zoneLabel()}`
    : channel?.topic || '该频道的参与节点、工作状态与消息记录';
  $('#network-eyebrow').textContent = overview ? '全局协作网络' : '频道内部协作';
  $('#network-title').textContent = overview ? '频道阵列' : '节点协作';
  const headingIndex = $('.heading-index');
  if (headingIndex) headingIndex.textContent = overview ? '01' : '02';
  $('.heading-readout strong').textContent = state.paused ? '只读 · 已暂停' : '只读 · 持续';
  $('#network-context').textContent = overview ? '全局频道与成员关系' : '频道节点与任务状态';
  $('.graph-hint').lastChild.textContent = overview ? '选择频道，进入独立协作空间' : '选择节点，查看频道内参与者';
  $$('[data-view]').forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function renderFatal(error) {
  const message = describeError(error, '无法读取工作空间数据');
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
  if (state.channelOrganization.get(channel.name) === 'deleted') return false;
  if ((state.filter === 'archived') !== archivedLocally(channel)) return false;
  const query = state.channelSearch.trim().toLowerCase();
  if (state.filter !== 'all' && state.filter !== 'archived') {
    const wanted = state.filter;
    const mapped = channel.state === 'attention' ? 'warning' : channel.state;
    if (mapped !== wanted) return false;
  }
  if (!query) return true;
  return `${channel.name} ${channel.displayName} ${channel.topic}`.toLowerCase().includes(query);
}

function renderChannels() {
  const total = activeChannels().length;
  const working = activeChannels().filter((channel) => channel.state === 'active').length;
  const attention = activeChannels().filter((channel) => channel.state === 'attention').length;
  $('#channel-total').textContent = String(total).padStart(2, '0');
  $('#filter-count-all').textContent = String(total);
  $('#filter-count-active').textContent = String(working);
  $('#filter-count-warning').textContent = String(attention);
  $('#filter-count-archived').textContent = String(state.channels.filter(archivedLocally).length);
  $$('[data-filter]').forEach(button => {
    const active = button.dataset.filter === state.filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  const list = state.channels.filter(matchesChannel);
  $('#channel-list').innerHTML = list.length
    ? list
        .map((channel) => {
          const selected = state.view === 'channel' && channel.name === state.channel;
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
            )}，${esc(archivedLocally(channel) ? '本机已归档' : channel.stateLabel)}"><span class="hash">#</span><span class="channel-info"><strong>${esc(
            channel.displayName
          )}</strong><small><i class="status-dot ${channelClass(channel)}"></i>${
            channel.memberCount
            } 个智能体<span>· ${esc(archivedLocally(channel) ? '本机已归档' : channel.stateLabel)}</span></small></span><span class="channel-spark" aria-hidden="true">${bars}</span></button>`;
        })
        .join('')
    : `<p class="empty-state">${
        state.filter === 'archived' ? '暂无本机归档主题' : state.channels.length === 0 ? '暂无可见频道，或尚未成功读取频道列表' : total === 0 ? '暂无可见主题，可在归档区查看历史主题' : '未找到匹配的频道'
      }</p>`;
}

function selectChannel(name, agent = null) {
  if (!state.channels.some((channel) => channel.name === name) || state.channelOrganization.get(name) === 'deleted') return;
  const changed = name !== state.channel;
  $('#rename-form').hidden = true;
  $('#theme-management').open = false;
  state.channel = name;
  state.view = 'channel';
  state.agent = agent;
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.pending = 0;
  $('#pending-messages')?.remove();
  if (changed) {
    state.expanded.clear();
    $('#message-search').value = '';
    $('#date-filter').value = currentChannel()?.archived || archivedLocally(currentChannel()) ? 'all' : 'today';
    $('#sender-filter').value = 'all';
    state.messageError = null;
    state.nextBefore = null;
    state.hasMore = false;
  }
  renderChannels();
  renderGraph();
  renderSummary();
  renderAgents();
  renderPage();
  setTab(agent ? 'agents' : state.tab);
  if (!state.messages.has(name) || changed) void loadMessages({ reset: true });
  else {
    renderSenders();
    renderMessages();
    if (changed) $('#message-timeline').scrollTop = 0;
  }
}

/* ----------------------------------------------------------------- metrics */

function metricText(selector, value) {
  const element = $(selector);
  const next = String(value);
  if (element.textContent === next) return;
  element.textContent = next;
  if (element.dataset.ready === 'true' && !reduced.matches && typeof element.animate === 'function') {
    element.animate(
      [
        { opacity: 0.25, transform: 'translateY(0.32em)', filter: 'blur(2px)' },
        { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
      ],
      { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
  }
  element.dataset.ready = 'true';
}

function renderMetrics() {
  const metrics = state.metrics;
  if (!metrics) return;
  const working = metrics.channelsWorking;
  metricText('#metric-channels-working', working === null ? '--' : String(working).padStart(2, '0'));
  $('#metric-channels-total').textContent = `/ ${String(metrics.channelsTotal).padStart(2, '0')}`;
  const ratio = working === null || metrics.channelsTotal === 0 ? 0 : (working / metrics.channelsTotal) * 100;
  $('#metric-channels-bar').style.width = `${Math.round(ratio)}%`;

  const running = metrics.agentsRunning;
  metricText('#metric-agents-running', running === null ? '--' : String(running));
  $('#metric-agents-total').textContent = `/ ${metrics.agentsTotal}`;
  $('#metric-agents-note').textContent =
    running === null
      ? '未提供任务事件，工作状态显示为未知'
      : `在线 ${metrics.agentsOnline === null ? '未知' : metrics.agentsOnline} 个 · 工作与在线状态分别展示`;

  const today = metrics.messagesToday;
  metricText(
    '#metric-messages-today',
    today === null ? '--' : `${today.toLocaleString('zh-CN')}${metrics.messagesTodayPartial ? '+' : ''}`
  );
  $('#metric-messages-note').textContent =
    today === null
      ? '暂无数据'
      : metrics.messagesTodayPartial
        ? `按${zoneLabel()}统计已加载频道，其余频道未计`
        : `按${zoneLabel()}统计已加载频道`;

  const attention = metrics.channelsAttention;
  metricText('#metric-attention', attention === null ? '--' : String(attention).padStart(2, '0'));
  const attentionChannel = activeChannels().find((channel) => channel.state === 'attention');
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
  const bars = points
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
  const coordinates = points.map((point, index) => {
    const x = points.length === 1 ? 160 : (index / (points.length - 1)) * 320;
    const y = 78 - (point.count / peak) * 62;
    return { x, y };
  });
  const line = coordinates.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = `${line} L320,84 L0,84 Z`;
  const lastPoint = coordinates[coordinates.length - 1];
  chart.innerHTML = `<div class="traffic-bars">${bars}</div><svg class="traffic-line-chart" viewBox="0 0 320 88" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="traffic-area-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#68e4ff" stop-opacity=".24"/><stop offset="1" stop-color="#68e4ff" stop-opacity="0"/></linearGradient></defs><path class="traffic-grid-line" d="M0 22H320M0 50H320M0 78H320"/><path class="traffic-area" d="${area}"/><path class="traffic-line" d="${line}" pathLength="1"/><circle class="traffic-point" cx="${lastPoint.x}" cy="${lastPoint.y}" r="3"/></svg>`;
  const labels = points.filter((_, index) => index % Math.max(1, Math.floor(points.length / 4)) === 0);
  axis.innerHTML = labels
    .map((point) => `<span>${(stamp(point.at) || {}).minute || '--:--'}</span>`)
    .join('');
  $('#traffic-window').textContent = `最近 ${throughput.windowMinutes} 分钟 · 本机观察`;
  const last = points[points.length - 1];
  metricText('#traffic-rate', String(last ? last.count : 0));
  chart.setAttribute(
    'aria-label',
    `消息吞吐趋势：最近 ${throughput.windowMinutes} 分钟，共 ${throughput.total} 条，峰值每分钟 ${peak} 条。`
  );
}

/* ---------------------------------------------------------------- topology */

function globalCorePosition() {
  return ($('#graph-stage')?.clientWidth || 900) < 520 ? { x: 450, y: 220 } : { x: 180, y: 220 };
}

function layoutGlobal() {
  const channels = activeChannels();
  const count = channels.length || 1;
  const mobile = ($('#graph-stage')?.clientWidth || 900) < 520;
  const rowCount = Math.ceil(count / 2);
  const rows = rowCount === 4
    ? [58, 142, 298, 382]
    : Array.from({ length: rowCount }, (_, index) => 58 + (index * 324) / Math.max(rowCount - 1, 1));
  return {
    channels: channels.map((channel, index) => ({
      channel,
      x: mobile ? (index % 2 === 0 ? 250 : 650) : (index % 2 === 0 ? 480 : 760),
      y: rows[Math.floor(index / 2)] ?? 220,
    })),
    agents: [],
    viewBox: mobile ? '100 0 700 440' : '0 0 900 440',
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
      y: Math.round(cy + Math.sin(angle) * radius * 0.62),
    };
  });
}

const GRAPH_DEFS = `<defs>
  <filter id="small-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="1.6" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <filter id="core-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <filter id="selected-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <radialGradient id="core-aura"><stop offset="0" stop-color="#63dfff" stop-opacity=".18"/><stop offset=".55" stop-color="#3188c9" stop-opacity=".055"/><stop offset="1" stop-color="#3188c9" stop-opacity="0"/></radialGradient>
  <radialGradient id="core-fill" cx="36%" cy="27%"><stop offset="0" stop-color="#173e59"/><stop offset=".52" stop-color="#0d263c"/><stop offset="1" stop-color="#081522"/></radialGradient>
  <radialGradient id="node-fill" cx="35%" cy="28%"><stop offset="0" stop-color="#1a3d55"/><stop offset="1" stop-color="#0a1a29"/></radialGradient>
  <linearGradient id="channel-surface" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#13283a"/><stop offset=".55" stop-color="#0c1b2a"/><stop offset="1" stop-color="#09131f"/></linearGradient>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 1 1 L 8 5 L 1 9" fill="none" stroke="#74ccec" stroke-width="1.3"/></marker>
  <marker id="arrow-amber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 1 1 L 8 5 L 1 9" fill="none" stroke="#e8ad68" stroke-width="1.3"/></marker>
</defs>`;

function routeToChannel(x, y) {
  const { x: cx, y: cy } = globalCorePosition();
  const dx = x - cx;
  const dy = y - cy;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const clearance = Math.min(105 / Math.abs(ux || 0.001), 34 / Math.abs(uy || 0.001));
  const sx = cx + ux * 67;
  const sy = cy + uy * 67;
  const ex = x - ux * clearance;
  const ey = y - uy * clearance;
  return `M ${sx} ${sy} C ${sx + (ex - sx) * 0.55} ${sy} ${ex - (ex - sx) * 0.4} ${ey} ${ex} ${ey}`;
}

function routeToAgent(entry) {
  const cx = 450;
  const cy = 300;
  const dx = entry.x - cx;
  const dy = entry.y - cy;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const sx = cx + ux * 82;
  const sy = cy + uy * 82;
  const ex = entry.x - ux * 29;
  const ey = entry.y - uy * 29;
  const direction = dx >= 0 ? 1 : -1;
  const bend = Math.min(28, length * 0.12) * direction;
  const qx = (sx + ex) / 2 - uy * bend;
  const qy = (sy + ey) / 2 + ux * bend;
  return `M ${sx} ${sy} Q ${qx} ${qy} ${ex} ${ey}`;
}

function focusBackdrop(channel) {
  return `<g class="focus-backdrop" aria-hidden="true">
    <ellipse class="network-ring focus-ring-outer" cx="450" cy="300" rx="326" ry="245"/>
    <ellipse class="network-orbit focus-ring-inner" cx="450" cy="300" rx="274" ry="202"/>
    <ellipse class="focus-orbit-flow" cx="450" cy="300" rx="274" ry="202" pathLength="100"/>
    <path class="focus-axis" d="M 450 48 V 552 M 105 300 H 795"/>
    <path class="focus-corners" d="M 122 172 V 128 H 166 M 734 128 H 778 V 172 M 122 428 V 472 H 166 M 734 472 H 778 V 428"/>
    <g class="focus-orbit-nodes"><circle cx="450" cy="98" r="2"/><circle cx="724" cy="300" r="2"/><circle cx="450" cy="502" r="2"/><circle cx="176" cy="300" r="2"/></g>
    <text class="focus-kicker" x="450" y="34">频道协作网络 / ${esc(channel.displayName)}</text>
    <text class="focus-caption" x="450" y="54">节点状态与消息事件实时映射</text>
  </g>`;
}

function channelCore(channel) {
  const cls = channelClass(channel);
  const name = channel.displayName.length > 10 ? `${channel.displayName.slice(0, 9)}…` : channel.displayName;
  return `<g class="channel-core ${cls}" transform="translate(450 300)">
    <circle class="core-aura" r="122"/>
    <circle class="core-wave wave-a" r="79"/>
    <circle class="core-wave wave-b" r="79"/>
    <g class="core-rotor"><circle class="core-rotor-track" r="97" pathLength="100"/><circle class="core-rotor-dot" cx="0" cy="-97" r="3"/></g>
    <circle class="core-orbit-inner" r="84"/>
    <circle class="core-ring-dashed" r="73" pathLength="100"/>
    <circle class="core-shell" r="62"/>
    <circle class="core-shell-line" r="55"/>
    <g class="core-symbol" transform="translate(0 -29)" aria-hidden="true"><path d="M -13 4 L 0 -5 L 13 4 M 0 -5 V 11"/><circle cx="-13" cy="4" r="3"/><circle cx="13" cy="4" r="3"/><circle class="core-symbol-main" cx="0" cy="-5" r="4"/><circle cx="0" cy="11" r="2.5"/></g>
    <text class="channel-core-name" y="14"># ${esc(name)}</text>
    <text class="channel-core-meta" y="34">${esc(channel.stateLabel)} · ${channel.memberCount} 个节点</text>
    <g class="core-bars" transform="translate(-15 44)" aria-hidden="true"><rect x="0" y="-5" width="3" height="5" rx="1"/><rect x="6" y="-9" width="3" height="9" rx="1"/><rect x="12" y="-6" width="3" height="6" rx="1"/><rect x="18" y="-12" width="3" height="12" rx="1"/><rect x="24" y="-7" width="3" height="7" rx="1"/></g>
  </g>`;
}

function workspaceCore() {
  const channels = activeChannels();
  const working = channels.filter((channel) => channel.state === 'active').length;
  const core = globalCorePosition();
  return `<g class="relay-core workspace-core ${working ? 'active' : 'idle'}" transform="translate(${core.x} ${core.y})">
    <circle class="core-aura" r="126"/>
    <circle class="core-wave wave-a" r="82"/>
    <circle class="core-wave wave-b" r="82"/>
    <g class="core-rotor"><circle class="core-rotor-track" r="91" pathLength="100"/><circle class="core-rotor-dot" cx="0" cy="-91" r="2.5"/></g>
    <circle class="core-orbit-inner" r="79"/>
    <circle class="core-ring-dashed" r="69" pathLength="100"/>
    <path class="core-calibration" d="M-4-105H4M0-105V-97M-4 105H4M0 105V97M-105-4V4M-105 0H-97M105-4V4M105 0H97"/>
    <circle class="core-shell" r="59"/>
    <circle class="core-shell-line" r="52"/>
    <text class="core-kicker" y="-25">全域协作</text>
    <text class="core-label" y="2">协作中枢</text>
    <text class="core-subtitle" y="24">${String(working).padStart(2, '0')} / ${String(channels.length).padStart(2, '0')} 频道活跃</text>
    <g class="core-bars" transform="translate(-12 37)" aria-hidden="true"><rect x="0" y="-4" width="2" height="4"/><rect x="5" y="-8" width="2" height="8"/><rect x="10" y="-5" width="2" height="5"/><rect x="15" y="-10" width="2" height="10"/><rect x="20" y="-6" width="2" height="6"/></g>
  </g>`;
}

const packet = (id, duration, delay, warning = false) =>
  `<g class="packet ${warning ? 'warning' : ''}"><circle r="7" opacity=".13"/><circle r="3.1"/><circle r="1.1" fill="#efffff"/><animateMotion dur="${duration}s" begin="-${delay}s" repeatCount="indefinite"><mpath href="#${id}"/></animateMotion></g>`;

function channelNode(entry, index) {
  const { channel, x, y } = entry;
  const selected = state.view === 'channel' && channel.name === state.channel;
  const cls = channelClass(channel);
  const inactive = cls === 'idle' || cls === 'offline' || cls === 'unknown';
  return `<g class="graph-channel ${selected ? 'selected' : ''} ${cls === 'warning' ? 'warning' : ''} ${
    inactive ? 'inactive' : ''
  }" data-graph-channel="${esc(channel.name)}" role="button" tabindex="0" aria-label="选择频道 ${esc(
    channel.displayName
  )}，${esc(channel.stateLabel)}" aria-pressed="${selected}" transform="translate(${x} ${y})"><title>#${esc(
    channel.displayName
  )} · ${esc(channel.stateLabel  )} · ${esc(channel.stateReason)}</title><rect class="channel-shape" x="-104" y="-32" width="208" height="64" rx="3"/><path class="channel-corners" d="M-104-20V-32H-92M92-32H104V-20M104 20V32H92M-92 32H-104V20"/><path class="channel-status-line" d="M-88-23H-58"/><text x="-88" y="-5" class="channel-name"># ${esc(
    channel.displayName.length > 15 ? `${channel.displayName.slice(0, 14)}…` : channel.displayName
  )}</text><text x="-88" y="17" class="channel-caption">${esc(channel.stateLabel)} · ${
    channel.memberCount
  } 个节点</text><circle class="channel-state-light" cx="88" cy="-17" r="2.5"/><text x="78" y="17" class="channel-number">${String(index + 1).padStart(2, '0')}</text><g class="channel-ticks" aria-hidden="true"><path d="M-98-26V-22M-94-26V-24M-90-26V-22M90 22V26M94 24V26M98 22V26"/></g></g>`;
}

function agentNode(entry, focus = false, index = 0) {
  const { agent, channel, x, y } = entry;
  const cls = agentClass(agent);
  const selected = state.agent === agent.name;
  const verticalLabels = focus && Math.abs(x - 450) < 50;
  const labelsAbove = focus && !verticalLabels && y < 300;
  const labelY = verticalLabels ? -13 : labelsAbove ? -47 : focus ? 47 : 25;
  const taskY = verticalLabels ? 7 : labelsAbove ? -67 : 67;
  const statusY = verticalLabels ? 27 : labelsAbove ? -85 : 85;
  const labelAnchor = verticalLabels ? 'x="38" text-anchor="start"' : 'text-anchor="middle"';
  const hitArea = focus
    ? verticalLabels
      ? '<rect class="node-hit-target" x="-30" y="-38" width="230" height="82" fill="transparent"/>'
      : `<rect class="node-hit-target" x="-92" y="${labelsAbove ? -101 : -34}" width="184" height="137" fill="transparent"/>`
    : '';
  const label = focus ? 'focus-node-label' : 'node-label';
  const animated = cls === 'active' || cls === 'warning';
  return `<g class="agent-node ${cls} ${selected ? 'selected' : ''}" data-graph-agent="${esc(
    agent.name
  )}" data-owner-channel="${esc(channel.name)}" role="button" tabindex="0" aria-label="查看智能体 ${esc(
    agent.displayName
  )}，${esc(agent.workStateLabel)}" transform="translate(${x} ${y})" style="--node-delay:${index * -0.55}s"><title>${esc(
    agent.displayName
  )} · ${esc(agent.workStateLabel)} · ${esc(agent.task)}</title>${hitArea}<g class="node-visual">${
    focus && animated
      ? '<circle class="node-pulse" r="25"/><circle class="node-orbit" r="29" pathLength="100"/>'
      : cls === 'active'
        ? `<circle class="node-halo" r="${focus ? 26 : 15}"/>`
        : ''
  }<circle class="node-shell" r="${focus ? 20 : 10}"/>${
    focus ? '<circle class="node-shell-detail" r="15"/><circle class="node-status-dot" cx="14" cy="-14" r="3.5"/>' : ''
  }<text class="node-initial" y="3" style="font-size:${focus ? 11 : 7}px">${esc(
    initials(agent)
  )}</text></g><text class="${label} ${channel.name === state.channel ? 'selected' : ''}" y="${labelY}" ${labelAnchor}>${esc(
    agent.displayName.slice(0, 8)
  )}</text>${
    focus
      ? `<text class="focus-task" y="${taskY}" ${labelAnchor}>${esc(agent.task.slice(0, 22))}</text><text class="focus-status" y="${statusY}" ${labelAnchor}>${esc(
          agent.workStateLabel
        )} · ${esc(agent.host || '主机未知')}</text>`
      : ''
  }</g>`;
}

function renderGraph() {
  const svg = $('#network');
  const scope = state.view === 'global' ? 'global' : `channel:${state.channel}`;
  const pulses = svg.dataset.scope === scope ? $$('.observed-flow', svg) : [];
  let html = '';
  const channel = currentChannel();

  if (state.view === 'global') {
    const layout = layoutGlobal();
    const core = globalCorePosition();
    html += `<g class="array-backdrop" aria-hidden="true">
      <path class="array-spine" d="M${core.x} 36V404"/>
      <path class="array-bus" d="M${core.x} 220H860"/>
      <path class="array-guides" d="M480 38V402M760 38V402"/>
      <path class="array-ticks" d="M174 58H186M174 142H186M174 298H186M174 382H186"/>
      <circle class="array-beacon" cx="${core.x}" cy="58" r="2"/><circle class="array-beacon" cx="${core.x}" cy="382" r="2"/>
      ${core.x === 180 ? '<text class="array-label" x="480" y="24">频道序列 / 01</text><text class="array-label" x="760" y="24">频道序列 / 02</text><text class="array-core-label" x="180" y="24">工作空间核心</text>' : ''}
    </g>`;

    layout.channels.forEach((entry, index) => {
      const cls = channelClass(entry.channel);
      const flowing = cls === 'active' || cls === 'warning';
      const route = routeToChannel(entry.x, entry.y);
      html += `<path class="flow-link-bed" d="${route}"/><path id="flow-${index}" class="channel-link ${
        cls === 'warning' ? 'warning' : flowing ? 'selected' : 'inactive'
      }" d="${route}" pathLength="100" marker-end="url(#${cls === 'warning' ? 'arrow-amber' : 'arrow'})"/>`;
      if (flowing && state.mode === 'demo')
        html += packet(`flow-${index}`, 4 + index * 0.4, index * 0.8, cls === 'warning');
    });

    layout.agents.forEach((entry, index) => {
      const id = `agent-link-${index}`;
      const flowing = agentClass(entry.agent) === 'active';
      html += `<path id="${id}" class="agent-link ${flowing ? '' : 'inactive'}" d="M ${entry.origin.x} ${
        entry.origin.y
      } Q ${entry.x} ${entry.origin.y} ${entry.x} ${entry.y}"/>`;
      if (flowing && state.mode === 'demo') html += packet(id, 3 + (index % 5) * 0.6, index % 7);
    });

    html += workspaceCore();

    layout.channels.forEach((entry, index) => {
      html += channelNode(entry, index);
    });
    layout.agents.forEach((entry) => {
      html += agentNode(entry);
    });

    svg.setAttribute('viewBox', layout.viewBox);
    $('#graph-coordinate-right').innerHTML =
      `${String(activeChannels().length).padStart(2, '0')} 个频道<br><span>${
        state.agents.length
      } 个智能体</span>`;
  } else if (channel) {
    const members = layoutFocus(channel);
    html += focusBackdrop(channel);
    members.forEach((entry, index) => {
      const flowing = agentClass(entry.agent) === 'active';
      const warning = agentClass(entry.agent) === 'warning';
      const id = `focus-${index}`;
      const route = routeToAgent(entry);
      html += `<path class="flow-link-bed" d="${route}"/><path id="${id}" class="channel-link ${
        flowing ? 'selected' : warning ? 'warning' : 'inactive'
      }" d="${route}" pathLength="100" marker-end="url(#${warning ? 'arrow-amber' : 'arrow'})"/>`;
      if (flowing && state.mode === 'demo') {
        html += `<path class="flow-link-glint demo-stream" d="${route}" pathLength="100"/>`;
        html += packet(id, 3.4 + index * 0.18, index * 0.85);
        html += packet(id, 3.4 + index * 0.18, index * 0.85 + 1.7);
      }
    });
    html += channelCore(channel);
    members.forEach((entry, index) => {
      html += agentNode(entry, true, index);
    });
    svg.setAttribute('viewBox', ($('#graph-stage')?.clientWidth || 900) < 520 ? '140 0 620 620' : '0 0 900 620');
    $('#graph-coordinate-right').innerHTML =
      `${esc(channel.displayName)}<br><span>${members.length} 个参与智能体</span>`;
  } else {
    html += '<text x="450" y="220" text-anchor="middle" fill="#6f959f" font-size="12">暂无频道数据</text>';
    svg.setAttribute('viewBox', '0 0 900 440');
  }

  svg.innerHTML = `<title>系统频道与智能体逻辑拓扑</title>${GRAPH_DEFS}<g id="graph-camera">${html}</g>`;
  svg.dataset.scope = scope;
  for (const pulse of pulses) {
    const path = $(`#${pulse.dataset.link}`, svg);
    if (path) {
      pulse.setAttribute('d', path.getAttribute('d'));
      $('#graph-camera').append(pulse);
    }
  }
  // Membership is not proof of a message delivery or its direction.
  if (state.mode !== 'demo') $$('[marker-end]', svg).forEach((path) => path.removeAttribute('marker-end'));
  $('.legend-flow').innerHTML = '<i></i>' + (state.mode === 'demo' ? '演示流转' : '成员关系');
  svg.classList.toggle('paused', state.paused);
  updateZoom();
  syncMotion();
  updateGraphScale();
}

function updateGraphScale() {
  const hint = $('#graph-coordinate-left');
  if (!hint) return;
  hint.innerHTML = `${esc(
    state.view === 'channel' ? currentChannel()?.displayName || '频道' : state.workspace ? state.workspace.displayName : '工作空间'
  )}<br><span>${state.view === 'channel' ? '频道参与关系' : '逻辑协作网络'}</span>`;
}

// Keep compact captions readable without flattening larger headings. CSSOM also
// exposes font sizes declared through the font shorthand and inside media rules.
function applyMinimumTextSize() {
  function visit(rules) {
    for (const rule of rules) {
      if (rule.cssRules) visit(rule.cssRules);
      const shorthand = rule.style?.getPropertyValue('font');
      const size = rule.style?.fontSize || shorthand?.match(/(?:^|\s)(\d*\.?\d+px)(?=[/\s])/)?.[1];
      if (size && /^\d*\.?\d+px$/.test(size)) {
        rule.style.setProperty('font-size', `${Math.max(13, parseFloat(size))}px`, rule.style.getPropertyPriority('font-size') || rule.style.getPropertyPriority('font'));
      }
    }
  }
  for (const sheet of document.styleSheets) {
    try { visit(sheet.cssRules); } catch { /* External stylesheets may deny CSSOM access. */ }
  }
  const floor = document.createElement('style');
  floor.textContent = 'small, time { font-size: 13px !important; }';
  document.head.append(floor);
}

function graphScale() {
  const svg = $('#network');
  const matrix = svg.getScreenCTM?.();
  if (matrix) return Math.hypot(matrix.a, matrix.b) || 1;
  const rect = svg.getBoundingClientRect();
  const viewWidth = svg.viewBox?.baseVal?.width || 900;
  return Math.min(rect.width / viewWidth, rect.height / (state.view === 'global' ? 440 : 620)) || 1;
}

function zoomBounds() {
  // Narrow screens use a dedicated layout and larger SVG type, so the full map
  // can remain visible instead of forcing a cropped, magnified desktop canvas.
  const narrow = ($('#graph-stage')?.clientWidth || 900) < 520;
  const min = narrow ? 1 : Math.max(0.7, 1 / graphScale());
  return { min, max: Math.max(4, min * 4) };
}

function changeZoom(next, anchor = null) {
  const bounds = zoomBounds();
  const zoom = Math.max(bounds.min, Math.min(bounds.max, next));
  if (anchor) {
    const svg = $('#network');
    const point = svg.createSVGPoint();
    point.x = anchor.clientX;
    point.y = anchor.clientY;
    const position = point.matrixTransform(svg.getScreenCTM().inverse());
    const ratio = zoom / state.zoom;
    const cy = state.view === 'global' ? 220 : 300;
    state.panX = (position.x - 450) * (1 - ratio) + state.panX * ratio;
    state.panY = (position.y - cy) * (1 - ratio) + state.panY * ratio;
  }
  state.zoom = zoom;
  updateZoom();
}

function updateZoom() {
  for (const text of $$('#network text[font-size]')) {
    const size = Number(text.getAttribute('font-size'));
    if (size > 0 && size < 13) text.setAttribute('font-size', '13');
  }
  const bounds = zoomBounds();
  state.zoom = Math.max(bounds.min, Math.min(bounds.max, state.zoom));
  const cy = state.view === 'global' ? 220 : 300;
  const camera = $('#graph-camera');
  if (camera) {
    camera.setAttribute(
      'transform',
      `translate(${450 + state.panX} ${cy + state.panY}) scale(${state.zoom}) translate(-450 ${-cy})`
    );
  }
  $('#zoom-value').textContent = `${Math.round(state.zoom * 100)}%`;
  $('#zoom-out').disabled = state.zoom <= bounds.min + 0.001;
  $('#zoom-in').disabled = state.zoom >= bounds.max - 0.001;
}

function setView(view) {
  if (view === 'channel' && !currentChannel()) return;
  state.view = view;
  $('#rename-form').hidden = true;
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  $$('[data-view]').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  renderGraph();
  renderChannels();
  renderPage();
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
  const detailsOpen = $('.channel-extra', container)?.open === true;
  if (!channel) {
    container.innerHTML =
      '<div class="loading-state"><strong>尚无频道</strong>该工作空间没有可见频道，或当前凭据无权查看。</div>';
    $('#agent-count').textContent = '0';
    $('#breadcrumb-current').textContent = '系统总览';
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
  } 个执行中</small></div><details class="channel-extra"${detailsOpen ? ' open' : ''}><summary>状态详情</summary><div class="channel-extra-body"><div class="channel-task ${cls}">${icon(
    badgeIcon
  )}<span>${esc(channel.stateReason)}</span></div><p class="state-evidence">依据：${esc(
    evidenceLabel(channel.evidence)
  )}${channel.archived ? ' · 频道已归档，历史可查' : ''}</p></div></details></div>`;
  $('#agent-count').textContent = String(channel.memberCount);
  renderPage();
  paintIcons(container);
  const focus = $('#focus-channel');
  if (focus) focus.onclick = () => setView('channel');
}

function evidenceLabel(evidence) {
  return (
    {
      tasks: '任务与会话事件',
      status: '旧版状态事件',
      messages: '近期消息',
      presence: '在线状态',
      none: '无可用证据',
    }[evidence] || '无可用证据'
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
    return `${message.text} ${message.fromName} ${recipientLabel(message)}`.toLowerCase().includes(query);
  });
}

function messageArticle(message) {
  const long = message.text.length > 130 || message.text.split('\n').length > 3;
  const expanded = state.expanded.has(message.id);
  return `<article class="message" data-message-id="${esc(message.id)}"><div class="message-meta"><time datetime="${esc(
    message.createdAt
  )}" title="${esc(`${message.day} ${message.time} ${zoneLabel()}`)}">${esc(message.time || stamp(message.createdAt)?.time || '时间未知')}</time><span class="message-kind">${esc(message.kindLabel)}</span><button class="icon-button" data-open-message="${esc(
    message.id
  )}" aria-label="放大阅读 ${esc(message.time)} ${esc(message.fromName)} 的消息" title="放大阅读">${icon(
    'expand'
  )}</button></div><div class="message-route"><strong>${esc(message.fromName)}</strong><span class="arrow">→</span><span class="recipient">${esc(
    recipientLabel(message)
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
  $('#message-count').textContent = String((state.messages.get(state.channel) || []).length);
  $('#message-scope').textContent = state.loadingMessages ? '正在读取消息…' : '仅筛选已加载消息';
  timeline.setAttribute('aria-busy', String(state.loadingMessages));

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
  $('#message-scope').textContent = `已加载 ${all.length} 条 · 匹配 ${list.length} 条`;

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
  if (!channel || (state.loadingMessages && !reset)) return;
  state.messageAbort?.abort();
  const controller = new AbortController();
  state.messageAbort = controller;
  const request = ++state.messageRequest;
  const name = channel.name;
  const timeline = $('#message-timeline');
  const scrollTop = timeline.scrollTop;
  // Live messages received during the request must survive the HTTP snapshot.
  const beforeRequest = new Set((state.messages.get(name) || []).map((message) => message.id));
  state.loadingMessages = true;
  state.messageError = null;
  renderMessages();
  try {
    const page = await window.RelayApi.messages(name, {
      limit: 40,
      before: reset ? undefined : state.nextBefore || undefined,
      signal: controller.signal,
    });
    // A late response for a channel the operator already left must not apply.
    if (request !== state.messageRequest || state.channel !== name) return;
    const current = state.messages.get(name) || [];
    const existing = reset ? current.filter((message) => !beforeRequest.has(message.id)) : current;
    const merged = new Map();
    for (const message of page.messages) merged.set(message.id, message);
    for (const message of existing) merged.set(message.id, message);
    state.messages.set(
      name,
      [...merged.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    );
    if (state.channel === name) {
      state.hasMore = Boolean(page.hasMore);
      state.nextBefore = page.nextBefore;
    }
  } catch (error) {
    if (request === state.messageRequest && state.channel === name && error.name !== 'AbortError') {
      state.messageError = describeError(error, '读取消息失败');
    }
  } finally {
    if (request === state.messageRequest && state.channel === name) {
      state.loadingMessages = false;
      renderSenders();
      renderMessages();
      timeline.scrollTop = reset ? 0 : scrollTop;
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
                    agent.channelNames
                      .map(
                        (name) =>
                          `#${esc(state.channels.find((entry) => entry.name === name)?.displayName || name)}`
                      )
                      .join('、') || '未报告'
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
  const sourceConnection = state.connection || {
    state: 'connecting',
    label: '正在连接…',
    detail: '',
    mode: state.mode,
  };
  const connection = state.streamFailed
    ? {
        ...sourceConnection,
        state: 'reconnecting',
        label: '重连中',
        detail: '浏览器与本地服务的实时连接已中断，正在自动重试',
      }
    : sourceConnection;
  const chip = $('#connection-chip');
  const chipText = $('#connection-chip-text');
  chip.dataset.state = connection.state;
  chip.dataset.mode = state.mode;
  // The source already names itself (`演示数据 · 实时` vs `已连接 · 实时`), so the
  // chip never stacks two mode prefixes on top of each other.
  chipText.textContent = state.paused ? '观察已暂停' : connection.label;
  if (state.paused) chip.dataset.state = 'paused';

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
  document.body.classList.toggle('observer-paused', state.paused);
  renderPage();
}

function renderLiveToggle() {
  const button = $('#live-toggle');
  button.setAttribute('aria-pressed', String(state.paused));
  $('#live-label').textContent = state.paused ? '继续' : '暂停';
  button.innerHTML = `<span class="tiny-dot"></span><span id="live-label">${
    state.paused ? '继续' : '暂停'
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
  let list = state.messages.get(message.channel);
  if (!list && message.channel === state.channel && state.loadingMessages) {
    list = [];
    state.messages.set(message.channel, list);
  }
  const duplicate = state.seenMessages.has(message.id) || Boolean(findMessage(message.id));
  state.seenMessages.add(message.id);
  if (state.seenMessages.size > 2000) state.seenMessages.delete(state.seenMessages.values().next().value);
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

  if (!duplicate && !state.paused) pulseMessage(message);

  const channel = state.channels.find((entry) => entry.name === message.channel);
  if (channel) channel.lastMessageAt = message.createdAt;
  if (!duplicate && state.metrics && message.day === todayDay() && state.metrics.messagesToday !== null) {
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
    if (!duplicate) {
      state.pending += 1;
      showPendingButton();
    }
  }
  tickClock();
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

// A single bounded pulse represents an observed event. Membership alone never animates.
function pulseMessage(message) {
  if (reduced.matches || state.paused || document.hidden) return;
  if (!visibleActivity(message)) return;
  const index = activeChannels().findIndex((channel) => channel.name === message.channel);
  if (index < 0 || (state.view === 'channel' && message.channel !== state.channel)) return;
  const paths = state.view === 'global'
    ? [$(`#flow-${index}`)]
    : channelAgents(currentChannel()).flatMap((agent, memberIndex) =>
        agent.name === message.from || agent.name === message.to ? [$(`#focus-${memberIndex}`)] : []);
  for (const path of paths.filter(Boolean)) {
    const pulse = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pulse.setAttribute('d', path.getAttribute('d'));
    pulse.setAttribute('class', 'observed-flow');
    pulse.dataset.link = path.id;
    pulse.setAttribute('pathLength', '1');
    path.parentNode.append(pulse);
    pulse.addEventListener('animationend', () => pulse.remove(), { once: true });
    setTimeout(() => pulse.remove(), 1800);
  }
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
      renderSenders();
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
  state.channels = applyChannelAliases(frame.channels || []);
  state.metrics = frame.metrics || state.metrics;
  state.connection = frame.connection || state.connection;
  if (!currentChannel()) {
    const next = activeChannels().find((channel) => !channel.archived) || activeChannels()[0];
    if (next) {
      const previousView = state.view;
      selectChannel(next.name);
      if (previousView === 'global') setView('global');
    } else {
      state.messageAbort?.abort();
      state.messageRequest += 1;
      state.loadingMessages = false;
      state.channel = null;
      state.view = 'global';
      state.agent = null;
      state.pending = 0;
      $('#pending-messages')?.remove();
      renderMessages();
    }
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
    if (state.paused) state.dropped += 1;
    else applyBootstrap(payload.bootstrap);
  }
}

function openStream() {
  if (state.stream) state.stream.close();
  state.stream = window.RelayApi.stream({
    onFrame,
    onStatus(status) {
      const reconnecting = state.streamFailed;
      state.streamOpen = status === 'open';
      state.streamFailed = status === 'error';
      renderConnection();
      if (
        status === 'open' &&
        !state.paused &&
        (reconnecting || (state.connection && UNREADABLE_CHANNEL_STATES.has(state.connection.state)))
      ) {
        // The socket came back: re-read rather than trusting the gap.
        void refreshAll({ reason: 'reconnect' });
      }
    },
  });
}

async function refreshAll({ reason = 'manual' } = {}) {
  if (state.bootstrapping || state.paused) return;
  state.bootstrapping = true;
  try {
    const data = await window.RelayApi.bootstrap();
    if (state.paused) return;
    const dropped = state.dropped;
    state.dropped = 0;
    applyBootstrap(data);
    if (!state.stream) openStream();
    if (reason === 'resume' && dropped > 0) {
      toast(`已重新读取：暂停期间的 ${dropped} 个事件未逐条回放`);
    } else if (reason === 'reconnect') {
      toast('连接已恢复，已重新读取最新状态');
    }
  } catch (error) {
    state.connection = {
      ...state.connection,
      state: 'degraded',
      label: '刷新失败',
      detail: describeError(error, '无法读取最新工作空间数据'),
    };
    renderConnection();
    toast(describeError(error, '刷新失败'));
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
  // Pause belongs to this browser. Pausing the shared source would freeze all
  // observers and prevent other windows from receiving messages.
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
      toast(describeError(error, '无法读取这条消息'));
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
  $('#dialog-title').textContent = `# ${channelLabel(message.channel, message.channelLabel)} · 消息详情`;
  $('#dialog-meta').innerHTML = `<div class="dialog-route"><strong>${esc(
    message.fromName
  )}</strong><span class="arrow">→</span><span>${esc(recipientLabel(message))}</span></div><div class="dialog-meta-line"><time>${esc(
    message.day
  )} ${esc(message.time)} ${esc(zoneLabel())}</time><span>${esc(message.kindLabel)}</span><span>${esc(
    message.receipt
  )}</span></div><div class="dialog-meta-line mono"><span>${
    message.text.length
  } 字</span>${message.threadId ? '<span>属于消息线程</span>' : ''}${
    message.parentId ? '<span>回复了更早的消息</span>' : ''
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
  const recent = state.recent.filter(visibleActivity);
  if (!recent.length) {
    container.innerHTML = '<p class="empty-state">暂无消息流转记录</p>';
    return;
  }
  container.innerHTML = recent
    .map(
      (message) =>
        `<button class="activity-row" data-activity-message="${esc(message.id)}" aria-label="查看 ${esc(
          message.time
        )} ${esc(message.fromName)} 发给 ${esc(recipientLabel(message))} 的消息"><time>${esc(
          message.time
        )}</time><span class="activity-route"><b>${esc(message.fromName)}</b><em>→</em>${esc(
          recipientLabel(message)
        )}</span><span class="activity-tag">#${esc(channelLabel(message.channel, message.channelLabel))}</span><span class="activity-preview">${esc(
          message.text.replace(/\s+/g, ' ').slice(0, 72)
        )}</span></button>`
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

$('#archive-channel').onclick = () => organizeChannel('archived');
$('#theme-management').onkeydown = (event) => {
  if (event.key === 'Escape') {
    event.stopPropagation();
    $('#theme-management').open = false;
    $('#theme-management > summary').focus();
  }
};
document.addEventListener('click', (event) => {
  if (!$('#theme-management').contains(event.target)) $('#theme-management').open = false;
});
$('#restore-channel').onclick = () => {
  if (organizeChannel('restore')) $('#theme-management').open = false;
};
let deleteTarget = null;
$('#delete-channel').onclick = () => {
  const channel = currentChannel();
  if (!channel) return;
  deleteTarget = { name: channel.name, key: organizationStorageKey() };
  $('#delete-channel-description').textContent = `将“${channel.displayName}”从本机列表和拓扑中移除。服务端主题和消息会保留，其他成员不受影响。`;
  $('#theme-management').open = false;
  $('#delete-channel-dialog').showModal();
  $('#delete-channel-cancel').focus();
};
$('#delete-channel-cancel').onclick = () => $('#delete-channel-dialog').close();
$('#delete-channel-form').onsubmit = (event) => {
  event.preventDefault();
  if (!deleteTarget || deleteTarget.key !== organizationStorageKey()) {
    $('#delete-channel-dialog').close();
    toast('工作空间已切换，请重新选择主题');
    return;
  }
  if (organizeChannel('deleted', deleteTarget.name)) {
    $('#delete-channel-dialog').close();
    $('#overview-button').focus();
  }
};
$('#delete-channel-dialog').addEventListener('close', () => {
  deleteTarget = null;
  if (state.view === 'channel') $('#theme-management > summary').focus();
});

$('#rename-channel').onclick = () => {
  const channel = currentChannel();
  if (!channel) return;
  $('#rename-form').hidden = false;
  $('#channel-name-input').value = channel.displayName;
  $('#channel-name-input').setCustomValidity('');
  $('#channel-name-input').focus();
  $('#channel-name-input').select();
};
$('#rename-form').onsubmit = (event) => { event.preventDefault(); saveChannelName(); };
$('#channel-name-input').oninput = () => $('#channel-name-input').setCustomValidity('');
$('#rename-cancel').onclick = () => { $('#rename-form').hidden = true; $('#rename-channel').focus(); };
$('#rename-reset').onclick = () => saveChannelName(true);
$('#rename-form').onkeydown = (event) => {
  if (event.key === 'Escape') { event.stopPropagation(); $('#rename-cancel').click(); }
};
window.addEventListener('storage', (event) => {
  if (![aliasStorageKey(), organizationStorageKey(), null].includes(event.key)) return;
  readChannelAliases();
  readChannelOrganization();
  state.channels = applyChannelAliases(state.channels);
  if (!currentChannel()) { state.channel = null; state.view = 'global'; }
  renderAll();
  if ($('#message-dialog').open) renderDialog();
});

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
  changeZoom(state.zoom * 1.15);
};
$('#zoom-out').onclick = () => {
  changeZoom(state.zoom / 1.15);
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

$('#graph-stage').addEventListener('wheel', (event) => {
  if (event.ctrlKey || event.metaKey || !event.deltaY) return;
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? $('#graph-stage').clientHeight : 1;
  const delta = Math.max(-400, Math.min(400, event.deltaY * unit));
  changeZoom(state.zoom * Math.exp(-delta * 0.002), event);
}, { passive: false });
const resizeGraph = () => (state.workspace ? renderGraph() : updateZoom());
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resizeGraph).observe($('#network'));
window.addEventListener('resize', resizeGraph);

let drag = null;
$('#graph-stage').onpointerdown = (event) => {
  if (event.button !== 0 || event.target.closest('button,[role="button"]')) return;
  const rect = $('#network').getBoundingClientRect();
  drag = {
    x: event.clientX,
    y: event.clientY,
    panX: state.panX,
    panY: state.panY,
    scale: Math.min(rect.width / ($('#network').viewBox?.baseVal?.width || 900), rect.height / (state.view === 'global' ? 440 : 620)) || 1,
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

/* ------------------------------------------------------- desktop menu bar */

/**
 * The desktop shell hides the native title bar and hands the page its menu.
 * In a browser `window.relayDesktop` does not exist, so none of this runs and
 * the bar keeps its web layout.
 */
async function mountDesktopMenu() {
  const bridge = window.relayDesktop;
  if (!bridge || typeof bridge.menu !== 'function') return;

  document.documentElement.classList.add('is-desktop');
  if (bridge.platform) document.documentElement.classList.add(`is-${bridge.platform}`);

  let groups = [];
  try {
    groups = await bridge.menu();
  } catch {
    return;
  }
  if (!Array.isArray(groups) || groups.length === 0) return;

  const nav = $('#app-menu');
  const divider = $('#topbar-divider');
  let openIndex = -1;

  nav.innerHTML = groups
    .map(
      (group, index) => `
      <div class="app-menu__group">
        <button
          class="app-menu__trigger"
          type="button"
          role="menuitem"
          aria-haspopup="true"
          aria-expanded="false"
          data-menu-trigger="${index}"
        >${esc(group.label)}</button>
        <div class="app-menu__panel" role="menu" aria-label="${esc(group.label)}" data-menu-panel="${index}" hidden>
          ${group.items
            .map((item) =>
              item.type === 'separator'
                ? '<div class="app-menu__sep" role="separator"></div>'
                : `<button class="app-menu__item" type="button" role="menuitem" data-menu-action="${esc(item.id)}">${esc(item.label)}</button>`
            )
            .join('')}
        </div>
      </div>`
    )
    .join('');
  nav.hidden = false;
  divider.hidden = false;

  const triggers = $$('[data-menu-trigger]', nav);
  const panels = $$('[data-menu-panel]', nav);

  const closeMenu = (restoreFocus = false) => {
    if (openIndex < 0) return;
    const index = openIndex;
    openIndex = -1;
    panels[index].hidden = true;
    triggers[index].setAttribute('aria-expanded', 'false');
    if (restoreFocus) triggers[index].focus();
  };

  const openMenu = (index) => {
    if (index === openIndex) return;
    if (openIndex >= 0) {
      panels[openIndex].hidden = true;
      triggers[openIndex].setAttribute('aria-expanded', 'false');
    }
    openIndex = index;
    panels[index].hidden = false;
    triggers[index].setAttribute('aria-expanded', 'true');
  };

  triggers.forEach((trigger, index) => {
    trigger.onclick = (event) => {
      event.stopPropagation();
      if (openIndex === index) closeMenu();
      else openMenu(index);
    };
    // Once a group is open, hovering another switches to it like a real menu bar.
    trigger.onmouseenter = () => {
      if (openIndex >= 0 && openIndex !== index) openMenu(index);
    };
  });

  panels.forEach((panel) => {
    panel.onclick = (event) => {
      const action = event.target.closest('[data-menu-action]');
      if (!action) return;
      closeMenu();
      Promise.resolve(bridge.run(action.dataset.menuAction)).catch(() => {
        toast('这个操作暂时不可用');
      });
    };
  });

  document.addEventListener('click', (event) => {
    if (!nav.contains(event.target)) closeMenu();
  });

  nav.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowDown', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') {
      closeMenu(true);
      return;
    }
    if (openIndex < 0) {
      openMenu(0);
      triggers[0].focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      panels[openIndex].querySelector('[data-menu-action]')?.focus();
      return;
    }
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = (openIndex + step + triggers.length) % triggers.length;
    openMenu(next);
    triggers[next].focus();
  };
}

/* -------------------------------------------------------- spatial response */

function bindSpatialLight() {
  let frame = 0;
  let pointer = null;
  document.addEventListener(
    'pointermove',
    (event) => {
      if (reduced.matches || event.pointerType === 'touch') return;
      pointer = event;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        const surface = pointer?.target.closest?.('.spatial-surface, .metric, .channel-item, .agent-card');
        if (surface) {
          const rect = surface.getBoundingClientRect();
          surface.style.setProperty('--pointer-x', `${pointer.clientX - rect.left}px`);
          surface.style.setProperty('--pointer-y', `${pointer.clientY - rect.top}px`);
        }
        frame = 0;
      });
    },
    { passive: true }
  );
}

/* -------------------------------------------------------------------- init */

applyMinimumTextSize();
bindSpatialLight();
renderLiveToggle();
tickClock();
void mountDesktopMenu();
setInterval(tickClock, 1000);
void boot();
