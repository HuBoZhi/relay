# Relay系统 · 桌面托盘版（`@agent-relay/control-room-desktop`）

把 [`@agent-relay/control-room`](../control-room) 的群聊、任务工作台与观察界面装进一个桌面外壳，
并让外壳自己承载异步任务引擎（消息受理、派发队列、回传路由）。

- 双击打开就是群聊：一个主题一个群，在群里 @ 某个 Agent 并指定模型、思考强度与项目即派活。
- 界面与 `relay-control-room` 完全同源：服务端是控制中心打包产物，前端是 `packages/control-room/web`。
- 关闭窗口默认**退出应用**：订阅、端口、引擎一起停止；「缩小到托盘」需要显式操作或在设置里开启。
- 托盘图标提供：打开界面、打开任务工作台、设置、复制访问地址、在浏览器中打开、查看运行状态
  （含在途阶段、等待确认、需人工回传）、刷新状态、缩小到托盘、开机自动启动、退出。
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
| `--workspace-state` | 从已有本机 Relay 状态 JSON 的 `workspaceKey` 字段读取凭据，适用于开机启动 |
| `--demo`        | 强制使用演示数据                                   |
| `--no-window`   | 启动后只驻留托盘，不打开窗口                       |

环境变量：`RELAY_CONTROL_ROOM_TOKEN`（优先）、`RELAY_WORKSPACE_KEY`、`RELAY_API_KEY`、
`RELAY_CONTROL_ROOM_TZ`（界面与托盘时间，默认 `Asia/Shanghai`）、
`RELAY_ASYNC_DATA_ROOT`（任务数据目录，覆盖设置中的值）、
`RELAY_DESKTOP_SETTINGS`（设置文件位置，仅供开发与测试把设置移出系统盘）。

也可通过 `RELAY_CONTROL_ROOM_STATE_FILE` 指定已有状态文件。显式令牌、环境令牌优先于状态文件；指定的状态文件不可用时报告错误，不切换到演示数据。状态文件只在本机主进程读取，密钥不会出现在启动项或浏览器地址中。

本机安装示例（复用已有 Electron 运行文件与服务端 bundle，不下载依赖）：

```powershell
& packages/control-room-desktop/scripts/install-local.ps1 `
  -RuntimeSource G:\Coding\Github\relay\packages\control-room-desktop\release\win-unpacked `
  -BundleSource G:\Coding\Github\relay\packages\control-room-desktop\dist
```

加入 `-SystemLauncher D:\Programs\AgentRelay\Start-RelaySystem.ps1` 可安装统一入口：登录启动项和开始菜单均先检查/启动 ZCode、WorkBuddy、Factory 的桌面接口，再启动同一工作区的托盘控制台。原来的三个独立 Run 项会在备份后移除；托盘开机启动开关保留统一入口。运行结果记录在 `D:\Programs\AgentRelay\data\unified-system-status.json`。已运行却未开启接口的编辑器会显示“需要重启”，不会强制结束用户任务。

统一的是当前已验收的“托管 Relaycast＋本机桌面适配器＋控制台”系统，远端后台本来就持续运行。安装版官方 CLI 的 native broker 不支持 Windows，统一入口不会启动或冒充该 broker。不要把 `agent-relay node status` 中的 broker 停止状态误当成托管消息服务断开。

默认安装到 `D:\Programs\RelaySystem`，复用 `D:\Programs\AgentRelay\data\workspace.private.json`，创建用户登录启动项 `RelaySystem` 以及开始菜单与桌面上的“Relay系统”快捷方式（旧名“Relay 可视化控制台”的快捷方式在重装时删除）。登录后以 `--no-window` 驻留托盘，右键菜单显示运行状态并可通过系统默认浏览器打开网页。原启动项记录在安装目录的 `startup-install-record.json`。

