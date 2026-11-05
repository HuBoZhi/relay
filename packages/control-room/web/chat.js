// Group chat front end.
//
// The page is a conversation, so it never invents a status: every badge comes
// from the message the server stored. A request says how far its dispatch got; a
// result says where its reply landed. Neither says "the work is accepted".
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

const AGENTS = [
  { id: 'codex', label: 'Codex', app: 'codex' },
  { id: 'zcode', label: 'ZCode', app: 'zcode' },
  { id: 'workbuddy', label: 'WorkBuddy', app: 'workbuddy' },
  { id: 'factory', label: 'Factory', app: 'factory' },
];

const SEND_STATE = {
  sent: ['已发出', 'info'],
  queued: ['已排队', 'warn'],
  delivered: ['已送达目标会话', 'ok'],
  failed: ['派发失败', 'bad'],
  manual: ['需人工处理', 'bad'],
};

const OUTCOME = {
  completed: ['完成', 'ok'],
  failed: ['失败', 'bad'],
  blocked: ['阻塞', 'warn'],
};

const DELIVERY = {
  delivered: ['回传已进入原聊天', 'ok'],
  queued: ['回传已入队，待宿主处理', 'warn'],
  manual: ['原聊天未收到，需人工处理', 'bad'],
  failed: ['回传投递失败', 'bad'],
  sent: ['已发送', 'info'],
};

const state = {
  groups: [],
  view: null,
  activeId: null,
  me: null,
  draft: {
    body: '',
    target: 'zcode',
    model: 'GLM-5.3-Flash',
    account: 'BigModel',
    reasoning: 'max',
    path: '',
    projectId: '',
  },
  issues: [],
  engineError: null,
  loading: false,
  /** Configured projects per client, read from the client itself. */
  projects: { client: null, list: [], reason: null, loading: false },
};

/* ------------------------------------------------------------------ helpers */

function agentLabel(id) {
  return AGENTS.find((agent) => agent.id === id)?.label ?? id;
}

function badge(map, value) {
  const pair = map[value];
  if (!pair) return '';
  const [label, tone] = pair;
  return `<span class="badge" data-tone="${tone}">${esc(label)}</span>`;
}

function timeLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return sameDay
    ? time
    : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`;
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

/* ----------------------------------------------------------------- identity */

function loadMe() {
  const stored = (() => {
    try {
      return JSON.parse(localStorage.getItem('relay.chat.me') || 'null');
    } catch {
      return null;
    }
  })();
  state.me =
    stored && stored.agentId ? stored : { agentId: 'codex', chatId: 'chat_codex_main', device: 'desktop-01' };
  if (!state.me.chatId) state.me.chatId = 'chat_codex_main';
  if (!state.me.device) state.me.device = 'desktop-01';
}

function saveMe() {
  try {
    localStorage.setItem('relay.chat.me', JSON.stringify(state.me));
  } catch {
    /* a private window can refuse storage; the session still works */
  }
}

function senderPayload() {
  return {
    agentId: state.me.agentId,
    displayName: agentLabel(state.me.agentId),
    app: state.me.agentId,
    device: state.me.device,
    chatId: state.me.chatId,
  };
}

function renderMe() {
  const select = $('#me-select');
  select.innerHTML = AGENTS.map(
    (agent) =>
      `<option value="${agent.id}"${agent.id === state.me.agentId ? ' selected' : ''}>${agent.label}</option>`
  ).join('');
  $('#me-chat').textContent = state.me.chatId;
}

/* -------------------------------------------------------------------- lists */

async function loadGroups() {
  try {
    const data = await api('/api/groups');
    state.groups = data.groups || [];
    state.engineError = null;
  } catch (error) {
    state.groups = [];
    state.engineError = error;
  }
  renderChrome();
  renderConvList();
}

async function openGroup(groupId) {
  try {
    state.view = await api(`/api/groups/${encodeURIComponent(groupId)}`);
    state.activeId = groupId;
    state.issues = [];
  } catch (error) {
    state.view = null;
    toast(error.message, 'bad');
  }
  renderConvList();
  renderConversation();
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  try {
    await loadGroups();
    if (state.activeId) await openGroup(state.activeId);
  } finally {
    state.loading = false;
  }
}

/* ------------------------------------------------------------------ render */

function renderChrome() {
  const chip = $('#engine-chip');
  const text = $('#engine-chip-text');
  if (state.engineError) {
    const missing = state.engineError.status === 404;
    chip.dataset.state = 'off';
    text.textContent = missing ? '群聊未启用' : '无法读取群数据';
    return;
  }
  const pending = state.groups.reduce((sum, group) => sum + (group.openRequests || 0), 0);
  chip.dataset.state = pending > 0 ? 'warn' : 'ok';
  text.textContent = pending > 0 ? `运行中 · ${pending} 个请求在途` : `运行中 · ${state.groups.length} 个群`;
}

function renderConvList() {
  const list = $('#conv-list');
  $('#conv-count').textContent = String(state.groups.length);
  if (state.engineError) {
    list.innerHTML = `<p class="hint">${
      state.engineError.status === 404
        ? '当前服务以只读模式运行，未启用任务与群聊。'
        : esc(state.engineError.message)
    }</p>`;
    return;
  }
  if (state.groups.length === 0) {
    list.innerHTML = `<p class="hint">还没有群。点上面的「新建群」开始。</p>`;
    return;
  }
  list.innerHTML = state.groups
    .map((group) => {
      const active = group.id === state.activeId ? ' active' : '';
      const last = group.lastMessage;
      return `<button type="button" class="conv${active}" data-group="${esc(group.id)}">
        <strong>${esc(group.name)}</strong>
        <span>${last ? `${esc(last.sender)}：${esc(last.body).slice(0, 40)}` : '还没有消息'}</span>
        <span class="conv-meta">${group.memberCount} 人 · ${group.messageCount} 条${
          group.openRequests ? ` · ${group.openRequests} 在途` : ''
        }</span>
      </button>`;
    })
    .join('');
  $$('[data-group]', list).forEach((button) => {
    button.onclick = () => void openGroup(button.dataset.group);
  });
}

function memberChip(member) {
  const session = member.sessionId
    ? `<span class="session mono" title="${esc(member.sessionId)}">${esc(member.sessionId)}</span>`
    : `<span class="session">未登记会话</span>`;
  return `<span class="member" data-role="${esc(member.role)}"><b>${esc(member.displayName)}</b>${session}</span>`;
}

function renderMessage(message) {
  if (message.kind === 'system' || message.kind === 'join') {
    return `<div class="notice">${esc(message.body)}</div>`;
  }
  const mine = message.sender.agentId === state.me.agentId;
  const classes = [
    'msg',
    mine ? 'mine' : '',
    message.kind === 'request' ? 'request' : '',
    message.kind === 'result' ? 'result' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const outcome = message.outcome ? ` data-outcome="${esc(message.outcome)}"` : '';

  let head = '';
  if (message.kind === 'request') {
    const mention = message.mentions[0];
    const model =
      mention && mention.model ? `${mention.model.modelId} · ${mention.model.reasoning}` : '未指定模型';
    const project = mention && mention.project ? mention.project.path : '未指定项目';
    head = `<div class="meta">
      <span class="tag target">@${esc(mention ? mention.target : '')}</span>
      <span class="tag">${esc(model)}</span>
      <span class="tag project" title="${esc(project)}">${esc(project)}</span>
      ${badge(SEND_STATE, message.state)}
    </div>`;
  }
  if (message.kind === 'result') {
    head = `<div class="meta">
      ${badge(OUTCOME, message.outcome || 'completed')}
      ${badge(DELIVERY, message.state)}
      ${message.mentions.length ? `<span class="tag target">@${esc(message.mentions.map((m) => m.target).join(' @'))}</span>` : ''}
    </div>`;
  }

  const foot = [];
  if (message.taskId) {
    foot.push(
      `<a class="link-button" href="./tasks.html#task=${encodeURIComponent(message.taskId)}">任务详情</a>`
    );
  }
  if (message.kind === 'request' && message.taskId) {
    foot.push(
      `<button class="link-button" type="button" data-report="${esc(message.taskId)}">回报结果</button>`
    );
  }
  if (message.reason) foot.push(`<span>${esc(message.reason)}</span>`);
  foot.push(`<span class="mono">${esc(timeLabel(message.createdAt))}</span>`);

  return `<div class="${classes}"${outcome}>
    <div class="who"><b>${esc(message.sender.displayName)}</b>${
      mine ? '' : `<span class="mono">${esc(message.sender.agentId)}</span>`
    }</div>
    <div class="bubble">${head}${esc(message.body)}</div>
    <div class="msg-foot">${foot.join('')}</div>
  </div>`;
}

function renderComposer() {
  const draft = state.draft;
  // Projects belong to a client; showing ZCode's folders under WorkBuddy would be
  // a lie, so the list is only used while it matches the selected target.
  const projects = state.projects.client === draft.target
    ? state.projects
    : { list: [], reason: null };
  const issue = (field) => {
    const found = state.issues.find((item) => item.field === field);
    return found ? `<span class="error">${esc(found.message)}</span>` : '';
  };
  const invalid = (field) =>
    state.issues.some((item) => item.field === field) ? ' data-invalid="true"' : '';

  return `<div class="composer">
    <textarea id="body-input" placeholder="说点什么，或者 @ 一个 Agent 派活…">${esc(draft.body)}</textarea>
    <div class="composer-row">
      <div class="field">
        <label for="target-select">@ 谁</label>
        <select id="target-select">
          ${AGENTS.map((agent) => `<option value="${agent.id}"${agent.id === draft.target ? ' selected' : ''}>${agent.label}</option>`).join('')}
        </select>
      </div>
      <div class="field${invalid('mentions[0].model')}">
        <label for="model-input">模型</label>
        <input id="model-input" value="${esc(draft.model)}" placeholder="GLM-5.3-Flash" />
        ${issue('mentions[0].model')}
      </div>
      <div class="field">
        <label for="reasoning-select">思考强度</label>
        <select id="reasoning-select">
          ${['low', 'medium', 'high', 'max']
            .map(
              (level) =>
                `<option value="${level}"${level === draft.reasoning ? ' selected' : ''}>${level}</option>`
            )
            .join('')}
        </select>
      </div>
      <div class="field grow${invalid('mentions[0].project.path')}">
        <label for="path-select">项目目录</label>
        ${projects.list.length > 0
          ? `<select id="path-select">
              <option value="">选择项目…</option>
              ${projects.list
                .map(
                  (project) =>
                    `<option value="${esc(project.path)}" data-project-id="${esc(project.id)}"${project.path === draft.path ? ' selected' : ''}>${esc(project.name)} · ${esc(project.path)}</option>`
                )
                .join('')}
            </select>`
          : `<input id="path-input" value="${esc(draft.path)}" placeholder="D:\\Work\\MediaDock" />`}
        ${projects.list.length === 0 && projects.reason
          ? `<span class="hint">${esc(projects.reason)}；可直接填写目录</span>`
          : ''}
        ${issue('mentions[0].project.path')}
      </div>
      <div class="field id">
        <label for="project-id-static">项目 ID</label>
        <span class="static mono" id="project-id-static" title="${esc(draft.projectId)}">${esc(
          draft.projectId || '选择项目后自动带出'
        )}</span>
      </div>
    </div>
    <div class="composer-actions">
      <button class="button-primary" type="button" id="dispatch-button">@ 派活</button>
      <button class="button-ghost" type="button" id="send-button">发送消息</button>
      <span class="hint">派活需要模型、思考强度与项目；只发消息则不会派发，也不会创建会话。</span>
    </div>
  </div>`;
}

function renderConversation() {
  const root = $('#conversation');
  if (!state.view) {
    root.innerHTML = `<div class="conv-empty">
      <strong>${state.engineError ? '群聊当前不可用' : '还没有打开任何群'}</strong>
      <span>${state.engineError ? esc(state.engineError.message) : '新建一个群，或者从左侧选择一个会话。'}</span>
    </div>`;
    return;
  }
  const { group, members, messages, tasks } = state.view;
  const inFlight = tasks.filter(
    (task) =>
      !task.cancelled &&
      ['queued', 'accepted', 'running', 'awaiting-confirmation'].includes(task.status.execution.state)
  ).length;

  root.innerHTML = `
    <div class="conv-head">
      <div>
        <h1>${esc(group.name)}</h1>
        <div class="sub">群 ID <span class="mono">${esc(group.id)}</span> · ${members.length} 人${
          inFlight ? ` · ${inFlight} 个请求在途` : ''
        }</div>
      </div>
      <div class="members">${members.map(memberChip).join('')}</div>
    </div>
    <div class="messages" id="messages">
      ${messages.length ? messages.map(renderMessage).join('') : '<div class="notice">还没有消息，说第一句吧。</div>'}
    </div>
    ${renderComposer()}`;

  const messagesEl = $('#messages');
  messagesEl.scrollTop = messagesEl.scrollHeight;
  bindComposer();
  // One fetch per client: the guard keeps the re-render from asking again.
  if (state.projects.client !== state.draft.target) void loadProjects(state.draft.target);
  $$('[data-report]').forEach((button) => {
    button.onclick = () => void reportResult(button.dataset.report);
  });
  paintIcons(root);
}

/* ------------------------------------------------------------------ actions */

function readDraft() {
  const body = $('#body-input');
  if (!body) return;
  state.draft.body = body.value;
  state.draft.target = $('#target-select').value;
  state.draft.model = $('#model-input').value;
  state.draft.reasoning = $('#reasoning-select').value;
  const projectSelect = $('#path-select');
  const pathInput = $('#path-input');
  if (projectSelect) {
    state.draft.path = projectSelect.value;
    const option = projectSelect.selectedOptions && projectSelect.selectedOptions[0];
    state.draft.projectId = option?.dataset?.projectId ?? '';
  } else if (pathInput) {
    state.draft.path = pathInput.value;
  }
}

function mentionFor(work) {
  const base = { target: state.draft.target };
  if (!work) return base;
  return {
    ...base,
    client: state.draft.target,
    ...(state.draft.model.trim()
      ? {
          model: {
            account: state.draft.account,
            provider: state.draft.account,
            modelId: state.draft.model.trim(),
            reasoning: state.draft.reasoning,
          },
        }
      : {}),
    ...(state.draft.path.trim()
      ? { project: { id: state.draft.projectId.trim(), path: state.draft.path.trim() } }
      : {}),
  };
}

async function send(work) {
  if (!state.view) return;
  readDraft();
  const body = state.draft.body.trim();
  state.issues = [];
  if (!body) {
    state.issues = [{ field: 'body', message: '消息不能为空' }];
    renderConversation();
    return;
  }
  if (work) {
    const issues = [];
    if (!state.draft.model.trim()) issues.push({ field: 'mentions[0].model', message: '派活必须指定模型' });
    if (!state.draft.path.trim())
      issues.push({ field: 'mentions[0].project.path', message: '派活必须指定项目目录' });
    if (issues.length > 0) {
      state.issues = issues;
      renderConversation();
      return;
    }
  }
  const button = $(work ? '#dispatch-button' : '#send-button');
  if (button) button.disabled = true;
  try {
    await api(`/api/groups/${encodeURIComponent(state.view.group.id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ sender: senderPayload(), body, mentions: [mentionFor(work)] }),
    });
    state.draft.body = '';
    await loadGroups();
    await openGroup(state.activeId);
    toast(work ? '已发出派活请求' : '已发送');
  } catch (error) {
    state.issues = Array.isArray(error.issues) ? error.issues : [];
    toast(error.message, 'bad');
    renderConversation();
  } finally {
    const again = $(work ? '#dispatch-button' : '#send-button');
    if (again) again.disabled = false;
  }
}

