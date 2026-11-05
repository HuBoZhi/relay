# Relay 桌面端直连

本目录面向正在运行的 WorkBuddy、ZCode、Factory 桌面端。连接路径为本机 CDP → 应用自己的 IPC／SDK，不模拟键盘、鼠标，也不通过 DOM 操作界面。

`cdp.mjs` 只允许 CDP 的 Runtime 调用，拒绝 Input、DOM 等命令。连接时检查本机端口、唯一的应用 renderer 和 WebSocket 地址；断线后未完成的调用会报错，不会自动重新发送可能已被应用接受的任务。

## 运行条件

- Node.js 22 或更高版本。
- WorkBuddy 启动时设置 `WORKBUDDY_REMOTE_DEBUGGING_PORT=19371`。
- ZCode 启动参数为 `--remote-debugging-port=19372 --remote-debugging-address=127.0.0.1`。
- Factory 启动参数为 `--remote-debugging-port=19373 --remote-debugging-address=127.0.0.1`。
- 开启端口需要重启应用；先取得用户对重启的授权。端口只供本机使用，不能配置为对外监听。
- 这是依赖桌面端内部接口的本地适配，不是厂商公开、稳定的集成协议。升级客户端后重新验收。

## 当前验收

- WorkBuddy 5.9.2：Relay Action → `wb.conversations.get(...).runPrompt(...)` → Relay 结果回传通过。
- ZCode 3.16.3：通过桌面现有 MessagePort 服务代理调用 v4 `createTask`、`sendPrompt`、`readSession`，回传通过。没有启动额外 app-server，也没有读取或传送模型凭据。
- 两轮均要求模型原样返回本次随机标识与计算结果，Relay 回执 `output.ok=true`。没有鼠标、键盘、DOM 操作。
- 2026-11-01：两端重启后复用原专用会话，通过已安装 Markdown 任务入口的完整实机往返。11 项单元测试通过；详细调用 ID 与故障修复见 `ACCEPTANCE.md`。
- 2026-11-03：Factory 1.2.0 经 `electronAPI.daemon` → 桌面已启动的 Droid daemon，通过 Relay 算术探针和同会话 Markdown 任务往返。17 项单元测试通过。
- `run.mjs` 是按次运行的本地适配器，运行期间处理自身发起的调用；尚未提供常驻收件服务。

本机入口（需安装目录内已有 `lib/relay.mjs`、SDK 和受限工作区凭据文件）：

```powershell
node scripts/desktop-relay/run.mjs workbuddy D:\Programs\AgentRelay
node scripts/desktop-relay/run.mjs zcode D:\Programs\AgentRelay
node scripts/desktop-relay/run.mjs factory D:\Programs\AgentRelay
```

每次执行会调用真实桌面模型。会话绑定保存在安装目录的 `data/desktop-native.sessions.json`；验收回执位于 `reports/*-desktop-native-via-relay.json`。专用工作目录为 `D:\Programs\AgentRelay\desktop-workspace`。

## 本机安装入口

源文件复制到 `D:\Programs\AgentRelay\desktop-native\`，两个 PowerShell 入口放在 `D:\Programs\AgentRelay\`：

```powershell
# 检查端口；仅在应用未运行时按带端口参数启动，不强制终止现有应用。
& D:\Programs\AgentRelay\Start-DesktopApi.ps1
# Factory 单独检查/启动；自动选择本机已安装的最高版本。默认入口仍检查 WorkBuddy、ZCode。
& D:\Programs\AgentRelay\Start-DesktopApi.ps1 -Client factory
# 不传 TaskFile 时执行就绪检查；传入时原样发送 Markdown 正文。
& D:\Programs\AgentRelay\Invoke-DesktopTask.ps1 -Client workbuddy -TaskFile D:\Tasks\任务.md
& D:\Programs\AgentRelay\Invoke-DesktopTask.ps1 -Client zcode -TaskFile D:\Tasks\任务.md
& D:\Programs\AgentRelay\Invoke-DesktopTask.ps1 -Client factory -TaskFile D:\Tasks\任务.md
```

普通任务超时为 30 分钟，就绪检查为 3 分钟。普通任务的 `ok=true` 表示桌面原生接口报告本轮完成并返回非空回答，不代表代码、构建、部署结果已经独立验收。任务中的审批仍由客户端处理，本适配不授予完全访问权限。

Factory 新建专用会话使用 `autonomyLevel=off`，并自动拒绝权限请求；本轮只验收无需工具的模型回复。需要审批的实际任务可能因此失败，不能据此声称已支持无人值守的文件编辑或命令执行。适配使用桌面登录态：登录令牌只在 Factory renderer 内经原生认证接口交给自带 daemon，不返回 Node、不进入 Relay 或回执。协议版本按 Factory 1.2.0 的 `1.291.0` 验证。完成判定使用当前会话和消息 UUID 对应的 `get_session_turn_outcome`，不会拿历史回答充当本次结果。

Factory 自动更新可能自行重启并丢失调试参数。若应用仍在运行但接口关闭，启动脚本会停止并提示，不自动结束应用；需先自行退出或另行授权重启。

每次调用另存带 UUID 的独立回执；提交前后记录阶段，断线或超时时报告未确认，不自动重发任务。每端使用进程锁，避免本地适配同时投递；异常终止后若残留锁文件，需要先确认原进程已退出，再删除对应的 `data/desktop-native-<client>.lock`。

任务入口的临时目录会在退出时清理。由启动入口拉起的桌面程序需要保留运行临时目录，路径和 PID 记在 `data/desktop-host-<pid>.json`；应在该应用及其子进程退出后核验并清理该目录。应用会话与日志沿用用户已授权的 C 盘保存例外。

ZCode 适配依赖 3.16.3 的模块文件名、服务注册表和协议。版本不匹配时应停止并重新适配，不应回退 UI 自动化。CDP 模块作用域检查仅用来取得已经连接的服务代理，任务操作由桌面后台原生服务执行。

## 测试

```powershell
$env:TEMP='D:\CodexTemp\your-task'
$env:TMP=$env:TEMP
$env:TMPDIR=$env:TEMP
node --test scripts/desktop-relay/cdp.test.mjs scripts/desktop-relay/native-clients.test.mjs scripts/desktop-relay/task.test.mjs scripts/desktop-relay/factory.test.mjs
```

运行临时目录必须实际存在。连接凭据、浏览器页面 URL 中的种子和令牌不应进入日志或 Git。Relay 的工作区密钥与 Agent token 仅由本地进程读取，不能放入 CDP 表达式或发送给桌面 Agent。
