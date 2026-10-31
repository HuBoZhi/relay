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

- WorkBuddy 5.9.2：已通过 SDK 创建本地专用会话，返回有效会话 ID。
- ZCode 3.16.3：已连接桌面 renderer，尚在确认任务服务代理。
- Relay 下发、桌面模型执行、结果回传的完整链路尚未验收。

## 测试

```powershell
$env:TEMP='D:\CodexTemp\your-task'
$env:TMP=$env:TEMP
$env:TMPDIR=$env:TEMP
node --test scripts/desktop-relay/cdp.test.mjs
```

运行临时目录必须实际存在。连接凭据、浏览器页面 URL 中的种子和令牌不应进入日志或 Git。Relay 的工作区密钥与 Agent token 仅由本地进程读取，不能放入 CDP 表达式或发送给桌面 Agent。