托盘的开机启动开关保留状态文件路径、端口及用户数据目录；每次启动重新读取当前凭据，避免继承不到终端环境变量而进入演示模式。未指定状态文件的临时令牌会话不能启用开机启动。指定 `--user-data-dir` 时，配置、日志和运行临时目录位于该目录下。

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
打开任务工作台
设置数据目录与启动行为
复制访问地址
在浏览器中打开
────────────────────
运行模式：演示数据 / 只读观察 · 服务地址
监听地址：127.0.0.1:4320
数据连接：实时事件 / 重连中 / 本地服务无响应
工作空间：8 个频道 · 23 个智能体
今日消息：141 条
任务：在途 1 · 待确认 0 · 需人工 0
更新时间：10:12:37
────────────────────
刷新状态
缩小到托盘
开机自动启动
────────────────────
退出
```

- 双击托盘图标或选「打开控制中心」恢复窗口；状态行每 10 秒刷新一次。
- 「任务」一行来自本机引擎；引擎不可用时显示「任务：未启用」，不会显示三个 0。
- 「退出」是所有自有组件的终点：先退订引擎，再关服务与端口，最后关闭数据存储。
- 开机自启只在安装版生效（便携版不写注册表）；开发模式下点击会明确提示不会写入。

## 任务引擎与内置桥接

外壳在主进程里创建 `AsyncEngine` 并挂到同一个本地端口，因此窗口与接口同源、同生命周期。
派发桥接也由应用自己拉起、自己关掉（`dist/bridge.mjs`，子进程隔离，避免客户端卡住时冻结窗口）：

- 启动时读设置里的 `connectors`（默认 `zcode`、`workbuddy`），在 `bridgePort`（默认 7901）上起桥接；
- 端口被占用会依次顺延；桥接起不来时应用照常打开，派活显示「已排队」并写明原因；
- 关闭应用时桥接子进程一起结束，不留后台进程；
- 设置页「内置派发桥接」显示运行地址与端口，并可勾选要启用的客户端（需重启生效）。

需要单独跑桥接（无界面安装、调试）时仍可用 `relay-dispatch-bridge`，见
[`packages/dispatch-bridge`](../dispatch-bridge)。

## 任务引擎细节

- 任务数据落在数据目录（默认取 D/G 盘，可在设置中修改），使用 `state.json` + `journal.jsonl`。
- 关闭窗口（未开启托盘模式）＝退出应用，不会被旧看护脚本重新拉起。
- 桌面通知：阶段完成 / 失败 / 阻塞、以及原聊天未收到的回传；点击通知跳到对应任务。
- 设置（任务工作台 → 设置与数据）：关窗行为、通知、开机启动、任务数据目录。
  修改数据目录需要重启应用生效。
- 设置文件只有一条记录，位于 Electron `userData/settings.json`；任务正文、路径、回传绑定都在数据目录内。

## 打包

本地统一入口由 `install-local.ps1 -SystemLauncher <路径>` 部署时，会在启动脚本旁放置
`Start-RelayHidden.vbs`。桌面和开始菜单快捷方式通过 Windows 的 `wscript.exe` 调用它，
在创建 PowerShell 子进程时就隐藏控制台，避免 `powershell.exe -WindowStyle Hidden` 启动时的黑框闪烁。
手动入口保留打开窗口的行为，登录启动额外传入 `-Background`，保持托盘驻留。

```bash
npm run package:win -w @agent-relay/control-room-desktop
```

产物在 `packages/control-room-desktop/release/`：

- `RelaySystem-<版本>-便携版.exe`：免安装，双击即用，适合拷给别人。
- `RelaySystem-<版本>-安装包.exe`：可选择安装目录、创建开始菜单与桌面快捷方式。

服务端依赖（含 SDK）由 esbuild 内联进 `dist/server.mjs`，因此安装包不需要 `node_modules`，
也不会出现「外壳版本与 CLI 版本不一致」这类问题。

## 结构

| 路径                                                | 作用                                                |
| --------------------------------------------------- | --------------------------------------------------- |
| `main.cjs`                                          | 主进程：窗口、托盘、菜单、单实例、任务引擎、通知    |
| `lib/settings.mjs`                                  | 设置记录：数据目录、关窗行为、通知、自启、桥接      |
| `lib/config.mjs`                                    | 参数与环境变量解析（无凭据即演示模式）              |
| `lib/room-service.mjs`                              | 启动控制中心服务、端口顺延、状态探测                |
| `lib/tray-menu.mjs`                                 | 托盘菜单模板与状态摘要（纯函数，可单测）            |
| `scripts/build.mjs`                                 | 打包服务端、复制界面资源                            |
| `scripts/make-icons.mjs`                            | 用几何图形生成 `icon.png` / `tray.png` / `icon.ico` |
| `web/desktop.css`（在 `packages/control-room/web`） | 桌面专用样式：拖动区、菜单栏与下拉面板              |

## 注意

- Windows 桌面运行时使用打包的 WebSocket 实现；REST 工作区密钥和实时订阅的只读观察者令牌分开使用。后者缓存于本机用户数据目录的 `observer.private.json`，不会发给网页。当前托管网关要求观察者令牌用于 WebSocket upgrade URL，这个地址只存在于主进程网络连接，不是浏览器访问地址，也不记录到日志。其他部署继续使用请求头认证。
- 当前连接状态取自实际观察者 socket 的打开/关闭事件，历史连接事件不会改写当前连接状态。订阅失败时仍如实降级，不通过更改状态标签掩盖失败。

- 桌面版和服务一样只监听回环地址，凭据留在进程内，浏览器拿不到。
- 任务引擎默认不注册任何客户端桥接：派发会停在「已排队」并显示原因，不会静默改投别的客户端。
- 在设置了 `ELECTRON_RUN_AS_NODE=1` 的终端里跑 `electron` 会退化成普通 Node 进程，
  表现为 `require('electron')` 拿到的是路径字符串；本地调试请先 `unset ELECTRON_RUN_AS_NODE`。
- 冒烟自检（会打开窗口、截图后退出）：`npm run smoke -w @agent-relay/control-room-desktop -- --capture D:/tmp/shot.png`。
