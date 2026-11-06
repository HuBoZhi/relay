/**
 * Electron shell around the control room (CommonJS on purpose).
 *
 * The same web interface as `relay-control-room`, plus what a desktop build owes
 * its user: a tray icon, a status panel without opening anything, one obvious way
 * to quit — and, since this build, ownership of the task engine.
 *
 * The engine (message intake, dispatch queue, callback routing) runs in this
 * process, on the same port as the page. That is deliberate: closing the window
 * must stop the subscription and the port, and nothing may keep delivering after
 * the user quit. There is no detached daemon to reap later.
 *
 * This file is CJS because Electron 33 cannot load `electron` from an ESM main
 * process. The helper modules stay ESM and are pulled in with dynamic `import()`.
 */

'use strict';

const { join, dirname, resolve } = require('node:path');
const { writeSync, mkdirSync, appendFileSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  screen,
} = require('electron');

// Keep the installed app's profile, logs, and child-process scratch alongside its
// explicitly selected local profile, including launches from Windows login.
const profileFlagIndex=process.argv.indexOf('--user-data-dir');
const profilePath = app.commandLine.getSwitchValue('user-data-dir') ||
  (profileFlagIndex>=0 ? process.argv[profileFlagIndex+1] : '');
if (profilePath) {
  const temporaryPath = join(profilePath, 'temp');
  mkdirSync(temporaryPath, { recursive: true });
  app.setPath('userData', profilePath);
  app.setPath('sessionData', profilePath);
  app.setPath('temp', temporaryPath);
  app.setAppLogsPath(join(profilePath, 'logs'));
  process.env.TEMP = temporaryPath;
  process.env.TMP = temporaryPath;
  process.env.TMPDIR = temporaryPath;
}

/**
 * Leave a trace when the shell dies.
 *
 * A packaged app has no terminal: an unhandled rejection used to end the process
 * with exit code 1 and no evidence. Both handlers log to the console and append to
 * `crash.log` in the user-data folder, and they do not take the app down.
 */
function recordFailure(scope, error) {
  const detail = error && error.stack ? error.stack : String(error);
  console.error(`[应用] ${scope}：${detail}`);
  try {
    const file = process.env.RELAY_CRASH_LOG || join(app.getPath('userData'), 'crash.log');
    appendFileSync(file, `[${new Date().toISOString()}] ${scope}: ${detail}\n`, 'utf8');
  } catch {
    // Logging must never be the reason the app fails.
  }
}

process.on('unhandledRejection', (reason) => recordFailure('未处理的异步错误', reason));
process.on('uncaughtException', (error) => recordFailure('未捕获的异常', error));

const APP_ROOT = __dirname;
const ICON = join(APP_ROOT, 'assets', 'icon.png');
const TRAY_ICON = join(APP_ROOT, 'assets', 'tray.png');
const STATUS_INTERVAL_MS = 10_000;
/** Height of the in-page menu bar; the OS caption buttons are drawn over it. */
const TOPBAR_HEIGHT = 61;

// Filled by `start()` before any window or tray exists.
let config = null;
let buildTrayMenu = null;
let loginItemCommand = null;
let trayTooltip = null;
let startRoom = null;
let probe = null;
let probeTasks = null;
let loadServerModule = null;
let startManagedBridge = null;
let appMenuModel = [];
let MENU_ACTIONS = new Set();
let settingsApi = null;
let windowStateApi = null;

let room = null;
let engine = null;
let managedBridge = null;
let clientBootstrap = null;
let unsubscribeEngine = null;
let settings = null;
let settingsFile = null;
let activeSettings = null;
let needsRestart = false;
let settingsUpdates = Promise.resolve();
let win = null;
let tray = null;
let status = null;
let statusError = null;
let taskCounts = null;
let probedAt = null;
let quitting = false;
let shutdownPending = null;
let shutdownComplete = false;
let pendingShow = false;
let restoreMaximized = false;
const lifecycleAbort = new AbortController();
let hideNoticed = false;
let statusTimer = null;
let smokeShotDone = false;
let lastMenu = null;
let lastTooltip = '';