async function reportResult(taskId) {
  if (!state.view) return;
  const summary = window.prompt('这次的结果是什么？', '已完成');
  if (summary === null) return;
  const choice = window.prompt('结论：completed / failed / blocked', 'completed');
  if (choice === null) return;
  const outcome = ['completed', 'failed', 'blocked'].includes(choice.trim()) ? choice.trim() : 'completed';
  try {
    const result = await api(`/api/groups/${encodeURIComponent(state.view.group.id)}/results`, {
      method: 'POST',
      body: JSON.stringify({ sender: senderPayload(), taskId, outcome, summary }),
    });
    const where = result.message.state === 'delivered' ? '已进入原聊天' : '原聊天未确认收到';
    toast(`结果已回报：${where}`, result.message.state === 'manual' ? 'bad' : 'ok');
    await loadGroups();
    await openGroup(state.activeId);
  } catch (error) {
    toast(error.message, 'bad');
  }
}

async function createGroup() {
  const name = window.prompt('群名称（同时是主题名称）', '20261104-MediaDock-需求开发2');
  if (!name || !name.trim()) return;
  try {
    const view = await api('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), creator: senderPayload() }),
    });
    await loadGroups();
    await openGroup(view.group.id);
    toast('群已创建');
  } catch (error) {
    toast(error.message, 'bad');
  }
}

