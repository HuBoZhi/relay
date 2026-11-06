// Task workspace front end: dispatch, watch stages, and read what actually
// happened. Every label comes from the server's layered status; this file never
// upgrades a transport fact into a business result.
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

const TRANSPORT = {
  'local-saved': ['本地已保存', 'info'],
  'relay-received': ['Relay 已接收', 'info'],
  delivering: ['投递中', 'warn'],
  'target-received': ['目标已接收', 'ok'],
  'delivery-failed': ['投递失败', 'bad'],
};
const EXECUTION = {
  'awaiting-dependency': ['等待前置阶段', 'idle'],
  queued: ['已排队', 'warn'],
  accepted: ['已受理', 'info'],
  running: ['执行中', 'info'],
  'awaiting-confirmation': ['等待确认', 'warn'],
  blocked: ['阻塞', 'bad'],
  interrupted: ['已中断', 'bad'],
  failed: ['执行失败', 'bad'],
  'turn-ended': ['本轮结束', 'idle'],
  unknown: ['未知', 'idle'],
};
const BUSINESS = {
  unconfirmed: ['业务未确认', 'idle'],
  developed: ['开发完成', 'ok'],
  reviewed: ['审查完成', 'ok'],
  accepted: ['验收通过', 'ok'],
  rejected: ['验收未通过', 'bad'],
  cancelled: ['已取消', 'idle'],
};
const CALLBACK = {
  pending: ['待投递', 'warn'],
  'queued-in-chat': ['已入聊天队列', 'info'],
  'in-chat': ['已回到聊天', 'ok'],
  'awaiting-host': ['待宿主处理', 'warn'],
  handled: ['已处理', 'ok'],
  manual: ['需人工处理', 'bad'],
};
const CAPABILITY = {
  supported: ['支持', 'ok'],
  unsupported: ['不支持', 'bad'],
  unverified: ['未验证', 'idle'],
};
const OUTCOME = {
  completed: ['完成', 'ok'],
  failed: ['失败', 'bad'],
  blocked: ['阻塞', 'warn'],
};
const MESSAGE_TONE = {
  'task.submitted': 'info',
  'stage.dispatched': 'ok',
  'stage.accepted': 'ok',
  'stage.queued': 'warn',
  'callback.received': 'info',
  'callback.delivered': 'ok',
  'callback.manual': 'warn',
  'stage.continued': 'info',
  'task.cancelled': 'bad',
  'task.note': 'idle',
};
const STAGE_KINDS = [
  ['develop', '开发'],
  ['review', '审查'],
  ['verify', '验证'],
];
const CLIENTS = [
  ['zcode', 'ZCode'],
  ['workbuddy', 'WorkBuddy'],
  ['factory', 'Factory'],
  ['codex', 'ChatGPT / Codex'],
];
const CLIENT_LABELS = Object.fromEntries(CLIENTS);

const state = {
  summary: null,
  detail: null,
  view: 'overview',
  taskId: null,
  topic: null,
  receipt: null,
  draft: null,
  issues: [],
  loading: false,
  desktop: null,
  settingsDraft: null,
};

/* ------------------------------------------------------------------ helpers */

function badge(map, value) {
  const [label, tone] = map[value] || [value, 'idle'];
  const attr = tone === 'idle' ? '' : ` data-tone="${tone}"`;
  return `<span class="badge"${attr}>${esc(label)}</span>`;
}