/**
 * Write a line to stdout without buffering.
 *
 * Console output is asynchronous on a pipe, and a smoke run ends with
 * `app.exit()`, which would drop buffered lines — the very diagnostics the run
 * exists to produce.
 */
function say(line) {
  try {
    writeSync(1, `${line}\n`);
  } catch {
    console.log(line);
  }
}

async function loadHelpers() {
  const [configModule, roomModule, trayModule, menuModule, settingsModule, bridgeModule] = await Promise.all([
    import('./lib/config.mjs'),
    import('./lib/room-service.mjs'),
    import('./lib/tray-menu.mjs'),
    import('./lib/app-menu.mjs'),
    import('./lib/settings.mjs'),
    import('./lib/bridge-process.mjs'),
  ]);
  startManagedBridge = bridgeModule.startManagedBridge;
  MENU_ACTIONS = new Set(menuModule.MENU_ACTIONS);
  appMenuModel = menuModule.buildAppMenu({ isPackaged: app.isPackaged });
  buildTrayMenu = trayModule.buildTrayMenu;
  loginItemCommand = configModule.loginItemCommand;
  trayTooltip = trayModule.trayTooltip;
  startRoom = roomModule.startRoom;
  probe = roomModule.probe;
  probeTasks = roomModule.probeTasks;
  loadServerModule = roomModule.loadServerModule;
  settingsApi = settingsModule;
  windowStateApi = await import('./lib/window-state.mjs');
  return configModule;
}

