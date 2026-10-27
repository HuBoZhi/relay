/**
 * Small pure helpers behind the tray menu.
 *
 * The tray is the only surface the user sees when the window is hidden, so the
 * facts shown there must be exactly the facts the room reports. Everything is a
 * plain object here — no Electron import — which keeps this file unit-testable.
 */

/**
 * Reduce `/api/bootstrap` into the four facts worth showing in a tray.
 *
 * Counts are only trusted while the source reports a healthy connection: after a
 * failed read the payload is empty, and showing "0 个频道" would claim the
 * workspace is empty instead of unreadable.
 */
export function summarize(bootstrap) {
  const connection = bootstrap?.connection ?? null;
  const connectionState = connection?.state ?? 'unknown';
  const readable = connectionState === 'live' || connectionState === 'paused';
  const count = (list) => (readable && Array.isArray(list) ? list.length : null);
  const today = bootstrap?.metrics?.messagesToday;
  return {
    channels: count(bootstrap?.channels),
    agents: count(bootstrap?.agents),
    messagesToday: readable && typeof today === 'number' ? today : null,
    connectionLabel: connection?.label ?? '状态未知',
    connectionState,
  };
}

/** `14:32:06` in the room's timezone, or `--:--:--` when the clock is unreadable. */
export function formatUpdatedAt(value, timeZone = 'Asia/Shanghai') {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return '--:--:--';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  } catch {
    return '--:--:--';
  }
}

function count(value, label) {
  return value === null || value === undefined ? `${label}未知` : `${value} 个${label}`;
}

/**
 * Build the tray menu template.
 *
 * Read-only rows are plain `enabled: false` items so the menu doubles as the
 * status panel; the three actions that matter (open, copy address, quit) stay at
 * the top and bottom edges where they are always reachable.
 */
export function buildTrayMenu({
  mode = '演示数据',
  url = '',
  status = null,
  error = null,
  updatedAt = Date.now(),
  timeZone = 'Asia/Shanghai',
  loginAtStartup = false,
  actions = {},
}) {
  const rows = [
    { label: `运行模式：${mode}`, enabled: false },
    { label: `监听地址：${url.replace(/^https?:\/\//, '') || '尚未启动'}`, enabled: false },
    error
      ? { label: `数据连接：${error}`, enabled: false }
      : { label: `数据连接：${status?.connectionLabel ?? '状态未知'}`, enabled: false },
    {
      label: `工作空间：${count(status?.channels, '频道')} · ${count(status?.agents, '智能体')}`,
      enabled: false,
    },
    {
      label: `今日消息：${status?.messagesToday === null || status?.messagesToday === undefined ? '未知' : `${status.messagesToday} 条`}`,
      enabled: false,
    },
    { label: `更新时间：${formatUpdatedAt(updatedAt, timeZone)}`, enabled: false },
  ];

  return [
    { label: '打开控制中心', click: actions.openWindow },
    { label: '复制访问地址', enabled: Boolean(url), click: actions.copyUrl },
    { label: '在浏览器中打开', enabled: Boolean(url), click: actions.openInBrowser },
    { type: 'separator' },
    ...rows,
    { type: 'separator' },
    { label: '刷新状态', click: actions.refresh },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: Boolean(loginAtStartup),
      click: actions.toggleLoginAtStartup,
    },
    { type: 'separator' },
    { label: '退出', click: actions.quit },
  ];
}

/** One-line tray tooltip: mode plus the healthiest fact available. */
export function trayTooltip({ mode, status, error }) {
  if (error) return `协作控制中心 · ${mode} · ${error}`;
  const channels = status?.channels;
  const suffix = channels === null || channels === undefined ? '状态未知' : `${channels} 个频道`;
  return `协作控制中心 · ${mode} · ${suffix}`;
}