/* -------------------------------------------------------------------- wiring */

async function loadProjects(client) {
  if (!client) return;
  state.projects = { client, list: [], reason: null, loading: true };
  try {
    const response = await fetch(`/api/async/projects?client=${encodeURIComponent(client)}`);
    const body = await response.json().catch(() => ({}));
    const list = Array.isArray(body.projects) ? body.projects : [];
    state.projects = {
      client,
      list,
      reason: list.length > 0 ? null : body.reason ?? '未能从客户端读取项目列表',
      loading: false,
    };
  } catch (error) {
    state.projects = { client, list: [], reason: error.message, loading: false };
  }
  renderConversation();
}

function bindComposer() {
  const body = $('#body-input');
  if (body) {
    body.oninput = () => {
      state.draft.body = body.value;
    };
    body.onkeydown = (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void send(false);
      }
    };
  }
  for (const [id, key] of [
    ['#target-select', 'target'],
    ['#model-input', 'model'],
    ['#reasoning-select', 'reasoning'],
  ]) {
    const element = $(id);
    if (element)
      element.onchange = () => {
        state.draft[key] = element.value;
      };
  }
  const target = $('#target-select');
  if (target) {
    target.onchange = () => {
      readDraft();
      // Folders belong to one client, so switching the target reloads the list.
      void loadProjects(state.draft.target);
    };
  }
  const projectSelect = $('#path-select');
  if (projectSelect) {
    projectSelect.onchange = () => {
      readDraft();
      // The id is read-only, so update it in place instead of re-rendering the
      // whole conversation (which would steal focus from the select).
      const box = $('#project-id-static');
      if (box) {
        box.textContent = state.draft.projectId || '选择项目后自动带出';
        box.title = state.draft.projectId;
      }
    };
  }
  const dispatch = $('#dispatch-button');
  if (dispatch) dispatch.onclick = () => void send(true);
  const plain = $('#send-button');
  if (plain) plain.onclick = () => void send(false);
}