function showWindow() {
  recordLaunch('show-request');
  if (quitting) return;
  if (!room) { pendingShow = true; return; }
  if (!win || win.isDestroyed()) {
    void createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (restoreMaximized) { win.maximize(); restoreMaximized = false; }
  win.show();
  win.focus();
  recordLaunch('shown');
}

function recordLaunch(event, detail = {}) {
  try {
    appendFileSync(join(app.getPath('userData'), 'launch.log'), JSON.stringify({ at: new Date().toISOString(),
      event, pid: process.pid, room: Boolean(room), window: Boolean(win), quitting,
      visible: win && !win.isDestroyed() ? win.isVisible() : false, ...detail }) + '\n');
  } catch {}
}

/** Load one of the app's own pages; anything else never reaches the window. */
async function navigate(path) {
  if (!room) return;
  showWindow();
  const contents = webContents();
  if (!contents) return;
  const target = `${room.url}${path}`;
  try {
    await contents.loadURL(target);
  } catch {
    // A fast double-click can cancel the first navigation; the second still lands.
  }
}

async function createWindow() {
  if (win && !win.isDestroyed()) {
    showWindow();
    return;
  }
  const windowStateFile = join(app.getPath('userData'), 'window-state.json');
  const restored = windowStateApi.loadWindowState(windowStateFile, screen.getAllDisplays().map((display) => display.workArea));
  restoreMaximized = restored.maximized;
  win = new BrowserWindow({
    ...restored.bounds,
    minWidth: Math.min(900, restored.bounds.width),
    minHeight: Math.min(600, restored.bounds.height),
    backgroundColor: '#0b1015',
    title: 'Relay系统',
    icon: ICON,
    show: false,
    // A light native title bar plus its grey menu strip looked bolted onto a
    // graphite console. Hide the frame, keep the OS caption buttons, and draw
    // both the title and the menu inside the page.
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#0b1015', symbolColor: '#c6d3dc', height: TOPBAR_HEIGHT },
        }
      : {}),
    webPreferences: {
      preload: join(APP_ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // The window only ever shows the local room; anything else goes to the OS
  // browser so the shell cannot be turned into a generic web client.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (room && url.startsWith(room.url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  win.once('ready-to-show', () => {
    // Reapply after native creation: Windows may adjust the non-client frame
    // while moving a new window onto a monitor with a different DPI.
    win.setBounds(restored.bounds);
    if (restored.maximized && (config.showWindow || pendingShow)) { win.maximize(); restoreMaximized = false; }
    if (config.showWindow || config.smoke || pendingShow) win.show();
  });

  win.on('close', (event) => {
    try { windowStateApi.saveWindowState(windowStateFile, win); }
    catch (error) { recordFailure('窗口状态保存失败', error); }
    if (quitting) return;
    // Product default: closing the window quits the app, engine included. Tray
    // mode is an explicit opt-in setting, never a surprise.
    if (!settings?.closeToTray || !tray) return;
    event.preventDefault();
    win.hide();
    if (!hideNoticed) {
      hideNoticed = true;
      tray.displayBalloon({
        title: '已缩小到托盘',
        content: '窗口已收进托盘，任务派发与回传仍在继续；双击托盘图标可重新打开。',
      });
    }
  });

  // The app opens on the group chat: a topic you can talk in is the point of the
  // product, and the observer is one click away from the menu.
  win.webContents.setZoomLevel(restored.zoomLevel);
  await win.loadURL(`${room.url}/chat.html`);

  if (config.smoke) {
    // A smoke run must always end: `--capture` in a degraded live session has been
    // seen to stall inside capturePage, and a hung process is worse than no shot.
    const watchdog = setTimeout(() => {
      say('[冒烟] 截图未完成，已强制退出');
      app.exit(0);
    }, 20_000);
    await captureSmokeShot();
    clearTimeout(watchdog);
  }
}

async function captureSmokeShot() {
  if (smokeShotDone) return;
  smokeShotDone = true;
  const target = config.screenshotPath;
  await new Promise((settle) => setTimeout(settle, 1500));
  if (target) {
    // capturePage can stall on an occluded window; the smoke run must always end.
    const image = await Promise.race([
      win.webContents.capturePage(),
      new Promise((settle) => setTimeout(() => settle(null), 6000)),
    ]);
    if (image) {
      await writeFile(target, image.toPNG());
      say(`[冒烟] 界面已加载：${room.url} · 截图已保存`);
    } else {
      say(`[冒烟] 界面已加载：${room.url} · 截图超时，已跳过`);
    }
  } else {
    say(`[冒烟] 界面已加载：${room.url}`);
  }
}

function loginItemEnabled() {
  try {
    return app.getLoginItemSettings(loginItemOptions()).openAtLogin === true;
  } catch {
    return false;
  }
}

function loginItemOptions() {
  return { name: 'RelaySystem', ...loginItemCommand(config, {
    executable:process.execPath,userDataPath:app.getPath('userData'),
    runtimeRoot:config.workspaceStateFile ? dirname(dirname(config.workspaceStateFile)) : '',
    consoleDir:dirname(process.execPath),
  }), openAsHidden:true };
}

function updateTray() {
  if (!tray) return;
  const menu = buildTrayMenu({
    mode: room && room.mode === '只读观察' ? `只读观察 · ${room.target || '目标未知'}` : '演示数据',
    url: room ? room.url : '',
    status,
    error: statusError,
    updatedAt: probedAt || Date.now(),
    timeZone: config.timezone,
    loginAtStartup: loginItemEnabled(),
    tasks: taskCounts,
    actions: {
      openWindow: showWindow,
      openChat: () => void navigate('/chat.html'),
      openTasks: () => void navigate('/tasks.html'),
      openSettings: () => void navigate('/tasks.html#settings'),
      copyUrl: () => {
        if (room) clipboard.writeText(room.url);
      },
      refresh: () => void refreshStatus(),
      hideToTray: () => {
        if (win && !win.isDestroyed()) win.hide();
      },
      toggleLoginAtStartup: () => {
        void toggleLoginAtStartup();
      },
      quit: () => {
        quitting = true;
        app.quit();
      },
    },
  });
  lastMenu = menu;
  tray.setContextMenu(Menu.buildFromTemplate(menu));
  lastTooltip = trayTooltip({
    mode: room ? room.mode : '演示数据',
    status,
    error: statusError,
    tasks: taskCounts,
  });
  tray.setToolTip(lastTooltip);
}

async function toggleLoginAtStartup() {
  if (!app.isPackaged) {
    // Writing a login item from an unpackaged dev run would register the bare
    // Electron binary, which cannot start the app. Say so instead of pretending.
    void dialog.showMessageBox({
      type: 'info',
      title: '开机启动',
      message: '开发模式不写入开机启动项',
      detail: '安装版本可以在设置中开启；开发运行注册的会是 Electron 自身，无法启动本应用。',
      buttons: ['知道了'],
      noLink: true,
    });
    return;
  }
  const next = !loginItemEnabled();
  if (next && config.token && !config.workspaceStateFile) {
    // The login item replays this app's command line, so the workspace state
    // file is what carries the account into the next session. Credentials are
    // never written into the startup entry itself.
    void dialog.showMessageBox({
      type: 'info',
      title: '无法设置开机启动',
      message: '请用 --workspace-state 指定本机工作区状态文件后重试',
      detail: '凭据不会写入启动项；没有状态文件时，开机启动无法恢复上次的工作区。',
      buttons: ['知道了'],
      noLink: true,
    });
    return;
  }
  try { await updateSettings({ loginAtStartup: next }); }
  catch (error) {
    void dialog.showMessageBox({ type: 'error', title: '设置未保存', message: error.message, buttons: ['知道了'] });
  }
}

async function refreshStatus() {
  const result = await probe(room ? room.url : '');
  status = result.ok ? result.status : null;
  statusError = result.ok ? null : result.error;
  probedAt = result.ok ? result.at : Date.now();
  taskCounts = room ? await probeTasks(room.url) : null;
  updateTray();
}

/**
 * Turn an engine event into a desktop notification.
 *
 * Only three things deserve a bubble: a stage result, a result the origin chat
 * did not receive, and a cancellation. Everything else (dispatch, queueing) is
 * visible in the workspace and would train the user to ignore notifications.
 */
function notifyFromEvent(event) {
  if (!settings?.notifications) return;
  if (!Notification.isSupported()) return;
  const titles = { completed: '阶段完成', failed: '阶段失败', blocked: '阶段阻塞' };
  let title = null;
  if (event.type === 'group.result' && event.outcome) {
    // The result shows up in the group first; the notification only says so.
    title = titles[event.outcome] ?? '收到结果';
  } else if (event.type === 'callback.received' && event.outcome) {
    title = titles[event.outcome] ?? '收到回传';
  } else if (event.type === 'callback.received' && event.message === '重复回传已忽略') {
    return;
  } else if (event.type === 'callback.delivered' && event.delivery === 'manual') {
    title = '回传需要人工处理';
  }
  if (!title) return;
  const note = new Notification({
    title,
    body: String(event.message || '').slice(0, 180),
    icon: ICON,
  });
  note.on('click', () => {
    // Land on the task, not on the graph: a notification that opens the overview
    // has told the user nothing they can act on.
    if (event.groupId) {
      void navigate(`/chat.html#group=${encodeURIComponent(event.groupId)}`);
      return;
    }
    void navigate(event.taskId ? `/tasks.html#task=${encodeURIComponent(event.taskId)}` : '/tasks.html');
  });
  note.show();
}

function showStatusHelp() {
  void dialog.showMessageBox({
    type: 'info',
    title: '状态说明',
    message: '托盘里显示的是什么',
    detail: [
      '运行模式：演示数据表示没有配置只读令牌；只读观察表示正在读取真实工作空间。',
      '数据连接：取自控制中心自己的连接状态，与界面右上角一致。',
      '任务：在途阶段、等待确认与需要人工处理的回传数量，来自本机任务引擎。',
      '只读观察不会发送消息；任务派发通过本机任务引擎，两者共用一个本地端口。',
    ].join('\n'),
    buttons: ['知道了'],
    noLink: true,
  });
}

function showAbout() {
  void dialog.showMessageBox({
    type: 'info',
    title: '关于 Relay系统',
    message: 'Relay系统',
    detail:
      `版本 ${app.getVersion()}\n` +
      `任务数据：${engine ? engine.dataRoot : '未启用'}\n` +
      '观察工作空间中的频道与消息，并派发异步任务、接收回传。\n' +
      '凭据只保存在本进程内，不会发送到浏览器。',
    buttons: ['知道了'],
    noLink: true,
  });
}

function webContents() {
  return win && !win.isDestroyed() ? win.webContents : null;
}

function zoomBy(delta) {
  const contents = webContents();
  if (!contents) return;
  const next = Math.min(5, Math.max(-3, contents.getZoomLevel() + delta));
  contents.setZoomLevel(next);
}

/** The menu lives in the page, so the shell only exposes named actions. */
const MENU_HANDLERS = {
  'open-data-folder': () => void shell.openPath(engine?.dataRoot || app.getPath('userData')),
  'open-log-folder': () => void shell.openPath(app.getPath('logs')),
  'open-chat': () => void navigate('/chat.html'),
  'open-tasks': () => void navigate('/tasks.html'),
  'open-observer': () => void navigate('/'),
  'open-settings': () => void navigate('/tasks.html#settings'),
  'copy-url': () => {
    if (room) clipboard.writeText(room.url);
  },
  quit: () => {
    quitting = true;
    app.quit();
  },
  reload: () => {
    const contents = webContents();
    if (contents) contents.reload();
  },
  restart: () => {
    app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== '--no-window') });
    quitting = true;
    app.quit();
  },
  'zoom-reset': () => {
    const contents = webContents();
    if (contents) contents.setZoomLevel(0);
  },
  'zoom-in': () => zoomBy(0.5),
  'zoom-out': () => zoomBy(-0.5),
  fullscreen: () => {
    if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
  },
  'hide-to-tray': () => {
    if (win && !win.isDestroyed()) win.hide();
  },
  minimize: () => {
    if (win && !win.isDestroyed()) win.minimize();
  },
  'close-window': () => {
    if (win && !win.isDestroyed()) win.close();
  },
  'status-help': showStatusHelp,
  about: showAbout,
  devtools: () => {
    const contents = webContents();
    if (contents && !app.isPackaged) contents.toggleDevTools();
  },
};