function timeLabel(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = date.toLocaleTimeString('zh-CN', { hour12: false });
  return sameDay
    ? time
    : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`;
}

function layersOf(status) {
  if (!status) return '';
  const cells = [
    ['传输', TRANSPORT[status.transport.state]?.[0] || status.transport.state, status.transport.at],
    ['执行', EXECUTION[status.execution.state]?.[0] || status.execution.state, status.execution.at],
    ['业务结果', BUSINESS[status.business.state]?.[0] || status.business.state, status.business.at],
    ['回传', CALLBACK[status.callback.state]?.[0] || status.callback.state, status.callback.at],
  ];
  return `<div class="layers">${cells
    .map(
      ([label, value, at]) =>
        `<div class="layer"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(timeLabel(at))}</small></div>`
    )
    .join('')}</div>`;
}

function toast(message, tone = 'ok') {
  const element = $('#toast');
  element.textContent = message;
  element.dataset.tone = tone;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, 5200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = new Error((body && body.error) || `请求失败（${response.status}）`);
    error.status = response.status;
    error.issues = body && body.issues;
    throw error;
  }
  return body;
}

function setView(view, extra = {}) {
  const form = $('#dispatch-form');
  if (form) readForm(form);
  state.view = view;
  Object.assign(state, extra);
  if (view !== 'dispatch') state.receipt = null;
  document.body.dataset.view = view;
  $$('[data-nav]').forEach((button) => {
    const active = button.dataset.nav === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const crumb = {
    overview: '概览',
    dispatch: '派发任务',
    clients: '客户端接入',
    settings: '设置与数据',
    task: '任务详情',
  };
  $('#crumb-current').textContent = crumb[view] || '概览';
  render();
}

/* -------------------------------------------------------------------- data */

async function loadSummary() {
  try {
    state.summary = await api('/api/async/summary');
    state.engineError = null;
  } catch (error) {
    state.summary = null;
    state.engineError = error;
  }
  renderChrome();
  renderRail();
}

async function loadDetail(taskId) {
  try {
    state.detail = await api(`/api/async/tasks/${encodeURIComponent(taskId)}`);
    state.detailError = null;
  } catch (error) {
    state.detail = null;
    state.detailError = error;
  }
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  try {
    await loadSummary();
    if (state.view === 'task' && state.taskId) await loadDetail(state.taskId);
    render();
  } finally {
    state.loading = false;
  }
}

/* ------------------------------------------------------------------ chrome */

function renderChrome() {
  const chip = $('#engine-chip');
  const chipText = $('#engine-chip-text');
  const rootChip = $('#data-root-chip');
  const banner = $('#banner');
  const bannerText = $('#banner-text');

  if (!state.summary) {
    const missing = state.engineError && state.engineError.status === 404;
    chip.dataset.state = 'off';
    chipText.textContent = missing ? '任务引擎未启用' : '无法读取任务数据';
    rootChip.textContent = '—';
    banner.hidden = false;
    bannerText.textContent = missing
      ? '当前服务以只读模式运行。用 desktop 应用启动，或给 relay-control-room 加 --tasks 参数后即可派发任务。'
      : (state.engineError && state.engineError.message) || '无法连接本地任务接口';
    paintIcons();
    return;
  }

  const counts = state.summary.counts || {};
  const needsAttention =
    (counts.callbacksManual || 0) + (counts.awaitingConfirmation || 0) + (counts.failed || 0);
  chip.dataset.state = needsAttention > 0 ? 'warn' : 'ok';
  chipText.textContent =
    needsAttention > 0
      ? `运行中 · ${needsAttention} 项需要关注`
      : `运行中 · ${counts.inFlight || 0} 个阶段在途`;
  rootChip.textContent = state.summary.dataRoot || '—';
  rootChip.title = state.summary.dataRoot || '';
  if (state.summary.warnings && state.summary.warnings.length > 0) {
    banner.hidden = false;
    bannerText.textContent = state.summary.warnings.join('  ');
  } else {
    banner.hidden = true;
  }
  paintIcons();
}

function renderRail() {
  const topics = state.summary ? state.summary.topics || [] : [];
  $('#topic-total').textContent = String(topics.length);
  $('#nav-count-tasks').textContent = String(state.summary ? state.summary.counts.tasks : 0);
  const list = $('#topic-list');
  if (topics.length === 0) {
    list.innerHTML = `<p class="hint-text">还没有主题。派发第一个任务后会在这里出现。</p>`;
    return;
  }
  const byTopic = new Map();
  for (const task of state.summary.tasks) byTopic.set(task.topicId, (byTopic.get(task.topicId) || 0) + 1);
  list.innerHTML = topics
    .map((topic) => {
      const count = byTopic.get(topic.id) || 0;
      const active = state.topic === topic.id ? ' active' : '';
      return `<button type="button" class="topic-item${active}" data-topic="${esc(topic.id)}">
        ${esc(topic.name)}<span>${count} 个任务 · ${esc(topic.slug)}</span>
      </button>`;
    })
    .join('');
  $$('[data-topic]', list).forEach((button) => {
    button.onclick = () => {
      state.topic = state.topic === button.dataset.topic ? null : button.dataset.topic;
      setView('overview');
    };
  });
}

/* ------------------------------------------------------------------ render */

function render() {
  const main = $('#main');
  const focused = main.contains(document.activeElement) ? document.activeElement : null;
  const focusedId = focused?.id;
  const selection = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null;
  const existingForm = $('#dispatch-form');
  if (existingForm) readForm(existingForm);
  if (!state.summary && state.view !== 'settings') {
    main.innerHTML = `<div class="card"><div class="empty">任务引擎当前不可用。<br>界面只读取本地任务接口，不会自行创建任务或会话。</div></div>`;
    paintIcons(main);
    return;
  }
  if (state.view === 'dispatch') main.innerHTML = renderDispatch();
  else if (state.view === 'clients') main.innerHTML = renderClients();
  else if (state.view === 'settings') main.innerHTML = renderSettings();
  else if (state.view === 'task') main.innerHTML = renderTask();
  else main.innerHTML = renderOverview();
  wire(main);
  paintIcons(main);
  const restored = focusedId && document.getElementById(focusedId);
  if (restored) {
    restored.focus({ preventScroll: true });
    if (selection && restored.setSelectionRange) restored.setSelectionRange(...selection);
  }
}

function tasksForView() {
  const tasks = state.summary.tasks || [];
  return state.topic ? tasks.filter((task) => task.topicId === state.topic) : tasks;
}

function renderOverview() {
  const summary = state.summary;
  const counts = summary.counts;
  const tasks = tasksForView();
  const topicName = state.topic ? summary.topics.find((topic) => topic.id === state.topic)?.name : null;
  const manual = (summary.callbacks || []).filter((callback) => callback.delivery.state === 'manual');
  const pending = (summary.callbacks || []).filter((callback) =>
    ['pending', 'awaiting-host'].includes(callback.delivery.state)
  );

  return `
    <div class="card">
      <div class="card-head">
        <h2>${topicName ? esc(topicName) : '全局任务态势'}</h2>
        <span class="hint">${topicName ? '该主题下的全部任务' : '传输、执行、业务、回传四层分开统计'}</span>
        <span class="spacer"></span>
        <button class="button-ghost" type="button" data-action="dispatch">派发任务</button>
      </div>
      <div class="stat-grid">
        <div class="stat"><span>任务总数</span><strong>${counts.tasks}</strong></div>
        <div class="stat" data-tone="warn"><span>在途阶段</span><strong>${counts.inFlight}</strong></div>
        <div class="stat" data-tone="${counts.awaitingConfirmation ? 'warn' : 'ok'}"><span>等待确认</span><strong>${counts.awaitingConfirmation}</strong></div>
        <div class="stat" data-tone="${counts.callbacksManual ? 'bad' : 'ok'}"><span>回传需人工</span><strong>${counts.callbacksManual}</strong></div>
        <div class="stat"><span>待投递回传</span><strong>${counts.callbacksPendingDelivery}</strong></div>
        <div class="stat" data-tone="${counts.failed ? 'bad' : 'ok'}"><span>执行失败</span><strong>${counts.failed}</strong></div>
      </div>
    </div>

    ${
      manual.length + pending.length > 0
        ? `<div class="card">
            <div class="card-head"><h2>待处理回传</h2><span class="hint">回传没有进入原聊天时，必须在这里处理</span></div>
            <div class="table-wrap"><table class="grid"><thead><tr><th>主题</th><th>阶段</th><th>结论</th><th>投递状态</th><th>原因</th><th></th></tr></thead><tbody>
              ${[...manual, ...pending]
                .map((callback) => {
                  const task = summary.tasks.find((item) => item.id === callback.taskId);
                  const stage = summary.stages.find((item) => item.id === callback.stageId);
                  const topic = summary.topics.find((item) => item.id === (task && task.topicId));
                  return `<tr>
                    <td>${esc(topic ? topic.name : '—')}</td>
                    <td>${esc(stage ? stage.label : '—')}</td>
                    <td>${badge(OUTCOME, callback.outcome)} ${esc(callback.summary)}</td>
                    <td>${badge(CALLBACK, callback.delivery.state)}</td>
                    <td class="muted">${esc(callback.delivery.reason || '—')}</td>
                    <td class="inline-actions">
                      <button class="button-ghost" type="button" data-open="${esc(callback.taskId)}">查看</button>
                      <button class="button-ghost" type="button" data-retry="${esc(callback.id)}">重新投递</button>
                    </td>
                  </tr>`;
                })
                .join('')}
            </tbody></table></div>
          </div>`
        : ''
    }

    <div class="card">
      <div class="card-head"><h2>任务链</h2><span class="hint">点击任务查看阶段、真实会话与证据</span></div>
      ${
        tasks.length === 0
          ? `<div class="empty">这个范围内还没有任务。<br>派发任务时请填写回传聊天，否则结果无处可回。</div>`
          : `<div class="table-wrap"><table class="grid"><thead><tr>
              <th>任务</th><th>主题</th><th>传输</th><th>执行</th><th>业务</th><th>回传</th><th>创建</th>
            </tr></thead><tbody>
              ${tasks
                .map((task) => {
                  const topic = summary.topics.find((item) => item.id === task.topicId);
                  return `<tr>
                    <td><button class="row-button" type="button" data-open="${esc(task.id)}">${esc(task.title)}</button></td>
                    <td class="muted">${esc(topic ? topic.name : '—')}</td>
                    <td>${badge(TRANSPORT, task.status.transport.state)}</td>
                    <td>${badge(EXECUTION, task.status.execution.state)}</td>
                    <td>${badge(BUSINESS, task.status.business.state)}</td>
                    <td>${badge(CALLBACK, task.status.callback.state)}</td>
                    <td class="mono muted">${esc(timeLabel(task.createdAt))}</td>
                  </tr>`;
                })
                .join('')}
            </tbody></table></div>`
      }
    </div>`;
}

function renderTask() {
  if (state.detailError) {
    return `<div class="card"><div class="empty">读取任务失败：${esc(state.detailError.message)}</div></div>`;
  }
  if (!state.detail) return `<div class="card"><div class="empty">正在读取任务…</div></div>`;
  const { task, topic, stages, runs, callbacks, messages } = state.detail;
  const sortedCallbacks = [...callbacks].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

  return `
    <div class="card">
      <div class="card-head">
        <h2>${esc(task.title)}</h2>
        <span class="hint mono">${esc(task.id)}</span>
        <span class="spacer"></span>
        ${
          task.cancelled
            ? `<span class="badge" data-tone="bad">已取消 · ${esc(task.cancelled.reason)}</span>`
            : `<button class="button-ghost button-danger" type="button" data-cancel="${esc(task.id)}">取消任务</button>`
        }
      </div>
      <div class="stack">
        ${layersOf(task.status)}
        <dl class="stage" style="border:0;padding:0;background:transparent">
          <div><dt>主题</dt><dd>${esc(topic ? topic.name : '—')} <span class="mono muted">${esc(topic ? topic.slug : '')}</span></dd></div>
          <div><dt>原聊天（回传目标）</dt><dd>${
            task.groupId
              ? `群聊 · 结果回到发起这次派发的会话 <span class="mono muted">${esc(task.groupId)}</span>`
              : `${esc(task.origin.app)} · ${esc(task.origin.device)} · <span class="mono">${esc(task.origin.chatId)}</span>`
          }</dd></div>
          <div><dt>已授权范围</dt><dd>${esc(task.authorization.scopes.join('、') || '未声明')}${task.authorization.allowChain ? ' · 允许自动继续' : ' · 不自动继续'}</dd></div>
          <div><dt>创建 / 更新</dt><dd class="mono">${esc(timeLabel(task.createdAt))} / ${esc(timeLabel(task.updatedAt))}</dd></div>
        </dl>
        <div><span class="hint-text">原始需求</span><pre class="detail-body">${esc(task.body)}</pre></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>阶段</h2><span class="hint">每个阶段独立会话与模型配置</span></div>
      <div class="stage-list">
        ${stages
          .map((stage) => {
            const stageRuns = runs.filter((run) => run.stageId === stage.id);
            const run = stageRuns[stageRuns.length - 1];
            return `<article class="stage">
              <header>
                <span class="index">${String(stage.index + 1).padStart(2, '0')}</span>
                <strong>${esc(stage.label)}</strong>
                ${badge(EXECUTION, stage.status.execution.state)}
                ${badge(CALLBACK, stage.status.callback.state)}
                <span class="spacer"></span>
                <span class="hint mono">${esc(stage.client)}</span>
              </header>
              <dl>
                <div><dt>目标项目</dt><dd>${esc(stage.project.path || '—')}<br><span class="mono muted">${esc(stage.project.id)}</span></dd></div>
                <div><dt>请求模型</dt><dd>${esc(stage.model.account)} / ${esc(stage.model.modelId)} / ${esc(stage.model.reasoning)}</dd></div>
                <div><dt>实际模型</dt><dd>${run && run.actual.modelId ? `${esc(run.actual.account || '')} / ${esc(run.actual.modelId)} / ${esc(run.actual.reasoning || '')}` : '<span class="muted">未回报</span>'}</dd></div>
                <div><dt>会话</dt><dd>${run && run.actual.sessionId ? `<span class="mono">${esc(run.actual.sessionId)}</span>` : '<span class="muted">未创建 / 未知</span>'}</dd></div>
                <div><dt>原生轮次</dt><dd>${run && run.actual.nativeTurnId ? `<span class="mono">${esc(run.actual.nativeTurnId)}</span>` : '<span class="muted">未回报</span>'}</dd></div>
                <div><dt>完成条件</dt><dd>${esc(stage.completion.condition)}${stage.completion.requiresEvidence ? ' · 需要证据' : ''}</dd></div>
                <div><dt>回传聊天</dt><dd>${task.groupId ? '群聊' : esc(stage.callback.app)} · <span class="mono">${esc(stage.callback.chatId)}</span></dd></div>
                <div><dt>尝试次数</dt><dd>${stageRuns.length || 0}</dd></div>
              </dl>
              ${
                run && run.queuedReason
                  ? `<p class="hint-text">${icon('triangle-alert')} ${esc(run.queuedReason)}</p>`
                  : ''
              }
              ${run && run.lastError ? `<p class="hint-text">最近错误：${esc(run.lastError)}</p>` : ''}
              <div class="inline-actions">
                <button class="button-ghost" type="button" data-rebind="${esc(task.id)}|${esc(stage.id)}">重新绑定回传聊天</button>
              </div>
            </article>`;
          })
          .join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>回传</h2><span class="hint">收到回传 ≠ 原聊天已处理</span></div>
      ${
        sortedCallbacks.length === 0
          ? '<div class="empty">还没有回传。接收方完成后通过 Relay 回传才会出现在这里。</div>'
          : `<div class="table-wrap"><table class="grid"><thead><tr>
              <th>时间</th><th>结论</th><th>摘要</th><th>投递状态</th><th>原因</th><th>后续阶段</th><th></th>
            </tr></thead><tbody>
              ${sortedCallbacks
                .map(
                  (callback) => `<tr>
                    <td class="mono muted">${esc(timeLabel(callback.receivedAt))}</td>
                    <td>${badge(OUTCOME, callback.outcome)} <span class="muted">${esc(callback.outcome)}</span></td>
                    <td>${esc(callback.summary)}${callback.duplicate ? ' <span class="badge">重复</span>' : ''}</td>
                    <td>${badge(CALLBACK, callback.delivery.state)}</td>
                    <td class="muted">${esc(callback.delivery.reason || '—')}</td>
                    <td class="mono muted">${esc(callback.delivery.triggeredStageId || '—')}</td>
                    <td class="inline-actions"><button class="button-ghost" type="button" data-retry="${esc(callback.id)}">重新投递</button></td>
                  </tr>`
                )
                .join('')}
            </tbody></table></div>`
      }
    </div>

    <div class="card">
      <div class="card-head"><h2>时间线</h2><span class="hint">每条都有来源与时间</span></div>
      <ul class="timeline">
        ${messages
          .map(
            (message) => `<li data-tone="${MESSAGE_TONE[message.kind] || 'idle'}">
              <strong>${esc(message.summary)}</strong><time>${esc(timeLabel(message.createdAt))}</time>
              <p class="mono">${esc(message.kind)} · ${esc(message.route)} · ${esc(message.id)}</p>
            </li>`
          )
          .join('')}
      </ul>
    </div>`;
}

function clientBadge(value) {
  return badge(CAPABILITY, value);
}

function renderClients() {
  const clients = state.summary.clients || [];
  const instructions = {
    zcode: '打开 ZCode 并进入需要协作的项目。在设置中选择桌面连接或 MCP 连接；使用 MCP 时先填写服务配置。',
    workbuddy: '打开 WorkBuddy 并进入项目，保持客户端运行，然后检查连接。',
    factory: '打开 Factory 并进入项目，保持客户端运行，然后检查连接。',
    codex: '打开 ChatGPT / Codex。此处只显示已验证的能力；接口尚未验证时，先检查连接并查看诊断。',
  };
  const capabilities = [
    ['canCreateVisibleSession', '创建可见会话'], ['canBindProject', '读取项目'],
    ['canSpecifyAccountModelReasoning', '选择账户、模型与思考强度'],
    ['submitReturns', '提交后立即返回'], ['turnEndEvent', '接收结束事件'],
    ['businessCallback', '接收业务结果'], ['busyQueueing', '繁忙时排队'],
  ];
  return `<section class="card client-intro">
    <div class="card-head"><h2>连接你的 AI 客户端</h2></div>
    <p>先打开客户端，再检查连接。连接通过后，去群聊选择 Agent、模型和项目，即可派发任务。</p>
    <ol class="client-steps"><li><b>1 · 打开客户端</b><span>登录并进入要使用的项目</span></li>
      <li><b>2 · 检查连接</b><span>在下面选择客户端进行检查</span></li>
      <li><b>3 · 开始协作</b><span>去群聊 @ Agent，或在任务工作台派发</span></li></ol>
    <p class="hint-text">连接检查只验证接口是否可用。任务执行、结果回传和回到原聊天的能力，需要实际任务分别验证。</p>
  </section><div class="client-cards">${clients.map((client) => {
    const ready = client.interfaceReady === 'supported';
    const label = ready ? '接口可用' : client.interfaceReady === 'unsupported' ? '接口不可用' : '等待检查';
    return `<section class="card client-card" data-client="${esc(client.client)}">
      <div class="card-head"><h2>${esc(client.label)}</h2><span class="badge ${ready ? 'ok' : 'idle'}">${label}</span></div>
      <p>${esc(instructions[client.client] || '打开客户端并进入项目，然后检查连接。')}</p>
      <p class="hint-text">版本：${esc(client.version || '尚未读取')} · 最近任务成功：${esc(timeLabel(client.lastSuccessAt))}</p>
      ${client.lastError ? `<div class="client-error" role="status"><b>需要处理</b><p>${esc(client.lastError)}</p><span>确认客户端已启动；检查下方诊断与连接设置后重试。</span></div>` : ''}
      <div class="client-actions"><button class="button" type="button" data-probe="${esc(client.client)}">检查连接</button>
        ${ready ? '<a class="button" href="./chat.html">去群聊派活</a><button class="button-ghost" type="button" data-action="dispatch">派发任务</button>' : ''}
        <a href="./tasks.html#settings" class="link-button">连接设置</a></div>
      <details class="client-diagnostics"><summary>能力与连接诊断</summary>
        <dl>${capabilities.map(([key, name]) => `<div><dt>${name}</dt><dd>${clientBadge(client[key])}</dd></div>`).join('')}
          <div><dt>回到原聊天</dt><dd>${clientBadge(client.chatInjection.state)}</dd></div></dl>
        <p class="hint-text">${esc(client.chatInjection.reason)}</p>
        ${(client.notes || []).map((note) => `<p class="hint-text">${esc(note)}</p>`).join('')}
      </details></section>`;
  }).join('')}</div>`;
}

function renderSettings() {
  const summary = state.summary || { dataRoot: state.desktop?.effectiveDataRoot || '暂不可用', topics: [], tasks: [], warnings: ['任务引擎暂不可用，可修改设置后重新启动。'] };
  return `
    ${renderDesktopSettings()}
    <div class="card">
      <div class="card-head"><h2>数据与运行</h2></div>
      <dl class="stage" style="border:0;padding:0;background:transparent">
        <div><dt>任务数据目录</dt><dd class="mono">${esc(summary.dataRoot)}</dd></div>
        <div><dt>界面时区</dt><dd>Asia/Shanghai</dd></div>
        <div><dt>生成时间</dt><dd class="mono">${esc(timeLabel(summary.generatedAt))}</dd></div>
        <div><dt>主题 / 任务</dt><dd>${summary.topics.length} / ${summary.tasks.length}</dd></div>
      </dl>
      ${
        summary.warnings.length > 0
          ? `<p class="hint-text">${summary.warnings.map((warning) => esc(warning)).join('<br>')}</p>`
          : '<p class="hint-text">数据目录不在系统盘。</p>'
      }
    </div>
    <details class="card">
      <summary>开发者接口（高级）</summary>
      <div class="card-head"><h2>接口</h2><span class="hint">Agent 与界面使用同一套状态和幂等逻辑</span></div>
      <div class="table-wrap"><table class="grid"><thead><tr><th>用途</th><th>方法与路径</th></tr></thead><tbody>
        <tr><td>提交任务（立即返回回执）</td><td class="mono">POST /api/async/tasks</td></tr>
        <tr><td>读取任务与时间线</td><td class="mono">GET /api/async/tasks/:id</td></tr>
        <tr><td>接收方回传</td><td class="mono">POST /api/async/callbacks</td></tr>
        <tr><td>原生轮次状态</td><td class="mono">POST /api/async/runs/:id/state</td></tr>
        <tr><td>重新投递回传</td><td class="mono">POST /api/async/callbacks/:id/retry</td></tr>
        <tr><td>取消任务</td><td class="mono">POST /api/async/tasks/:id/cancel</td></tr>
        <tr><td>客户端能力与单次探测</td><td class="mono">GET /api/async/clients · POST /api/async/clients/:id/probe</td></tr>
      </tbody></table></div>
      <p class="hint-text">
        派发接口返回 202 即表示已受理并持久化；发送方据此结束本轮，不等待模型，也不轮询。
      </p>
    </details>`;
}

/**
 * Desktop settings, only when hosted by the shell.
 *
 * The browser page cannot change how the app starts or where it stores tasks;
 * pretending otherwise would be a setting that silently does nothing.
 */
function renderDesktopSettings() {
  if (!state.desktop) return '';
  const settings = { ...state.desktop.settings,
    loginAtStartup: state.desktop.loginAtStartup ?? state.desktop.settings?.loginAtStartup,
    ...state.settingsDraft };
  return `<div class="card">
    <div class="card-head">
      <h2>桌面应用设置</h2>
      <span class="hint">关闭窗口默认退出应用；缩小到托盘需要显式开启</span>
    </div>
    <form class="form-grid" id="desktop-settings">
      <div class="form-row">
        <label class="checkbox"><input type="checkbox" name="closeToTray"${settings.closeToTray ? ' checked' : ''} /> 关闭窗口时缩小到托盘</label>
        <label class="checkbox"><input type="checkbox" name="notifications"${settings.notifications ? ' checked' : ''} /> 桌面通知（完成、阻塞、回传需人工）</label>
        <label class="checkbox"><input type="checkbox" name="loginAtStartup"${settings.loginAtStartup ? ' checked' : ''} /> 开机自动启动</label>
      </div>
      <div class="field">
        <label for="f-data-root">任务数据目录</label>
        <input id="f-data-root" name="dataRoot" value="${esc(settings.dataRoot || '')}" placeholder="留空则自动选择非系统盘" />
        ${window.relayDesktop?.chooseDataDirectory ? '<button type="button" id="choose-data-directory">选择文件夹…</button>' : ''}
        <span class="hint-text">当前生效：<span class="mono">${esc(state.desktop.effectiveDataRoot || '未知')}</span> · 修改后下次启动生效</span>
      </div>
      <div class="field">
        <label for="f-zcode-transport">ZCode 连接方式</label>
        <select id="f-zcode-transport" name="zcodeTransport">
          <option value="desktop"${settings.zcodeTransport !== 'mcp' ? ' selected' : ''}>桌面连接</option>
          <option value="mcp"${settings.zcodeTransport === 'mcp' ? ' selected' : ''}>zcode-mcp（MCP）</option>
        </select>
        <label for="f-zcode-mcp">MCP 配置文件</label>
        <input id="f-zcode-mcp" name="zcodeMcpConfig" value="${esc(settings.zcodeMcpConfig || '')}" placeholder="D:/Programs/AgentRelay/zcode-mcp/relay-config.json" />
        <span class="hint-text">MCP 方式无需开启桌面调试端口；修改后重新启动应用生效。</span>
      </div>
      <div class="form-actions">
        <button class="button-primary" type="submit">保存设置</button>
        <button type="button" data-desktop-action="open-data-folder">打开数据文件夹</button>
        <button type="button" data-desktop-action="open-log-folder">打开日志文件夹</button>
        ${state.desktop.restartRequired ? '<button type="button" data-desktop-action="restart">重新启动以应用更改</button>' : ''}
        <span class="hint-text" id="settings-note">${state.settingsDraft ? '有未保存的更改' : state.desktop.packaged ? '' : '开发模式不会写入开机启动项'}</span>
      </div>
    </form>
    <div class="bridge-block">
      <div class="card-head" style="margin:12px 0 8px">
        <h3 style="margin:0;font-size:13px">内置派发桥接</h3>
        <span class="hint">随应用启动和停止，不需要另外开进程</span>
      </div>
      ${renderBuiltInBridge()}
      <div class="form-row" style="margin-top:10px">
        ${['zcode', 'workbuddy', 'factory']
          .map((client) => {
            const checked = (settings.connectors || []).includes(client);
            return `<label class="checkbox"><input type="checkbox" name="connector" value="${client}"${checked ? ' checked' : ''} /> ${esc(CLIENT_LABELS[client] || client)}</label>`;
          })
          .join('')}
      </div>
      <p class="hint-text">勾选后重启应用生效；未勾选的客户端，派活会停在「已排队」。</p>
    </div>
    <div class="bridge-block">
      <div class="card-head" style="margin:12px 0 8px">
        <h3 style="margin:0;font-size:13px">外部桥接</h3>
        <span class="hint">自己另起的桥接，可选</span>
      </div>
      ${renderBridges(settings.bridges || [])}
    </div>
  </div>`;
}

function renderBuiltInBridge() {
  const bridge = state.desktop.bridge;
  if (!bridge) {
    return '<p class="hint-text">内置桥接未运行（应用未启用连接器，或启动失败）。</p>';
  }
  const tone = bridge.running ? 'ok' : 'bad';
  return `<div class="bridge-row">
    <span class="badge" data-tone="${tone}">${bridge.running ? '运行中' : '未运行'}</span>
    <span class="mono">${esc(bridge.url || '—')}</span>
    <span class="muted">端口 ${esc(String(bridge.port ?? '—'))}</span>
  </div>`;
}

function renderBridges(bridges) {
  const rows = bridges.length
    ? bridges
        .map(
          (bridge, index) => `<div class="bridge-row">
            <strong>${esc(bridge.client)}</strong>
            <span class="mono">${esc(bridge.url)}</span>
            <button type="button" class="link-button" data-remove-bridge="${index}">移除</button>
          </div>`
        )
        .join('')
    : '<p class="hint-text">尚未注册桥接。群聊可以照常发言，但派活会停在「已排队」。</p>';
  return `${rows}
    <div class="form-row" style="margin-top:10px">
      <div class="field">
        <label for="bridge-client">客户端</label>
        <select id="bridge-client">
          ${CLIENTS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="min-width:280px">
        <label for="bridge-url">桥接地址</label>
        <input id="bridge-url" placeholder="http://127.0.0.1:7901" />
      </div>
      <div class="field">
        <label>&nbsp;</label>
        <button class="button-ghost" type="button" id="add-bridge">添加桥接</button>
      </div>
    </div>
    <p class="hint-text">只接受回环地址；添加后重启应用生效。桥接用法见 packages/dispatch-bridge/README.md。</p>`;
}

/* ---------------------------------------------------------------- dispatch */

function emptyStage(index, client = 'zcode') {
  return {
    kind: index === 0 ? 'develop' : 'review',
    client,
    projectPath: '',
    projectId: '',
    sessionPolicy: 'new',
    sessionId: '',
    permissionMode: '',
    account: 'BigModel',
    provider: 'zhipu',
    modelId: 'GLM-5.3-Flash',
    reasoning: 'max',
    condition: index === 0 ? '开发完成且测试通过' : '审查完成并给出结论',
    requiresEvidence: true,
    dependsOn: index === 0 ? '' : `#${index - 1}`,
  };
}

function draftOf() {
  if (state.draft) return state.draft;
  state.draft = {
    topicName: '20261104-MediaDock-需求开发2',
    title: '',
    body: '基于 Prompt 创建内容时，将 {主题} 替换为当前项目的主题部分。',
    originApp: 'codex',
    originDevice: 'desktop-01',
    originChatId: '',
    senderId: 'agent_original',
    allowChain: true,
    idempotencyKey: '',
    stages: [emptyStage(0)],
  };
  return state.draft;
}

function fieldError(field) {
  const issue = state.issues.find((item) => item.field === field);
  return issue ? `<span class="error">${esc(issue.message)}</span>` : '';
}

function invalid(field) {
  return state.issues.some((item) => item.field === field) ? ' data-invalid="true"' : '';
}

function renderDispatch() {
  const draft = draftOf();
  return `
    <div class="card">
      <div class="card-head">
        <h2>派发任务</h2>
        <span class="hint">提交后返回受理回执，不等待模型完成</span>
      </div>
      <form class="form-grid" id="dispatch-form" novalidate>
        <div class="form-row">
          <div class="field"${invalid('topic.name')}>
            <label for="f-topic">主题</label>
            <input id="f-topic" name="topicName" value="${esc(draft.topicName)}" placeholder="20261104-MediaDock-需求开发2" />
            ${fieldError('topic.name')}
          </div>
          <div class="field"${invalid('title')}>
            <label for="f-title">任务标题</label>
            <input id="f-title" name="title" value="${esc(draft.title)}" placeholder="实现内容主题替换" />
            ${fieldError('title')}
          </div>
        </div>
        <div class="field"${invalid('body')}>
          <label for="f-body">需求正文</label>
          <textarea id="f-body" name="body">${esc(draft.body)}</textarea>
          ${fieldError('body')}
        </div>

        <div class="form-row">
          <div class="field"${invalid('origin.app')}>
            <label for="f-origin-app">原聊天应用</label>
            <select id="f-origin-app" name="originApp">
              ${CLIENTS.map(([value, label]) => `<option value="${value}"${value === draft.originApp ? ' selected' : ''}>${label}</option>`).join('')}
            </select>
            ${fieldError('origin.app')}
          </div>
          <div class="field">
            <label for="f-origin-device">设备</label>
            <input id="f-origin-device" name="originDevice" value="${esc(draft.originDevice)}" />
          </div>
          <div class="field"${invalid('origin.chatId')}>
            <label for="f-origin-chat">原聊天 ID（回传目标）</label>
            <input id="f-origin-chat" name="originChatId" value="${esc(draft.originChatId)}" placeholder="chat_original_7" />
            ${fieldError('origin.chatId')}
          </div>
          <div class="field">
            <label for="f-sender">发送方身份</label>
            <input id="f-sender" name="senderId" value="${esc(draft.senderId)}" />
          </div>
        </div>

        <div id="stage-editor" class="stack">${draft.stages.map((stage, index) => stageFields(stage, index)).join('')}</div>

        <div class="form-actions">
          <button class="button-ghost" type="button" data-action="add-stage">添加审查阶段</button>
          <label class="checkbox">
            <input type="checkbox" name="allowChain"${draft.allowChain ? ' checked' : ''} />
            允许当前阶段完成后自动继续已授权阶段
          </label>
          <div class="field" style="min-width:260px">
            <label for="f-idem">幂等键（可选）</label>
            <input id="f-idem" name="idempotencyKey" value="${esc(draft.idempotencyKey)}" placeholder="chat_original_7:需求开发2:1" />
          </div>
        </div>

        <div class="form-actions">
          <button class="button-primary" type="submit" id="submit-task">提交任务</button>
          <span class="hint-text">回执区分“已排队”和“已送达目标会话”；两者都不代表任务完成。</span>
        </div>
      </form>
    </div>
    ${state.receipt ? renderReceipt(state.receipt) : ''}`;
}

function stageFields(stage, index) {
  const base = `stages[${index}]`;
  return `<article class="stage" data-stage="${index}">
    <header>
      <span class="index">${String(index + 1).padStart(2, '0')}</span>
      <strong>阶段 ${index + 1}</strong>
      <span class="spacer"></span>
      ${index > 0 ? `<button class="button-ghost" type="button" data-action="remove-stage" data-index="${index}">移除</button>` : ''}
    </header>
    <div class="form-row">
      <div class="field"${invalid(`${base}.kind`)}>
        <label>阶段类型</label>
        <select name="stageKind" data-index="${index}">
          ${STAGE_KINDS.map(([value, label]) => `<option value="${value}"${value === stage.kind ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        ${fieldError(`${base}.kind`)}
      </div>
      <div class="field"${invalid(`${base}.client`)}>
        <label>目标客户端</label>
        <select name="stageClient" data-index="${index}">
          ${CLIENTS.map(([value, label]) => `<option value="${value}"${value === stage.client ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        ${fieldError(`${base}.client`)}
      </div>
      <div class="field"${invalid(`${base}.project.path`)}>
        <label>目标项目目录</label>
        <input name="stagePath" data-index="${index}" value="${esc(stage.projectPath)}" placeholder="D:\\Work\\MediaDock" />
        ${fieldError(`${base}.project.path`)}
      </div>
      <div class="field"${invalid(`${base}.project.id`)}>
        <label>项目 ID</label>
        <input name="stageProjectId" data-index="${index}" value="${esc(stage.projectId)}" placeholder="proj_mediadock" />
        ${fieldError(`${base}.project.id`)}
      </div>
    </div>
    <div class="form-row">
      <div class="field">
        <label>新会话 / 接续</label>
        <select name="stageSession" data-index="${index}">
          <option value="new"${stage.sessionPolicy === 'new' ? ' selected' : ''}>新建桌面可见会话</option>
          <option value="continue"${stage.sessionPolicy === 'continue' ? ' selected' : ''}>接续已有会话</option>
        </select>
      </div>
      <div class="field"${invalid(`${base}.session.sessionId`)}>
        <label>接续会话 ID</label>
        <input name="stageSessionId" data-index="${index}" value="${esc(stage.sessionId)}" placeholder="仅接续时填写" />
        ${fieldError(`${base}.session.sessionId`)}
      </div>
      <div class="field"${invalid(`${base}.session.permissionMode`)}>
        <label>ZCode 访问权限</label>
        <select name="stagePermission" data-index="${index}"${stage.client !== 'zcode' ? ' disabled' : ''}>
          ${window.RELAY_PERMISSION_MODES.map(([value, label]) => `<option value="${value}"${value === (stage.permissionMode || '') ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <small>仅 ZCode MCP；下一次派活时应用。需人工确认的操作在无头 MCP 中会被拒绝。</small>
        ${fieldError(`${base}.session.permissionMode`)}
      </div>
      <div class="field"${invalid(`${base}.model.account`)}>
        <label>账户 / 提供商</label>
        <input name="stageAccount" data-index="${index}" value="${esc(stage.account)}" />
        ${fieldError(`${base}.model.account`)}
      </div>
      <div class="field"${invalid(`${base}.model.modelId`)}>
        <label>模型 ID</label>
        <input name="stageModel" data-index="${index}" value="${esc(stage.modelId)}" />
        ${fieldError(`${base}.model.modelId`)}
      </div>
      <div class="field"${invalid(`${base}.model.reasoning`)}>
        <label>思考强度</label>
        <input name="stageReasoning" data-index="${index}" value="${esc(stage.reasoning)}" />
        ${fieldError(`${base}.model.reasoning`)}
      </div>
    </div>
    <div class="form-row">
      <div class="field"${invalid(`${base}.completion.condition`)}>
        <label>完成条件</label>
        <input name="stageCondition" data-index="${index}" value="${esc(stage.condition)}" />
        ${fieldError(`${base}.completion.condition`)}
      </div>
      <div class="field">
        <label>证据要求</label>
        <label class="checkbox"><input type="checkbox" name="stageEvidence" data-index="${index}"${stage.requiresEvidence ? ' checked' : ''} /> 回传必须带产物或测试证据</label>
      </div>
    </div>
  </article>`;
}

function renderReceipt(receipt) {
  return `<div class="receipt" data-phase="${esc(receipt.phase)}">
    <div class="card-head" style="margin:0">
      <h2>${receipt.phase === 'delivered' ? '已送达目标会话' : receipt.phase === 'accepted' ? 'MCP 已受理 · 等待会话确认' : '已排队 · 仅本地保存'}</h2>
      <span class="hint">${esc(receipt.reason || '目标客户端已受理提示词')}</span>
    </div>
    <dl>
      <div><dt>任务</dt><dd>${esc(receipt.taskId)}</dd></div>
      <div><dt>阶段</dt><dd>${esc(receipt.stageId)}</dd></div>
      <div><dt>执行实例</dt><dd>${esc(receipt.runId)}</dd></div>
      <div><dt>主题</dt><dd>${esc(receipt.topicName)} · ${esc(receipt.topicSlug)}</dd></div>
      <div><dt>客户端</dt><dd>${esc(receipt.client)}</dd></div>
      <div><dt>实际会话</dt><dd>${esc(receipt.sessionId || '尚未创建')}</dd></div>
      <div><dt>实际模型</dt><dd>${esc(receipt.model.actual || '未回报')}</dd></div>
      <div><dt>受理时间</dt><dd>${esc(timeLabel(receipt.acceptedAt))}</dd></div>
    </dl>
    ${layersOf(receipt.status)}
    <div class="inline-actions">
      <button class="button-ghost" type="button" data-open="${esc(receipt.taskId)}">查看任务</button>
      <button class="button-ghost" type="button" data-action="dispatch">继续派发</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ wiring */

function readForm(form) {
  const draft = draftOf();
  const data = new FormData(form);
  draft.topicName = String(data.get('topicName') || '');
  draft.title = String(data.get('title') || '');
  draft.body = String(data.get('body') || '');
  draft.originApp = String(data.get('originApp') || 'codex');
  draft.originDevice = String(data.get('originDevice') || '');
  draft.originChatId = String(data.get('originChatId') || '');
  draft.senderId = String(data.get('senderId') || '');
  draft.allowChain = data.get('allowChain') === 'on';
  draft.idempotencyKey = String(data.get('idempotencyKey') || '');
  $$('[data-stage]', form).forEach((article) => {
    const index = Number(article.dataset.stage);
    const stage = draft.stages[index];
    if (!stage) return;
    const value = (name) => String(article.querySelector(`[name="${name}"]`)?.value || '');
    stage.kind = value('stageKind') || stage.kind;
    stage.client = value('stageClient') || stage.client;
    stage.projectPath = value('stagePath');
    stage.projectId = value('stageProjectId');
    stage.sessionPolicy = value('stageSession') === 'continue' ? 'continue' : 'new';
    stage.sessionId = value('stageSessionId');
    stage.permissionMode = stage.client === 'zcode' ? value('stagePermission') : '';
    stage.account = value('stageAccount');
    stage.modelId = value('stageModel');
    stage.reasoning = value('stageReasoning');
    stage.condition = value('stageCondition');
    stage.requiresEvidence = article.querySelector('[name="stageEvidence"]')?.checked === true;
  });
  return draft;
}

function payloadFromDraft(draft) {
  return {
    ...(draft.idempotencyKey.trim() ? { idempotencyKey: draft.idempotencyKey.trim() } : {}),
    topic: { name: draft.topicName },
    title: draft.title,
    body: draft.body,
    authorization: {
      scopes: draft.stages.map((stage) => stage.kind),
      allowChain: draft.allowChain,
    },
    origin: {
      app: draft.originApp,
      device: draft.originDevice,
      chatId: draft.originChatId,
      senderId: draft.senderId,
      workflowIds: [],
    },
    stages: draft.stages.map((stage, index) => ({
      kind: stage.kind,
      client: stage.client,
      project: { id: stage.projectId, path: stage.projectPath },
      session: { ...(
        stage.sessionPolicy === 'continue'
          ? { policy: 'continue', sessionId: stage.sessionId }
          : { policy: 'new', sessionId: null }),
        ...(stage.client === 'zcode' && stage.permissionMode ? { permissionMode: stage.permissionMode } : {}) },
      model: {
        account: stage.account,
        provider: stage.account,
        modelId: stage.modelId,
        reasoning: stage.reasoning,
      },
      completion: { condition: stage.condition, requiresEvidence: stage.requiresEvidence },
      ...(index > 0 ? { dependsOn: [`#${index - 1}`] } : {}),
      queueIfUnavailable: true,
    })),
  };
}

/** Patch desktop settings and re-render, with one toast for both outcomes. */
async function patchDesktop(patch, message) {
  try {
    const result = await window.relayDesktop.patchSettings(patch);
    state.desktop = result;
    toast(result.restartRequired ? `${message}（重启后生效）` : message);
    render();
  } catch (error) {
    toast(error.message || '保存设置失败', 'bad');
    render();
  }
}

async function submitTask(form) {
  const draft = readForm(form);
  state.issues = [];
  const button = $('#submit-task');
  button.disabled = true;
  button.textContent = '提交中…';
  try {
    const receipt = await api('/api/async/tasks', {
      method: 'POST',
      body: JSON.stringify(payloadFromDraft(draft)),
    });
    state.receipt = receipt;
    state.draft = null;
    toast(receipt.phase === 'delivered' ? '已送达目标会话' : receipt.phase === 'accepted' ? 'MCP 已受理，结果将自动回传' : '已排队，等待派发');
    await loadSummary();
    render();
  } catch (error) {
    state.issues = Array.isArray(error.issues) ? error.issues : [];
    toast(error.message, 'bad');
    render();
  } finally {
    const again = $('#submit-task');
    if (again) {
      again.disabled = false;
      again.textContent = '提交任务';
    }
  }
}

function wire(root) {
  const chooseDirectory = $('#choose-data-directory', root);
  if (chooseDirectory) chooseDirectory.onclick = async () => {
    try {
      const path = await window.relayDesktop.chooseDataDirectory();
      if (path) {
        const input = $('#f-data-root');
        input.value = path;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch { toast('无法打开目录选择器，请直接填写目录。', 'bad'); }
  };
  $$('[data-desktop-action]', root).forEach((button) => {
    button.onclick = () => void window.relayDesktop.run(button.dataset.desktopAction);
  });
  $$('[data-open]', root).forEach((button) => {
    button.onclick = async () => {
      const taskId = button.dataset.open;
      await loadDetail(taskId);
      setView('task', { taskId });
    };
  });

  $$('[data-action="dispatch"]', root).forEach((button) => {
    button.onclick = () => setView('dispatch');
  });

  $$('[data-action="add-stage"]', root).forEach((button) => {
    button.onclick = () => {
      const form = $('#dispatch-form');
      if (form) readForm(form);
      const draft = draftOf();
      draft.stages.push(emptyStage(draft.stages.length, draft.stages[0]?.client || 'zcode'));
      state.issues = [];
      render();
    };
  });

  $$('[data-action="remove-stage"]', root).forEach((button) => {
    button.onclick = () => {
      const form = $('#dispatch-form');
      if (form) readForm(form);
      const draft = draftOf();
      draft.stages.splice(Number(button.dataset.index), 1);
      state.issues = [];
      render();
    };
  });

  const settingsForm = $('#desktop-settings', root);
  if (settingsForm) {
    settingsForm.oninput = () => {
      const data = new FormData(settingsForm);
      state.settingsDraft = {
        closeToTray: data.get('closeToTray') === 'on', notifications: data.get('notifications') === 'on',
        loginAtStartup: data.get('loginAtStartup') === 'on', dataRoot: String(data.get('dataRoot') || ''),
        zcodeTransport: String(data.get('zcodeTransport') || 'desktop'), zcodeMcpConfig: String(data.get('zcodeMcpConfig') || ''),
      };
      $('#settings-note').textContent = '有未保存的更改';
    };
    settingsForm.onsubmit = async (event) => {
      event.preventDefault();
      if (state.savingSettings) return;
      const data = new FormData(settingsForm);
      state.savingSettings = true;
      const submit = settingsForm.querySelector('[type=submit]');
      submit.disabled = true;
      try {
        const result = await window.relayDesktop.patchSettings({
          closeToTray: data.get('closeToTray') === 'on',
          notifications: data.get('notifications') === 'on',
          loginAtStartup: data.get('loginAtStartup') === 'on',
          dataRoot: String(data.get('dataRoot') || ''),
          zcodeTransport: String(data.get('zcodeTransport') || 'desktop'),
          zcodeMcpConfig: String(data.get('zcodeMcpConfig') || ''),
        });
        state.desktop = result;
        state.settingsDraft = null;
        toast('设置已保存');
        if (result.restartRequired) toast('设置已保存，部分更改将在重新启动后生效');
        render();
      } catch (error) {
        toast(error.message || '保存设置失败', 'bad');
      } finally {
        state.savingSettings = false;
        const again = $('#desktop-settings [type=submit]');
        if (again) again.disabled = false;
      }
    };
  }

  $$('[data-remove-bridge]', root).forEach((button) => {
    button.onclick = async () => {
      const settings = (state.desktop?.settings?.bridges || []).slice();
      settings.splice(Number(button.dataset.removeBridge), 1);
      await patchDesktop({ bridges: settings }, '桥接已移除');
    };
  });
  $$('[name="connector"]', root).forEach((box) => {
    box.onchange = async () => {
      const connectors = $$('[name="connector"]', root)
        .filter((item) => item.checked)
        .map((item) => item.value);
      await patchDesktop({ connectors }, '连接器已更新');
    };
  });
  const addBridge = $('#add-bridge', root);
  if (addBridge) {
    addBridge.onclick = async () => {
      const client = $('#bridge-client').value;
      const url = String($('#bridge-url').value || '').trim();
      if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(url)) {
        toast('桥接地址必须是本机回环地址，例如 http://127.0.0.1:7901', 'bad');
        return;
      }
      const bridges = [...(state.desktop?.settings?.bridges || []), { client, url }];
      await patchDesktop({ bridges }, '桥接已添加，重启应用后生效');
    };
  }

  const form = $('#dispatch-form', root);
  if (form) {
    form.onsubmit = (event) => {
      event.preventDefault();
      void submitTask(form);
    };
  }

  $$('[data-retry]', root).forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        const receipt = await api(`/api/async/callbacks/${encodeURIComponent(button.dataset.retry)}/retry`, {
          method: 'POST',
          body: '{}',
        });
        toast(`回传投递状态：${CALLBACK[receipt.delivery.state]?.[0] || receipt.delivery.state}`);
      } catch (error) {
        toast(error.message, 'bad');
      } finally {
        button.disabled = false;
        await refresh();
      }
    };
  });

  $$('[data-cancel]', root).forEach((button) => {
    button.onclick = async () => {
      const answer = await window.relayAsk({
        title: '取消任务',
        description: '取消后晚到的回传只会记录状态，不会再改变任务的结论。',
        fields: [{ name: 'reason', label: '取消原因（可留空）', value: '用户取消' }],
        confirmLabel: '取消任务',
        cancelLabel: '返回',
      });
      if (!answer) return;
      const reason = answer.reason;
      try {
        await api(`/api/async/tasks/${encodeURIComponent(button.dataset.cancel)}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        toast('任务已取消，晚到的回传只会记录状态');
      } catch (error) {
        toast(error.message, 'bad');
      }
      await refresh();
    };
  });

  $$('[data-probe]', root).forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = '正在检查…';
      try {
        const client = await api(`/api/async/clients/${encodeURIComponent(button.dataset.probe)}/probe`, {
          method: 'POST',
          body: '{}',
        });
        toast(
          client.interfaceReady === 'supported'
            ? '探测通过'
            : `探测完成：接口${client.interfaceReady === 'unverified' ? '未验证' : '不可用'}`,
          client.interfaceReady === 'supported' ? 'ok' : 'bad'
        );
      } catch (error) {
        toast(error.message, 'bad');
      } finally {
        button.disabled = false;
        await refresh();
      }
    };
  });

  $$('[data-rebind]', root).forEach((button) => {
    button.onclick = async () => {
      const [taskId, stageId] = String(button.dataset.rebind).split('|');
      const answer = await window.relayAsk({
        title: '重新绑定回传聊天',
        description: '这一阶段的回传会投递到下面这个聊天 ID。',
        fields: [
          {
            name: 'chatId',
            label: '新的回传聊天 ID',
            value: state.detail?.task?.origin?.chatId || '',
            required: true,
          },
        ],
        confirmLabel: '重新绑定',
      });
      if (!answer || !answer.chatId) return;
      const chatId = answer.chatId;
      try {
        await api(
          `/api/async/tasks/${encodeURIComponent(taskId)}/stages/${encodeURIComponent(stageId)}/callback`,
          {
            method: 'POST',
            body: JSON.stringify({
              app: state.detail?.task?.origin?.app || 'codex',
              device: state.detail?.task?.origin?.device || 'desktop-01',
              chatId,
            }),
          }
        );
        toast('回传聊天已重新绑定，待投递回传可重新投递');
      } catch (error) {
        toast(error.message, 'bad');
      }
      await refresh();
    };
  });
}

/* ---------------------------------------------------------------- bootstrap */

function connectStream() {
  if (!window.EventSource) return;
  let stream = null;
  try {
    stream = new EventSource('/api/stream');
  } catch {
    return;
  }
  // Task events arrive on the same pipe as observation frames; a refresh here is
  // event-driven, never a timer.
  stream.addEventListener('async', () => {
    clearTimeout(connectStream.timer);
    connectStream.timer = setTimeout(() => void refresh(), 250);
  });
}

$$('[data-nav]').forEach((button) => {
  button.onclick = () => {
    state.topic = button.dataset.nav === 'overview' ? state.topic : null;
    setView(button.dataset.nav);
    history.replaceState(null, '', `#${button.dataset.nav}`);
  };
});

$('#refresh-button').onclick = () => void refresh();

async function loadDesktopSettings() {
  if (!window.relayDesktop || typeof window.relayDesktop.settings !== 'function') {
    state.desktop = null;
    return;
  }
  try {
    state.desktop = await window.relayDesktop.settings();
  } catch {
    state.desktop = null;
  }
}

/** `#task=<id>` from a notification, `#settings` from the tray or menu. */
async function applyHash() {
  const hash = String(window.location.hash || '').replace(/^#/, '');
  if (hash.startsWith('task=')) {
    const taskId = decodeURIComponent(hash.slice(5));
    await loadDetail(taskId);
    setView('task', { taskId });
    return true;
  }
  if (hash === 'settings') {
    setView('settings');
    return true;
  }
  if (['overview', 'dispatch', 'clients'].includes(hash)) { setView(hash); return true; }
  return false;
}

window.addEventListener('hashchange', () => void applyHash().catch((error) => toast(error.message, 'bad')));

void (async () => {
  window.relayMountDesktopMenu?.();
  await loadSummary();
  await loadDesktopSettings();
  const routed = await applyHash();
  if (!routed) setView('overview');
  connectStream();
})();
