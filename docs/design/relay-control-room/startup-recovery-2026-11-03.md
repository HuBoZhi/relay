# Relay 桌面启动恢复

用户于 2026-11-03 授权：登录启动后检查三个桌面客户端，接口未开则自动重启；调用前同样检查并恢复接收任务的客户端。接口就绪不代表模型调用成功。

## Windows PowerShell 兼容

- 查询参数曾被 .NET Framework 算入 file URL 路径，误报端口冲突；解析前去掉查询与片段。
- 回归测试在真正的 Windows PowerShell 5.1 下先失败，修复后通过。
- 已安装脚本在 5.1 下实际检查 ZCode、WorkBuddy、Factory，三者均 ready，未重启。
- 原始安装脚本备份：`D:\Programs\AgentRelay\data\recovery-install-backup-20261103-01`。
- 使用独立功能分支与 worktree，未修改用户已有的网页改动。
- Trail 无法新建记录：当前已有其他任务的活动轨迹 `traj_ynyux9pee7x7`；保留该轨迹，本文件作为本次工作的独立记录。