function runMenuAction(id) {
  if (!MENU_ACTIONS.has(id)) return false;
  const handler = MENU_HANDLERS[id];
  if (!handler) return false;
  handler();
  return true;
}

function settingsView() {
  return {
    settings: settings ? { ...settings } : null,
    effectiveDataRoot: engine ? engine.dataRoot : null,
    warnings: engine ? engine.warnings : [],
    version: app.getVersion(),
    packaged: app.isPackaged,
    loginAtStartup: loginItemEnabled(),
    restartRequired: needsRestart,
    bridge: managedBridge
      ? { running: Boolean(managedBridge.url), url: managedBridge.url, port: managedBridge.port, managed: true }
      : null,
  };
}

function updateSettings(patch) {
  const pending = settingsUpdates.catch(() => {}).then(async () => {
    const { applySettingsPatch, settingsNeedRestart } = await import('./lib/settings-transaction.mjs');
    if (patch.loginAtStartup === true && config.token && !config.workspaceStateFile) {
      throw new Error('当前工作区没有可供登录启动读取的凭据文件，请先配置工作区状态文件。');
    }
    settings = await applySettingsPatch(settings, patch, {
      save: (value) => settingsApi.saveSettings(settingsFile, value),
      loginEnabled: loginItemEnabled(),
      applyLogin: (enabled) => {
        if (!app.isPackaged) throw new Error('开发模式不支持开机启动，请使用安装版。');
        app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: enabled });
      },
    });
    needsRestart = settingsNeedRestart(activeSettings, settings);
    updateTray();
    return settingsView();
  });
  settingsUpdates = pending;
  return pending;
}

