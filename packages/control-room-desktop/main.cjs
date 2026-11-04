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

const { join } = require('node:path');
const { writeSync } = require('node:fs');
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
} = require('electron');

const APP_ROOT = __dirname;
const ICON = join(APP_ROOT, 'assets', 'icon.png');
const TRAY_ICON = join(APP_ROOT, 'assets', 'tray.png');
const STATUS_INTERVAL_MS = 10_000;
/** Height of the in-page menu bar; the OS caption buttons are drawn over it. */
const TOPBAR_HEIGHT = 61;

// Filled by `start()` before any window or tray exists.
let config = null;
let buildTrayMenu = null;
let trayTooltip = null;
let startRoom = null;
let probe = null;
let probeTasks = null;
let loadServerModule = null;
let appMenuModel = [];
let MENU_ACTIONS = new Set();
let settingsApi = null;

let room = null;
let engine = null;
let unsubscribeEngine = null;
let settings = null;
let settingsFile = null;
let win = null;
let tray = null;
let status = null;
let statusError = null;
let taskCounts = null;
let probedAt = null;
let quitting = false;
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
  const [configModule, roomModule, trayModule, menuModule, settingsModule] = await Promise.all([
    import('./lib/config.mjs'),
    import('./lib/room-service.mjs'),
    import('./lib/tray-menu.mjs'),
    import('./lib/app-menu.mjs'),
    import('./lib/settings.mjs'),
  ]);
  MENU_ACTIONS = new Set(menuModule.MENU_ACTIONS);
  appMenuModel = menuModule.buildAppMenu({ isPackaged: app.isPackaged });
  buildTrayMenu = trayModule.buildTrayMenu;
  trayTooltip = trayModule.trayTooltip;
  startRoom = roomModule.startRoom;
  probe = roomModule.probe;
  probeTasks = roomModule.probeTasks;
  loadServerModule = roomModule.loadServerModule;
  settingsApi = settingsModule;
  return configModule;
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    void createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0b1015',
    title: 'Relay 协作中枢',
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
    if (config.showWindow || config.smoke) win.show();
  });

  win.on('close', (event) => {
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
    return app.getLoginItemSettings({ openAsHidden: true }).openAtLogin === true;
  } catch {
    return false;
  }
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
      openInBrowser: () => {
        if (room) void shell.openExternal(room.url);
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
  app.setLoginItemSettings({ openAtLogin: next, openAsHidden: true });
  if (settings) {
    settings = { ...settings, loginAtStartup: next };
    await settingsApi.saveSettings(settingsFile, settings).catch(() => undefined);
  }
  updateTray();
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
    title: '关于 Relay 协作中枢',
    message: 'Relay 协作中枢',
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
  'open-chat': () => void navigate('/chat.html'),
  'open-tasks': () => void navigate('/tasks.html'),
  'open-observer': () => void navigate('/'),
  'open-settings': () => void navigate('/tasks.html#settings'),
  'copy-url': () => {
    if (room) clipboard.writeText(room.url);
  },
  'open-browser': () => {
    if (room) void shell.openExternal(room.url);
  },
  quit: () => {
    quitting = true;
    app.quit();
  },
  reload: () => {
    const contents = webContents();
    if (contents) contents.reload();
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
  };
}

function registerIpc() {
  ipcMain.handle('desktop:menu', () => appMenuModel);
  ipcMain.handle('desktop:run', (_event, id) => runMenuAction(String(id)));
  ipcMain.handle('desktop:settings:get', () => settingsView());
  ipcMain.handle('desktop:settings:patch', async (_event, patch) => {
    if (!settings) return settingsView();
    const next = settingsApi.mergeSettings(settings, patch);
    const dataRootChanged = next.dataRoot !== settings.dataRoot;
    if (app.isPackaged && next.loginAtStartup !== loginItemEnabled()) {
      app.setLoginItemSettings({ openAtLogin: next.loginAtStartup, openAsHidden: true });
    }
    settings = next;
    await settingsApi.saveSettings(settingsFile, settings).catch((error) => {
      say(`[设置] 保存失败：${error.message}`);
    });
    updateTray();
    // A new data root applies on the next start: swapping the store under a live
    // engine would leave tasks in two places with no single answer.
    return { ...settingsView(), restartRequired: dataRootChanged };
  });
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
  const adapters = (settings.bridges || []).map(
    (bridge) =>
      new serverModule.HttpBridgeAdapter({
        client: bridge.client,
        baseUrl: bridge.url,
      })
  );
  engine = new serverModule.AsyncEngine({
    ...(settings.dataRoot ? { dataRoot: settings.dataRoot } : {}),
    adapters,
    log: (message) => console.log(message),
  });
  await engine.open();
  unsubscribeEngine = engine.subscribe(notifyFromEvent);
  for (const warning of engine.warnings) console.warn(`[任务] ${warning}`);
  console.log(`[任务] 引擎已启动 · 数据目录 ${engine.dataRoot}`);
}

async function start() {
  const configModule = await loadHelpers();

  try {
    config = configModule.resolveConfig();
  } catch (error) {
    dialog.showErrorBox('无法启动 Relay 协作中枢', error instanceof Error ? error.message : String(error));
    app.exit(1);
    return;
  }

  // `userData` holds only this small settings record; task data lives under the
  // data root the user picks. The env override exists so a dev or test run can
  // keep even that file off the system drive.
  settingsFile = process.env.RELAY_DESKTOP_SETTINGS?.trim() || join(app.getPath('userData'), 'settings.json');
  settings = await settingsApi.loadSettings(settingsFile);

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
  await refreshStatus();
  if (config.smoke) {
    // The tray is the part no screenshot can prove, so the smoke run states it.
    const labels = (lastMenu || [])
      .map((item) => (item.type === 'separator' ? '——' : item.label))
      .join(' | ');
    say(`[冒烟] 托盘菜单：${labels}`);
    say(`[冒烟] 托盘提示：${lastTooltip}`);
    say(`[冒烟] 任务引擎：${engine ? engine.dataRoot : '未启用'}`);
    app.quit();
    return;
  }
  statusTimer = setInterval(() => void refreshStatus(), STATUS_INTERVAL_MS);
  if (statusTimer.unref) statusTimer.unref();
}

app.setAppUserModelId('com.agentrelay.controlroom');

const locked = app.requestSingleInstanceLock();
if (!locked) {
  // A second launch is a request to show the window that is already running.
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    if (statusTimer) clearInterval(statusTimer);
  });
  app.on('window-all-closed', () => {
    // Tray mode keeps running with no window; otherwise closing the window is a
    // quit, and the engine must stop with it.
    if (settings?.closeToTray) return;
    quitting = true;
    app.quit();
  });
  app.whenReady().then(start, (error) => {
    dialog.showErrorBox('协作中枢未能启动', error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
  app.on('will-quit', () => {
    // Stop intake before the port closes: no callback may be half-delivered.
    if (unsubscribeEngine) unsubscribeEngine();
    unsubscribeEngine = null;
    const closingEngine = engine;
    engine = null;
    if (room) void room.close();
    room = null;
    if (closingEngine) void closingEngine.close().catch(() => undefined);
  });
}
