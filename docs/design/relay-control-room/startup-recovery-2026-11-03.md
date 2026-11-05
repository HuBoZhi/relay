# Relay 桌面启动恢复

用户于 2026-11-03 授权：登录启动后检查三个桌面客户端，接口未开则自动重启；调用前同样检查并恢复接收任务的客户端。接口就绪不代表模型调用成功。

## Windows PowerShell 兼容

- 查询参数曾被 .NET Framework 算入 file URL 路径，误报端口冲突；解析前去掉查询与片段。
- 回归测试在真正的 Windows PowerShell 5.1 下先失败，修复后通过。
- 已安装脚本在 5.1 下实际检查 ZCode、WorkBuddy、Factory，三者均 ready，未重启。
- 原始安装脚本备份：`D:\Programs\AgentRelay\data\recovery-install-backup-20261103-01`。
- 使用独立功能分支与 worktree，未修改用户已有的网页改动。
- Trail 无法新建记录：当前已有其他任务的活动轨迹 `traj_ynyux9pee7x7`；保留该轨迹，本文件作为本次工作的独立记录。

## 自动恢复与技能更新

- 新增 `Ensure-RelayClient.ps1`，复用接口就绪的客户端；运行中未开接口时默认等待 15 秒，随后只重启一次，最多等 45 秒验证接口；未运行则直接启动。
- 当前 Windows 会话和确切安装路径共同限定结束进程的范围。先关闭窗口，再强制结束仍在运行的匹配进程。互斥锁避免并行恢复；自身宿主返回 `self_restart_required`。
- `Start-RelaySystem.ps1` 仍由既有 HKCU Run `RelayControlRoom` 登录入口执行，现改为对三个客户端调用恢复脚本。无需 Codex 定时会话，不新增重复启动项。这是每次登录检查，不是跨日或全天轮询。
- `Invoke-RelayAgent.ps1` 和 `Invoke-DesktopTask.ps1` 在提交 Node 任务前执行恢复检查；前者使用 .NET UTF8Encoding 写入无 BOM JSON，兼容 Windows PowerShell 5.1。
- 已更新共享正文 `D:\codex\skills\relay-agent-connect\SKILL.md`，明确用户的自动重启授权、登录和委派前的恢复、当前调用宿主保护、最多一次恢复及提交后不自动重发任务。旧正文在同一安装备份目录保留。
- 用户随后明确确认：“调用方”指接收任务的目标客户端（ZCode、WorkBuddy、Factory）。自动重启范围不包括发出任务的程序；现有实现与该确认一致。
- 端口被其他应用占用、内部模块不兼容、模型或登录错误均不会触发盲目重启循环。此版本没有修复 ZCode 的 `service module scopes unavailable`，不声称已完成端到端模型调用验收。

## 验证与安装

- `node --test packages/control-room-desktop/tests/relay-recovery.node-test.mjs`：10/10 通过，测试使用真正的 Windows PowerShell 5.1，进程关闭/启动使用受控替身，未中断用户客户端。
- 行为覆盖：带查询的 URL、健康复用、只重启匹配的客户端、未运行则启动、未知端口不重启、恢复失败不循环、启动宽限期、保护自身宿主、委派前检查与无 BOM 请求、开机入口检查全部三个客户端。
- 已将五个脚本安装到 `D:\Programs\AgentRelay`；旧版脚本与技能备份在 `data\recovery-install-backup-20261103-01`，没有重新配置用户快捷方式或启动项。
- 实际用 Windows PowerShell 5.1 执行已安装 `Start-RelaySystem.ps1`：三个客户端均 `action=reused`、`state=ready`、`validation=desktop-interface-only`，控制台健康检查通过。无需为验收故意重启当前客户端。
- 登录入口已核对仍指向该脚本。并未执行 Windows 注销或重启，因此下次登录的系统触发尚未现场观察；同一个实际入口已经运行通过。
- 本次临时目录：`D:\CodexTemp\relay-auto-recovery-20261103-01`；每个测试自己的夹具目录均已由 finally 清理。最后清理任务根目录时，自动审批拒绝了带路径核验的删除命令；再次只使用已核验固定绝对路径的 `Remove-Item -LiteralPath ... -Recurse -Force` 仍被拒绝，理由为 `blocked by policy`。根目录及其 Node 编译缓存暂保留，无本次后台任务占用；未改用其他删除工具绕过。正式源代码和记录保留在功能分支 worktree。
