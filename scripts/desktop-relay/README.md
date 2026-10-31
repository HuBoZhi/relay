# Relay 桌面端直连

本目录面向正在运行的 WorkBuddy、ZCode 桌面端。连接路径为本机 CDP → 应用自己的 IPC／SDK，不模拟键盘、鼠标，也不通过 DOM 操作界面。

`cdp.mjs` 只允许 CDP 的 Runtime 调用，拒绝 Input、DOM 等命令。连接时检查本机端口、唯一的应用 renderer 和 WebSocket 地址；断线后未完成的调用会报错，不会自动重新发送可能已被应用接受的任务。

## 运行条件

- Node.js 22 或更高版本。
- WorkBuddy 启动时设置 `WORKBUDDY_REMOTE_DEBUGGING_PORT=19371`。
- ZCode 启动参数为 `--remote-debugging-port=19372 --remote-debugging-address=127.0.0.1`。
- 开启端口需要重启应用；先取得用户对重启的授权。端口只供本机使用，不能配置为对外监听。
- 这是依赖桌面端内部接口的本地适配，不是厂商公开、稳定的集成协议。升级客户端后重新验收。

## 当前验收

- WorkBuddy 5.9.2：Relay Action → `wb.conversations.get(...).runPrompt(...)` → Relay 结果回传通过。
- ZCode 3.16.3：通过桌面现有 MessagePort 服务代理调用 v4 `createTask`、`sendPrompt`、`readSession`，回传通过。没有启动额外 app-server，也没有读取或传送模型凭据。
- 两轮均要求模型原样返回本次随机标识与计算结果，Relay 回执 `output.ok=true`。没有鼠标、键盘、DOM 操作。
- `run.mjs` 是按次运行的本地适配器，运行期间处理自身发起的调用；尚未提供常驻收件服务。

本机入口（需安装目录内已有 `lib/relay.mjs`、SDK 和受限工作区凭据文件）：

```powershell
node scripts/desktop-relay/run.mjs workbuddy D:\Programs\AgentRelay
node scripts/desktop-relay/run.mjs zcode D:\Programs\AgentRelay
```

每次执行会调用真实桌面模型。会话绑定保存在安装目录的 `data/desktop-native.sessions.json`；验收回执位于 `reports/*-desktop-native-via-relay.json`。专用工作目录为 `D:\Programs\AgentRelay\desktop-workspace`。

ZCode 适配依赖 3.16.3 的模块文件名、服务注册表和协议。版本不匹配时应停止并重新适配，不应回退 UI 自动化。CDP 模块作用域检查仅用来取得已经连接的服务代理，任务操作由桌面后台原生服务执行。

## 测试

```powershell
$env:TEMP='D:\CodexTemp\your-task'
$env:TMP=$env:TEMP
$env:TMPDIR=$env:TEMP
node --test scripts/desktop-relay/cdp.test.mjs scripts/desktop-relay/native-clients.test.mjs
```

运行临时目录必须实际存在。连接凭据、浏览器页面 URL 中的种子和令牌不应进入日志或 Git。Relay 的工作区密钥与 Agent token 仅由本地进程读取，不能放入 CDP 表达式或发送给桌面 Agent。
