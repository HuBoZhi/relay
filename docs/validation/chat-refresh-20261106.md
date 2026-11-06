# 群聊回传自动刷新修复

日期：2026-11-06。

## 原因与修复

派发桥的回调将结果写入群聊，但发送的是 `callback.delivered`，群聊页面只处理 `group.*` 事件，因此留在群聊时无法显示新结果，重新进入页面后才能看到。

- 群聊订阅同时处理 callback、stage、task 状态事件，刷新消息、列表与在途计数。
- SSE 初次连接和重连时同步，补回订阅空档期间的变化。
- 刷新期间收到的新刷新请求保留到下一轮，避免较旧响应覆盖新回传后不再更新。

## 验证

- 先添加 DOM 回归测试，原代码未显示桥接回传，测试失败；修复后通过。
- 控制台与桌面端 21 个测试文件、203 项测试通过；其中群聊 16 项测试通过。
- 两项真实浏览器布局与导航验收通过，检查草稿与阅读位置保持。
- 桌面 TypeScript 编译、服务与桥接打包通过。打包器首次在线获取 Electron 失败，改用工作区已有 Electron 33.4.11 后离线打包成功。
- 此次为网页行为修复，按仓库规则不写根发布日志。

## 本机部署

- 构建：`packages/control-room-desktop/release/20261106-chat-refresh/win-unpacked`。
- 更新 `D:/Programs/RelaySystem` 的 exe 与 ASAR，正常退出后替换，再按原参数启动。
- 回滚备份：`D:/Programs/AgentRelay/data/chat-refresh-backup-20261106`。
- 已安装 ASAR 与构建一致，SHA-256：`6782799F2662CC45C3DA6A44BD75C6D2B20055F17FAE6F1F4EABD6259FFE3473`。
- 部署前后均为 5 个任务、0 个执行中、0 个待回传、1 个历史失败；设置文件哈希不变。
- 健康检查通过，HTTP 返回的 chat.js 含本次事件处理与并发刷新修复。未派发真实模型任务验证，自动刷新行为由 DOM 回归测试覆盖。
- 正式构建与回滚备份保留；没有发布远程版本或 npm 包。

原有活动 trajectory 属于其他任务，本次使用独立目录 `.agentworkforce/trajectories/chat-refresh-20261106` 记录。
