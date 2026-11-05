---
name: relay-agent-connect
description: 通过本机 Agent Relay 在 ZCode、WorkBuddy、Factory 桌面模型及 Codex/ZCode 接力成员之间发送任务、接续会话和读取结果。用于用户要求跨 Agent 互通、指定桌面模型与项目、排查 Relay 接口或配置启动即用。
---

# Relay Agent 互通

这是跨 Agent 可读的本机技能；调用方只需能读文件并运行 PowerShell/Node，无须本身是 Codex。运行安装位于 `D:\Programs\AgentRelay`。模型凭据由对应客户端使用，不复制到 Relay、提示词或日志。

技能的唯一正文位于 `D:\codex\skills\relay-agent-connect\SKILL.md`，常见 Agent 的用户技能目录通过 junction 共用它。新启动的 Agent 会发现该技能；已运行会话按各客户端的技能刷新方式重新加载，不能保证已缓存的清单即时更新。重新安装入口为源码目录的 `scripts\desktop-relay\Install-RelaySkill.ps1`，它不创建新 Relay 工作区，也不覆盖其他软件的技能。

## 桌面端任务入口

1. 执行接口检查：
   ```powershell
   & D:\Programs\AgentRelay\Configure-RelayStartup.ps1 -Action Check
   ```
   `ready` 时直接调用，不重启。`stopped` 时用 `-Action Start -Client zcode`、`workbuddy` 或 `factory` 启动。`restart_needed` 表示当前进程启动时未开接口：先确认没有进行中的任务，再经用户授权重启一次。不要对每次调用重启客户端。
2. 确认用户指定的项目绝对路径，准备 Markdown 任务文件。将任务原样写入文件；例子中的 MediaDock 不是其他任务的默认项目。Factory 使用下述独立入口，当前仅支持固定的专用工作区。
3. ZCode 指定桌面模型的 providerId、modelId 和 reasoningLevel。可以只读 `~/.zcode/v2/provider_config.json` 提取模型标识（勿打印含密钥的整个配置），或通过桌面会话 `readSession` 查看可选模型。不要凭提供商名称猜 UUID。已验证的本机 DeepSeek：
   ```powershell
   & D:\Programs\AgentRelay\Invoke-RelayAgent.ps1 -Client zcode `
     -Project G:\Coding\Gitee\MediaDock -TaskFile D:\Tasks\任务.md `
     -ProviderId 8b5c921c-af00-4f4f-ac46-613a190bece4 `
     -ModelId deepseek-flash -ReasoningLevel max
   ```
   DeepSeek 的 reasoningLevel 是必填项。WorkBuddy 使用桌面默认模型：
   ```powershell
   & D:\Programs\AgentRelay\Invoke-RelayAgent.ps1 -Client workbuddy `
     -Project G:\Coding\Gitee\MediaDock -TaskFile D:\Tasks\任务.md
   ```
4. 同一客户端、项目和模型默认接续独立的 Relay 会话；`-NewSession` 开新会话，`-SessionId` 接续明确指定的会话，两者互斥。不会接管任意正在运行的用户会话。WorkBuddy 的模型覆盖尚未实现，不要声称已选指定模型。
5. 必须检查回执的 `output.ok`、`state`、`response`；`relayStatus=completed` 只证明回执已送达。代码修改、部署等仍需独立验收。回执位于 `D:\Programs\AgentRelay\reports\zcode-desktop-native-via-relay.json` 或 `workbuddy-desktop-native-via-relay.json`，并另存带 UUID 的记录。多次调用取对应 invocationId，不以“最新文件”混认其他调用。

实际链路：调用方 → Relay Action → 本机按次运行的适配器 → CDP → 真实桌面 IPC/SDK → 桌面模型 → Relay 回执。没有启动替代模型 CLI，没有模拟键盘鼠标。适配器不是常驻服务；不能在它退出后单独调用 Action 并假设桌面会接单。

## Factory 桌面端

Factory 1.2.0 已通过 CDP → `electronAPI.daemon` → 原生 IPC 调用其桌面自带的 Droid daemon；专用会话、无工具探针和 Markdown 任务的下发/结果回传已验收。使用已安装入口：

```powershell
& D:\Programs\AgentRelay\Invoke-DesktopTask.ps1 -Client factory -TaskFile D:\Tasks\任务.md
```

此入口不接受 `-Project` 或模型覆盖参数。工作区固定为 `D:\Programs\AgentRelay\desktop-workspace`，会话绑定在 `data\desktop-native.sessions.json` 的 `factory` 项，回执在 `reports\factory-desktop-native-via-relay.json` 并另存 UUID 记录。不要把 Factory 传给仅支持 ZCode/WorkBuddy 的 `Invoke-RelayAgent.ps1`。

