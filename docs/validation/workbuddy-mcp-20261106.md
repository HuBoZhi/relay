# WorkBuddy MCP 检索与真实桌面对话验证

核查日期：2026-11-06。

## 结论

本机可以通过自建的 stdio MCP 包装器与正在运行的 WorkBuddy 桌面模型通信，已获得真实模型回复。没有发现官方公开的反向桌面 MCP 任务入口。本次不是验证 WorkBuddy 原生 MCP 服务端，而是验证 `MCP → 现有 CDP Runtime / wb.conversations 桌面 IPC → WorkBuddy 模型 → MCP` 的可行性。

没有运行替代模型 CLI，没有导出或解密登录凭据，没有修改全局 MCP 配置，也没有将该实验接入 Relay 群聊默认路由。

## 全网检索的方案差异

| 来源 | 实际方向或实现 | 本次判断 |
| --- | --- | --- |
| [WorkBuddy 官方 MCP 指南](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide) | WorkBuddy 作为客户端调用外部工具 | 不证明其他 Agent 能直接调用桌面 WorkBuddy |
| [官方 Connector 文档](https://open.workbuddy.cn/docs/connector) | 将第三方 MCP/CLI 接入 WorkBuddy | 同上 |
| [LinHaiJ/workbuddy-mcp](https://github.com/LinHaiJ/workbuddy-mcp) | MCP 包装 `codebuddy` CLI；README 说明不要求桌面运行，会话可能不出现在桌面历史 | 不是桌面会话调用；本机 PATH 未发现 codebuddy |
| [ZhaoXiangyu99/workbuddy-mcp](https://github.com/ZhaoXiangyu99/workbuddy-mcp) | 打开应用、共享收件箱和剪贴板交接 | README 表明尚非自动任务提交与结果返回 |
| [hanhan1223/workbuddy-bridge](https://github.com/hanhan1223/workbuddy-bridge) | 读取/解密桌面凭据，转换为模型 HTTP/MCP 调用 | 未运行此方案；与桌面 Agent 执行会话不同 |
| [ggq-eng/workbuddy-mcp-server](https://github.com/ggq-eng/workbuddy-mcp-server) | 将业务能力封装为 MCP 给其他客户端调用 | 不等同于桌面 WorkBuddy 模型服务端 |

检索覆盖官方文档、GitHub 实现以及社区教程。上述“没有发现”是本次检索结论，不声称所有私有实现均不存在。内部接口可能随版本变动。

## 本机实测

可重复执行的入口：`scripts/desktop-relay/probe-workbuddy-mcp.mjs`。

- 默认只完成 MCP initialize、tools/list 和 `workbuddy_check`，不创建模型会话。
- 加 `--ask` 才调用 `workbuddy_echo`，新建独立测试会话，向模型发送固定的无工具回显提示词。
- 一次性等待桌面原生 runPrompt Promise，无循环查收、无自动重试。单次桌面调用上限 120 秒；超时不能冒充失败或重新提交。
- 使用仓库已有 MCP SDK 与桌面连接器，不安装第三方检索到的代码。

测试结果：

| 项目 | 证据 |
| --- | --- |
| MCP Server | relay-workbuddy-desktop-probe 0.1.0 |
| tools/list | workbuddy_check、workbuddy_echo |
| 桌面接口 | ready=true，live-desktop，127.0.0.1:19371 |
| 独立工作区 | D:/Programs/AgentRelay/test-workspace/workbuddy-mcp |
| 会话 ID | b9e6d2a3-4a9a-40fd-b53c-87b7cfa5c168 |
| 原生请求 ID | 01a1b131f03c7413a2379f798d85b6bb |
| 结束状态 | completed |
| 实际回复 | WORKBUDDY_MCP_OK de364e79-fe79-43ca-a63f-ba23c180800e |

随机标识与发送值完全一致，整次进程约 6.9 秒退出，返回码 0。仅证明本机当前版本的单轮桌面 MCP 桥接对话成功，不代表模型覆盖、项目枚举、续聊、权限或生产级异步回传已验收。

PowerShell 复现时先将 TEMP、TMP、TMPDIR 设置为独立 D 盘临时目录，再运行：

```powershell
node G:/Coding/Github/relay/scripts/desktop-relay/probe-workbuddy-mcp.mjs
# 仅在需要再次发送真实测试时：
node G:/Coding/Github/relay/scripts/desktop-relay/probe-workbuddy-mcp.mjs --ask
```

WorkBuddy 自身的会话与日志沿用已有桌面数据目录，属于此前已授权的客户端运行数据；任务执行工作区与脚本均在 D/G 盘。测试会话保留用于核查。本次为内部诊断脚本，不写根用户发布日志。