function connectStream() {
  if (!window.EventSource) return;
  let stream = null;
  try {
    stream = new EventSource('/api/stream');
  } catch {
    return;
  }
  // Group events ride the same pipe as the observer frames; a refresh here is
  // event-driven, never a timer.
  stream.addEventListener('async', (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      payload = null;
    }
    const type = payload && payload.event ? payload.event.type : '';
    if (!String(type).startsWith('group.')) return;
    clearTimeout(connectStream.timer);
    connectStream.timer = setTimeout(() => void refresh(), 200);
  });
}

/**
 * In the packaged app there is no native menu bar, so the page renders the same
 * model the shell exposes. In a browser none of this runs.
 */
async function mountDesktopMenu() {
  const bridge = window.relayDesktop;
  if (!bridge || typeof bridge.menu !== 'function') return;
  document.body.classList.add('is-desktop');
  const button = $('#menu-button');
  const pop = $('#menu-pop');
  if (!button || !pop) return;
  button.hidden = false;
  let model = null;
  button.onclick = async () => {
    if (pop.hidden) {
      if (!model) {
        try {
          model = await bridge.menu();
        } catch {
          model = [];
        }
      }
      pop.innerHTML = (model || [])
        .map(
          (group) =>
            `<div class="group">${esc(group.label)}</div>${group.items
              .map((item) =>
                item.type === 'separator'
                  ? '<hr />'
                  : `<button type="button" data-menu="${esc(item.id)}">${esc(item.label)}</button>`
              )
              .join('')}`
        )
        .join('');
      pop.hidden = false;
      $$('[data-menu]', pop).forEach((item) => {
        item.onclick = () => {
          pop.hidden = true;
          void bridge.run(item.dataset.menu);
        };
      });
    } else {
      pop.hidden = true;
    }
  };
  document.addEventListener('click', (event) => {
    if (pop.hidden) return;
    if (pop.contains(event.target) || button.contains(event.target)) return;
    pop.hidden = true;
  });
}

$('#me-select').onchange = () => {
  state.me.agentId = $('#me-select').value;
  saveMe();
  renderMe();
  // The sender changed, so the bubbles that count as "mine" changed too.
  if (state.view) renderConversation();
};
$('#new-group-button').onclick = () => void createGroup();
$('#refresh-button').onclick = () => void refresh();

void (async () => {
  loadMe();
  renderMe();
  paintIcons();
  void mountDesktopMenu();
  await loadGroups();
  const hash = String(window.location.hash || '').replace(/^#/, '');
  const fromHash = hash.startsWith('group=') ? decodeURIComponent(hash.slice(6)) : null;
  const first = fromHash || (state.groups[0] && state.groups[0].id);
  if (first) await openGroup(first);
  else renderConversation();
  connectStream();
})();
