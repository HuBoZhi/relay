# 协作控制中心 · 桌面托盘版（`@agent-relay/control-room-desktop`）

把 [`@agent-relay/control-room`](../control-room) 的只读观察界面装进一个桌面外壳：
启动后仍是同一个 Web 界面，但多了一个系统托盘图标——关掉窗口不等于退出进程，观察不会中断。

- 界面与 `relay-control-room` 完全同源：服务端是控制中心打包产物，前端是 `packages/control-room/web`。
- 托盘图标提供：打开界面、复制访问地址、在浏览器中打开、查看运行状态、刷新状态、开机自动启动、退出。
- 窗口没有系统标题栏：菜单（控制中心 / 视图 / 窗口 / 帮助）画在页面顶栏里，深色、与界面同一套字号与配色。
- 没有配置凭据时自动进入演示数据模式（页面顶部会说明），不会静默连到任何服务。

## 运行

```bash
# 开发运行：先构建，再启动 Electron
npm run build -w @agent-relay/control-room-desktop
npm run start -w @agent-relay/control-room-desktop
```

观察真实工作空间（只读观察者令牌，建议用 `agent-relay observer` 签）：

```bash
npm run build -w @agent-relay/control-room-desktop
RELAY_CONTROL_ROOM_TOKEN=ot_live_… npm run start -w @agent-relay/control-room-desktop
```

## 参数与环境变量

### Windows 统一启动与驻留

已有 `D:\Programs\AgentRelay` 本地适配器和控制台部署时，把 `scripts/Start-RelaySystem.ps1`
与 `scripts/Start-ControlRoomService.ps1` 一起放到适配器目录，由原来的登录入口调用
`Start-RelaySystem.ps1`。它复用现有工作区，不创建新工作区。

同时使用 `scripts/Start-RelayFactory.ps1` 替换适配器目录中的同名启动脚本。
Factory 由独立隐藏宿主启动，标准输出和错误分别写入适配器目录的
`logs/factory.stdout.log`、`logs/factory.stderr.log`，启动终端可正常结束。
已有 Factory 会话不会自动重启；新启动方式在下一次启动 Factory 时生效。

控制台由 Windows 桌面 Shell 启动的独立监护进程管理，启动终端或自动化任务结束后继续驻留。
监护进程接管已有控制台；退出后按退避间隔重启，重复启动只保留一个监护进程。
统一模式下，菜单“退出”也会触发重新拉起；需要停止本地控制台及监护时，使用：

```powershell
& D:\Programs\AgentRelay\Start-ControlRoomService.ps1 -Action Stop
& D:\Programs\AgentRelay\Start-ControlRoomService.ps1 -Action Start
& D:\Programs\AgentRelay\Start-ControlRoomService.ps1 -Action Status
```

实时进程状态记录在控制台目录的 `data/console-service-status.json`，退出与重启日志在
`logs/console-service.log`；`running` 只表示进程仍在，服务就绪须另查 `/api/health`，
工作区连接须查 `/api/bootstrap`。这些脚本依赖 Windows 交互桌面，不是 Windows 系统服务，
不会跨用户注销保持运行，也不会重启适配器客户端或停止云端 Relaycast。

生命周期回归测试：先把 `TEMP`、`TMP`、`TMPDIR` 设置到本次 D 盘临时目录，再运行
`npm run test:lifetime -w @agent-relay/control-room-desktop`。

| 参数            | 说明                                               |
| --------------- | -------------------------------------------------- |
| `--port <端口>` | 本地监听端口，默认 `4320`；被占用时自动向后顺延    |
| `--host <地址>` | 监听地址，默认 `127.0.0.1`                         |
| `--base-url`    | Relay 服务地址，不填则用部署默认值                 |
| `--token`       | 只读观察者令牌或工作空间密钥（不写入任何配置文件） |
| `--demo`        | 强制使用演示数据                                   |
| `--no-window`   | 启动后只驻留托盘，不打开窗口                       |

环境变量：`RELAY_CONTROL_ROOM_TOKEN`（优先）、`RELAY_WORKSPACE_KEY`、`RELAY_API_KEY`、
`RELAY_CONTROL_ROOM_TZ`（界面与托盘时间，默认 `Asia/Shanghai`）。

