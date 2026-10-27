/**
 * The application menu, defined once.
 *
 * Electron's native Windows menu bar is a light grey strip that cannot be
 * themed, and it sat badly above a graphite console. The shell therefore drops
 * the native menu entirely and renders this model inside the page, where it
 * inherits the same type scale, colour and spacing as the rest of the interface.
 *
 * The model is plain data (no Electron import) so the tray, the renderer and the
 * tests all read the same definition.
 */

/** Actions the shell knows how to perform; anything else is rejected. */
export const MENU_ACTIONS = [
  'copy-url',
  'open-browser',
  'quit',
  'reload',
  'zoom-reset',
  'zoom-in',
  'zoom-out',
  'fullscreen',
  'hide-to-tray',
  'minimize',
  'close-window',
  'status-help',
  'about',
  'devtools',
];

const SEPARATOR = { type: 'separator' };

/**
 * @param {{ isPackaged?: boolean }} options
 * @returns {Array<{ label: string, items: Array<{ id: string, label: string } | { type: 'separator' }> }>}
 */
export function buildAppMenu({ isPackaged = true } = {}) {
  return [
    {
      label: '控制中心',
      items: [
        { id: 'copy-url', label: '复制访问地址' },
        { id: 'open-browser', label: '在浏览器中打开' },
        SEPARATOR,
        { id: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      items: [
        { id: 'reload', label: '重新加载' },
        ...(isPackaged ? [] : [{ id: 'devtools', label: '开发者工具' }]),
        SEPARATOR,
        { id: 'zoom-reset', label: '实际大小' },
        { id: 'zoom-in', label: '放大' },
        { id: 'zoom-out', label: '缩小' },
        SEPARATOR,
        { id: 'fullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      items: [
        { id: 'hide-to-tray', label: '最小化到托盘' },
        { id: 'minimize', label: '最小化' },
        { id: 'close-window', label: '关闭窗口' },
      ],
    },
    {
      label: '帮助',
      items: [
        { id: 'status-help', label: '状态说明' },
        { id: 'about', label: '关于' },
      ],
    },
  ];
}

/** Flat list of actionable ids, for validation before dispatch. */
export function menuActionIds(menu) {
  return menu.flatMap((group) => group.items.filter((item) => item.id).map((item) => item.id));
}
