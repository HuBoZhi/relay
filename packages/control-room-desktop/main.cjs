/**
 * Electron shell around the control room (CommonJS on purpose).
 *
 * The same web interface as `relay-control-room`, plus what a desktop build owes
 * its user: a tray icon that outlives the window, a status panel without opening
 * anything, and one obvious way to quit. The server is the shipped control-room
 * bundle; this file only owns window and tray lifecycle.
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
let appMenuModel = [];
let MENU_ACTIONS = new Set();

let room = null;
let win = null;
let tray = null;
let status = null;
let statusError = null;
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
  const [configModule, roomModule, trayModule, menuModule] = await Promise.all([
    import('./lib/config.mjs'),
    import('./lib/room-service.mjs'),
    import('./lib/tray-menu.mjs'),
    import('./lib/app-menu.mjs'),
  ]);
  MENU_ACTIONS = new Set(menuModule.MENU_ACTIONS);
  appMenuModel = menuModule.buildAppMenu({ isPackaged: app.isPackaged });
  buildTrayMenu = trayModule.buildTrayMenu;
  trayTooltip = trayModule.trayTooltip;
  startRoom = roomModule.startRoom;
  probe = roomModule.probe;
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

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0b1015',
    title: '协作控制中心',
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
    event.preventDefault();
    win.hide();
    if (!hideNoticed && tray) {
      hideNoticed = true;
      tray.displayBalloon({
        title: '协作控制中心仍在运行',
        content: '窗口已收进托盘，双击托盘图标可重新打开；观察不会中断。',
      });
    }
  });

  await win.loadURL(room.url);

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
  if (!app.isPackaged) return false;
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
    actions: {
      openWindow: showWindow,
      copyUrl: () => {
        if (room) clipboard.writeText(room.url);
      },
      openInBrowser: () => {
        if (room) void shell.openExternal(room.url);
      },
      refresh: () => void refreshStatus(),
      toggleLoginAtStartup: () => {
        if (!app.isPackaged) return;
        app.setLoginItemSettings({ openAtLogin: !loginItemEnabled(), openAsHidden: true });
        updateTray();
      },
      quit: () => {
        quitting = true;
        app.quit();
      },
    },
  });
  lastMenu = menu;
  tray.setContextMenu(Menu.buildFromTemplate(menu));
  lastTooltip = trayTooltip({ mode: room ? room.mode : '演示数据', status, error: statusError });
  tray.setToolTip(lastTooltip);
}

async function refreshStatus() {
  const result = await probe(room ? room.url : '');
  status = result.ok ? result.status : null;
  statusError = result.ok ? null : result.error;
  probedAt = result.ok ? result.at : Date.now();
  updateTray();
}

function showStatusHelp() {
  void dialog.showMessageBox({
    type: 'info',
    title: '状态说明',
    message: '托盘里显示的是什么',
    detail: [
      '运行模式：演示数据表示没有配置只读令牌；只读观察表示正在读取真实工作空间。',
      '数据连接：取自控制中心自己的连接状态，与界面右上角一致。',
      '工作空间与今日消息：来自最近一次读取，每 10 秒刷新一次。',
      '只读观察不会发送消息，也不影响智能体运行。',
    ].join('\n'),
    buttons: ['知道了'],
    noLink: true,
  });
}

function showAbout() {
  void dialog.showMessageBox({
    type: 'info',
    title: '关于协作控制中心',
    message: '协作控制中心',
    detail:
      `版本 ${app.getVersion()}\n` +
      '只读观察工作空间中的频道、智能体工作状态与消息流转。\n' +
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

function registerIpc() {
  ipcMain.handle('desktop:menu', () => appMenuModel);
  ipcMain.handle('desktop:run', (_event, id) => runMenuAction(String(id)));
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

async function start() {
  const configModule = await loadHelpers();

  try {
    config = configModule.resolveConfig();
  } catch (error) {
    dialog.showErrorBox('无法启动协作控制中心', error instanceof Error ? error.message : String(error));
    app.exit(1);
    return;
  }

  try {
    room = await startRoom({ config, log: (message) => console.log(message) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('协作控制中心未能启动', detail);
    app.exit(1);
    return;
  }

  console.log(`[控制中心] 已启动 ${room.url} · ${room.mode}`);
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
    // Tray apps stay alive with no window; quitting is an explicit menu action.
  });
  app.whenReady().then(start, (error) => {
    dialog.showErrorBox('协作控制中心未能启动', error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
  app.on('will-quit', () => {
    if (room) void room.close();
    room = null;
  });
}
