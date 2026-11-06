# Relay Windows 重新打包与部署

日期：2026-11-06。源码：`50482f50d`，分支 `codex/hubozhi-dev`，应用版本 14.0.0。

## 产物

目录：`packages/control-room-desktop/release/20261106-mcp/`。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| RelaySystem-14.0.0-安装包.exe | 74859925 | 47A78FFD98A93E18173C78EF4AE484DA62435AD22C81E3D9788D67A122B46B55 |
| RelaySystem-14.0.0-便携版.exe | 74644352 | B31CB9395114E64AAEA8C284342A39AA3F50882F499567B69FD4583BDC86FA18 |

重新编译控制中心并打包 Windows x64 NSIS 安装包和便携版。复用已有 Electron 33.4.11 运行时，构建与缓存均位于非 C 盘。未使用代码签名证书，未上传 GitHub Release。

## 部署与验证

- 已将新 `win-unpacked` 运行时及 `resources/app.asar` 部署到 `D:\Programs\RelaySystem`。
- 旧程序资源和运行时备份：`D:\Programs\AgentRelay\data\repackage-backup-20261106-2018`。
- 保留现有数据、MCP 设置、快捷方式和登录启动项。无需运行会改写 C 盘快捷方式的安装脚本。
- ASAR 内容检查确认包含 `zcodeTransport` 设置和 `zcode_run` 桥接。
- 部署后的 ASAR 与打包产物 SHA-256 一致：`8F9EEE48056E580237E9E26E3139CF2AD9A435C2E82D4D33B944ECF7EE8D1F24`。
- 应用 `/api/health` 返回 `ok=true, mode=live, target=relaycast`。
- 桥接 `/health` 返回 `zcode.transport=mcp, port=null`。
- 真实 MCP `/probe` 成功，模型查询返回 GLM-5.3、GLM-5.3-Flash。未发送真实模型任务提示词。
- Windows 窗口清单确认 Relay「群聊」窗口已恢复。
- MCP 是本机已有的外部 stdio 服务，其运行目录仍为 `D:\Programs\AgentRelay\zcode-mcp`，无需随本次应用更新重装。