## 窗口与菜单

Windows 原生标题栏和它的灰色菜单条没法跟着深色界面走，所以外壳把标题栏隐藏，只保留系统的最小化 / 最大化 / 关闭按钮，
菜单改由页面绘制（`web/desktop.css` + `web/app.js` 的 `mountDesktopMenu`）：

- 顶栏左侧四组菜单，点击展开、悬停切换、Esc 或点空白处收起，支持左右方向键切换分组。
- 菜单数据只有一份：`lib/app-menu.mjs`。主进程通过 IPC 交给页面，页面点条目后回传动作 id，
  主进程只执行白名单里的动作（复制地址、浏览器打开、重新加载、缩放、全屏、最小化到托盘、退出、帮助等）。
- 页面通过 `preload.cjs` 拿到 `window.relayDesktop`（三个方法：`menu` / `run` / `platform`）；
  在浏览器里不存在这个对象，菜单栏自然不显示，网页版布局完全不变。
- 快捷键在 `before-input-event` 里绑定：F5 或 Ctrl+R 重新加载、F11 全屏、Ctrl+0/± 缩放、
  Ctrl+Q 退出、Ctrl+W 关闭窗口、Ctrl+Shift+I 开发者工具（仅未打包时）。
- 顶栏本身是窗口拖动区，右侧预留 152px 给系统按钮。

## 托盘菜单

```
打开控制中心
复制访问地址
在浏览器中打开
────────────────────
运行模式：演示数据 / 只读观察 · 服务地址
监听地址：127.0.0.1:4320
数据连接：实时事件 / 重连中 / 本地服务无响应
工作空间：8 个频道 · 23 个智能体
今日消息：141 条
更新时间：10:12:37
────────────────────
刷新状态
开机自动启动
────────────────────
退出
```

- 双击托盘图标或选「打开控制中心」恢复窗口；关窗只是隐藏，状态行每 10 秒刷新一次。
- 「退出」是唯一结束进程的入口；开机自启只在安装版生效（便携版不写注册表）。

## 打包

```bash
npm run package:win -w @agent-relay/control-room-desktop
```

产物在 `packages/control-room-desktop/release/`：

- `RelayControlRoom-<版本>-便携版.exe`：免安装，双击即用，适合拷给别人。
- `RelayControlRoom-<版本>-安装包.exe`：可选择安装目录、创建开始菜单与桌面快捷方式。

服务端依赖（含 SDK）由 esbuild 内联进 `dist/server.mjs`，因此安装包不需要 `node_modules`，
也不会出现「外壳版本与 CLI 版本不一致」这类问题。

## 结构

| 路径                                                | 作用                                                |
| --------------------------------------------------- | --------------------------------------------------- |
| `main.cjs`                                          | 主进程：窗口、托盘、应用菜单、单实例、状态刷新      |
| `lib/config.mjs`                                    | 参数与环境变量解析（无凭据即演示模式）              |
| `lib/room-service.mjs`                              | 启动控制中心服务、端口顺延、状态探测                |
| `lib/tray-menu.mjs`                                 | 托盘菜单模板与状态摘要（纯函数，可单测）            |
| `scripts/build.mjs`                                 | 打包服务端、复制界面资源                            |
| `scripts/make-icons.mjs`                            | 用几何图形生成 `icon.png` / `tray.png` / `icon.ico` |
| `web/desktop.css`（在 `packages/control-room/web`） | 桌面专用样式：拖动区、菜单栏与下拉面板              |

## 注意

- 桌面版和服务一样只监听回环地址，凭据留在进程内，浏览器拿不到。
- 在设置了 `ELECTRON_RUN_AS_NODE=1` 的终端里跑 `electron` 会退化成普通 Node 进程，
  表现为 `require('electron')` 拿到的是路径字符串；本地调试请先 `unset ELECTRON_RUN_AS_NODE`。
- 冒烟自检（会打开窗口、截图后退出）：`npm run smoke -w @agent-relay/control-room-desktop -- --capture D:/tmp/shot.png`。