function registerIpc() {
  ipcMain.handle('desktop:settings:choose-directory', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择任务数据目录', defaultPath: settings?.dataRoot || engine?.dataRoot,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('desktop:menu', () => appMenuModel);
  ipcMain.handle('desktop:run', (_event, id) => runMenuAction(String(id)));
  ipcMain.handle('desktop:settings:get', () => settingsView());
  ipcMain.handle('desktop:settings:patch', (_event, patch) => updateSettings(patch));
}

/** The menu bar is drawn in the page, so its shortcuts are bound here. */
function registerShortcuts() {
  const contents = webContents();
  if (!contents) return;
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
    const ctrl = input.control || input.meta;
    let action = null;
    if (key === 'F5' || (ctrl && key === 'r')) action = 'reload';
    else if (key === 'F11') action = 'fullscreen';
    else if (ctrl && key === 'q') action = 'quit';
    else if (ctrl && key === 'w') action = 'close-window';
    else if (ctrl && key === '0') action = 'zoom-reset';
    else if (ctrl && (key === '=' || key === '+')) action = 'zoom-in';
    else if (ctrl && key === '-') action = 'zoom-out';
    else if (ctrl && input.shift && key === 'i') action = 'devtools';
    if (!action) return;
    event.preventDefault();
    runMenuAction(action);
  });
}