Factory 的登录令牌只在 renderer 内经原生认证接口交给 daemon，不回传到 Node、Relay 或日志。完成判定必须匹配 sessionId 和当前消息 UUID 对应的 turnId。会话使用 `autonomyLevel=off`、自动拒绝权限请求；文件编辑、构建和需要工具审批的任务尚未验收，不调整这些设置来冒充通过。

## 多 Agent 接力

桌面端之间：分别使用上述入口，把 A 的已核对输出明确交给 B，保留 invocationId 和 sessionId，给出结束条件。被调用 Agent 也可读取本技能并使用相同入口，须在任务中明确授权转交对象、内容和次数。单个客户端一次仅接受一个调用；不要让正在被调用的 ZCode 同步调用自己并等自己回复。

已有隔离接力入口：`D:\Programs\AgentRelay\Start-Team.ps1`，成员和模型在 `agents.json`。它使用 Codex/ZCode 的独立 App Server，会经过 Relay 消息；目前仅验证无工具的计算和消息接力，不能当作正式开发执行入口。例：`@codex 计算 7*8，交给 zcode-developer 核对，核对后结束`。不要为此恢复已停用的旧 zcode-ops 配置。

若使用官方 Relay MCP，先注册身份，再用 send_dm/check_inbox/list_messages；未挂载 MCP 时用已安装的 `bin\agent-relay.ps1` 对应命令。发消息前确认目标有执行端；成员名或在线状态不能单独证明能调用模型。消息内容经过 Relay 托管服务，仅转交用户授权的材料。

## 启动和恢复

本机现在使用统一入口 `D:\Programs\AgentRelay\Start-RelaySystem.ps1`。它检查/启动三个桌面接口，再启动同一工作区的托盘控制台（网页 `http://127.0.0.1:4320`）；开机只有 `RelayControlRoom` 一个总入口。优先用此入口启动整套本机接入。运行状态见 `data\unified-system-status.json`，不要把“编辑器进程存在”当作接口已就绪。已运行但未开接口时如实报告需要重启，不擅自强制结束任务。

实际后台是持续运行的托管 Relaycast，控制台和适配器共享 `data\workspace.private.json`。当前官方 native broker 明确不支持 Windows；`agent-relay node status` 显示 stopped 不代表托管消息服务断开，不为此创建第二个工作区或绕过平台检查。`data\unified-startup.json` 启用时，接口配置脚本只更新快捷方式并保留总启动项，不重新添加三个独立 Run 项。

用户已于 2026-11-03 授权 ZCode/WorkBuddy 的 Relay 接入、全局技能与启动设置所需的 C 盘写入，随后明确要求把 Factory 接入和启动配置纳入同一技能。该授权不取消其他任务的 D 盘临时文件规则。客户端会话、日志和登录状态沿用各自目录；任务临时文件仍在 `D:\CodexTemp`。

`Configure-RelayStartup.ps1 -Action Configure` 配置三个客户端的开始菜单、现有桌面/任务栏快捷方式、当前用户登录启动项及 WorkBuddy 的端口环境变量；可用 `-Client factory` 仅配置 Factory。修改前的记录和快捷方式位于 `data\startup-backup-*\before.json`。仅修改目标确为对应应用的链接。系统级快捷方式无权限时创建/更新同名用户快捷方式。任务栏缓存或升级后重建的入口可能需重新固定/重新配置；直接运行不带参数的原始 exe 不保证开启接口。恢复时依据备份逐项还原，不覆盖其他软件的配置。

Factory 的快捷方式和登录启动项指向稳定的 `D:\Programs\AgentRelay\Start-RelayFactory.ps1` 启动器。它每次选择 `%LOCALAPPDATA%\Factory\app-<version>\factory-desktop.exe` 下最高的完整安装版本，显式携带端口和回环地址，不固定 app-1.2.0 路径。可用 `-ResolveOnly` 查看实际版本和参数，不启动应用。更新器自行重启应用或重建快捷方式仍可能丢失参数；发现端口关闭时检查状态并重新使用此启动器，必要时重新配置，不自动终止进行中的会话。

端口：WorkBuddy `127.0.0.1:19371`，ZCode `127.0.0.1:19372`，Factory `127.0.0.1:19373`。只允许本机监听。应用升级后先检查端点与协议；模块/版本不兼容就报告，不用猜测内部方法继续发任务。失败发生在任务提交后时，先检查原会话和 UUID 回执，不自动重发可能产生重复副作用的任务。客户端忙时等待或换独立会话，不终止它的现有任务。

运行脚本使用客户端锁；锁遗留时先查原进程是否仍在运行，再清理已失效的单个锁。桌面程序的临时目录可能需保留到客户端退出，路径和 PID 在 `data\desktop-host-*.json`；只清理自己创建且确认已无进程占用的目录。