async function startEngine() {
  const serverModule = await loadServerModule();
  // Adapters are registered after the local server is up: the built-in bridge
  // needs the engine's real URL, and that is only known once it bound a port.
  engine = new serverModule.AsyncEngine({
    ...(settings.dataRoot ? { dataRoot: settings.dataRoot } : {}),
    log: (message) => console.log(message),
  });
  await engine.open();
  unsubscribeEngine = engine.subscribe(notifyFromEvent);
  for (const warning of engine.warnings) console.warn(`[任务] ${warning}`);
  console.log(`[任务] 引擎已启动 · 数据目录 ${engine.dataRoot}`);
}

/**
 * Bring up the built-in bridge and point the engine at it.
 *
 * One app, not two: the bridge is a child of this process. It is a child rather
 * than in-process code so a wedged client cannot freeze the window, but the user
 * never starts, watches, or stops it separately.
 */
async function startBridges() {
  const serverModule = await loadServerModule();
  if (engine && (settings.connectors || []).length > 0) {
    managedBridge = await startManagedBridge({
      engineUrl: room.url,
      // Task data and bridge data sit side by side under the same data root.
      dataDir: resolve(engine.dataRoot, '..', 'bridge'),
      desktopNativeDir: settings.desktopNativeDir || 'D:/Programs/AgentRelay/desktop-native',
      preferredPort: settings.bridgePort || 7901,
      signal: lifecycleAbort.signal,
      log: (line) => console.log(line),
    });
  }
  if (!engine || quitting) return;
  const registered = new Set();
  if (managedBridge && managedBridge.url) {
    for (const client of settings.connectors || []) {
      engine.registerAdapter(new serverModule.HttpBridgeAdapter({ client, baseUrl: managedBridge.url }));
      registered.add(client);
    }
  }
  for (const bridge of settings.bridges || []) {
    if (!bridge?.url || registered.has(bridge.client)) continue;
    engine.registerAdapter(new serverModule.HttpBridgeAdapter({ client: bridge.client, baseUrl: bridge.url }));
    registered.add(bridge.client);
  }
  if (registered.size > 0) console.log(`[桥接] 已注册客户端：${[...registered].join('、')}`);
}

async function start() {
  const configModule = await loadHelpers();

  try {
    config = configModule.resolveConfig();
    config.profilePath = app.getPath('userData');
  } catch (error) {
    dialog.showErrorBox('无法启动 Relay系统', error instanceof Error ? error.message : String(error));
    app.exit(1);
    return;
  }

  // `userData` holds only this small settings record; task data lives under the
  // data root the user picks. The env override exists so a dev or test run can
  // keep even that file off the system drive.
  settingsFile = process.env.RELAY_DESKTOP_SETTINGS?.trim() || join(app.getPath('userData'), 'settings.json');
  settings = await settingsApi.loadSettings(settingsFile);
  activeSettings = settings;

  try {
    await startEngine();
  } catch (error) {
    // A broken task store must not take the observer down with it; the engine is
    // reported as unavailable and the rest of the app still opens.
    console.error(`[任务] 引擎启动失败：${error instanceof Error ? error.message : String(error)}`);
    engine = null;
  }

  try {
    room = await startRoom({ config, engine, log: (message) => console.log(message) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('协作中枢未能启动', detail);
    app.exit(1);
    return;
  }

  console.log(`[控制中心] 已启动 ${room.url} · ${room.mode}${engine ? ' · 任务引擎已挂载' : ''}`);
  // No native menu bar: the page renders the menu in the console's own style.
  Menu.setApplicationMenu(null);
  registerIpc();
  await createWindow();
  registerShortcuts();

  const image = nativeImage.createFromPath(TRAY_ICON);
  tray = new Tray(image.isEmpty() ? nativeImage.createFromPath(ICON) : image);
  tray.on('double-click', showWindow);
  tray.on('click', showWindow);
  updateTray();
  // Show the window first. Slow client/bootstrap calls must never leave an icon
  // that appears unresponsive for the bridge's entire retry deadline.
  await startBridges().catch((error) => recordFailure('派发桥接启动失败', error));
  if (quitting) return;
  if (win && !win.isDestroyed()) win.webContents.send('desktop:connections-ready');
  const { startSystemClients } = await import('./lib/system-startup.mjs');
  if (!config.smoke) {
    const bootstrap = startSystemClients(config, { consoleDir: dirname(process.execPath) });
    clientBootstrap = bootstrap;
    bootstrap?.once('exit', () => {
      if (!quitting && win && !win.isDestroyed()) win.webContents.send('desktop:connections-ready');
    });
  }
  await refreshStatus();
  if (config.smoke) {
    // The tray is the part no screenshot can prove, so the smoke run states it.
    const labels = (lastMenu || [])
      .map((item) => (item.type === 'separator' ? '——' : item.label))
      .join(' | ');
    say(`[冒烟] 托盘菜单：${labels}`);
    say(`[冒烟] 托盘提示：${lastTooltip}`);
    say(`[冒烟] 任务引擎：${engine ? engine.dataRoot : '未启用'}`);
    say(`[冒烟] 内置桥接：${managedBridge && managedBridge.url ? managedBridge.url : '未启动'}`);
    app.quit();
    return;
  }
  statusTimer = setInterval(() => void refreshStatus(), STATUS_INTERVAL_MS);
  if (statusTimer.unref) statusTimer.unref();
}

app.setAppUserModelId('com.agentrelay.controlroom');

const locked = app.requestSingleInstanceLock({ showWindow: !process.argv.includes('--no-window') });
recordLaunch('instance-lock', { locked, manual: !process.argv.includes('--no-window') });
if (!locked) {
  // A second launch is a request to show the window that is already running.
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _cwd, intent) => {
    recordLaunch('second-instance', { manual: intent?.showWindow, backgroundArg: argv.includes('--no-window') });
    if (intent?.showWindow ?? !argv.includes('--no-window')) {
      pendingShow = true;
      showWindow();
    }
  });
  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    quitting = true;
    lifecycleAbort.abort();
    clientBootstrap?.kill();
    if (statusTimer) clearInterval(statusTimer);
    if (!shutdownPending) {
      shutdownPending = import('./lib/shutdown.mjs').then(({ shutdownDesktop }) =>
        shutdownDesktop({ unsubscribe: unsubscribeEngine, room, engine, bridge: managedBridge, settingsUpdates })
      ).then((result) => {
        if (result.timedOut) recordFailure('退出超时', '资源未在 5 秒内释放');
        for (const error of result.errors) recordFailure('退出清理失败', error);
      }).catch((error) => recordFailure('退出失败', error)).finally(() => {
        shutdownComplete = true;
        app.quit();
      });
    }
  });
  app.on('window-all-closed', () => {
    // Tray mode keeps running with no window; otherwise closing the window is a
    // quit, and the engine must stop with it.
    if (settings?.closeToTray) return;
    quitting = true;
    app.quit();
  });
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('协作中枢未能启动', error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
}
