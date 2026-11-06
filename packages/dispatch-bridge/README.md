# 本机派发桥接（`@agent-relay/dispatch-bridge`）

把任务引擎的派发请求交给本机桌面客户端，并在**这一轮结束后**把结果回报给引擎。
引擎因此可以「提交即返回」，发送方结束本轮，不需要任何模型查收。

```
群聊 @ZCode ─► 引擎 /api/async/tasks ─► 桥接 /dispatch ─► 客户端原生接口
                                            │
                        轮次结束（桥接自己盯）│
                                            ▼
群里出现结果 ◄─ 引擎 /api/async/callbacks ◄──┘
```

## 职责边界

| 属于桥接                              | 不属于桥接                       |
| ------------------------------------- | -------------------------------- |
| 连接客户端、创建/复用会话、提交提示词 | 判断任务是否验收通过             |
| 盯本轮是否结束（唯一的轮询点）        | 任何模型调用或模型侧等待         |
| 把结果作为回调回报引擎                | 往原聊天注入消息（未实现，见下） |

轮询只发生在桥接里，且只读客户端原生状态；**模型从不参与等待**。

## 运行

```bash
node packages/dispatch-bridge/src/cli.mjs \
  --port 7901 \
  --engine http://127.0.0.1:4320 \
  --data "D:/RelayData/bridge" \
  --desktop-native "D:/Programs/AgentRelay/desktop-native"
```

启动后打印监听地址、引擎地址、适配器是否加载、数据目录。

### 参数

| 参数                      | 说明                                                                 |
| ------------------------- | -------------------------------------------------------------------- |
| `--port <端口>`           | 监听端口，默认 7900；只绑定回环地址                                  |
| `--engine <地址>`         | 任务引擎地址，必须是回环地址，默认 `http://127.0.0.1:4320`           |
| `--engine-token <令牌>`   | 引擎写接口设置了 `X-Relay-Async-Token` 时使用                        |
| `--desktop-native <目录>` | 客户端适配器目录（`cdp.mjs` / `native-clients.mjs` / `factory.mjs`） |
| `--data <目录>`           | 会话与在途记录目录，必须在非系统盘                                   |
| `--poll-ms <毫秒>`        | 轮次检查间隔，默认 2000（最小 250）                                  |
| `--timeout-ms <毫秒>`     | 单轮等待上限，默认 3600000                                           |

环境变量同名的 `RELAY_BRIDGE_*` / `RELAY_DESKTOP_NATIVE_DIR` 可以代替参数。

## 把它接进引擎

引擎与桌面 APP 都用同一个形式注册：

```bash
# CLI
node packages/control-room/dist/cli.js --tasks --bridge zcode=http://127.0.0.1:7901
```

桌面 APP 写在设置文件的 `bridges` 里（修改后重启 APP）：

```json
{
  "dataRoot": "D:\\RelayData\\async",
  "bridges": [{ "client": "zcode", "url": "http://127.0.0.1:7901" }]
}
```

注册后，群聊里 `@zcode` 的派活会返回真实 `sessionId`，群成员条显示该会话；
结果由桥接自动回报，群里出现结果气泡。未注册时任务停在「已排队」并写明原因。

## 接口

### ZCode MCP 连接

桌面程序「设置与数据 → ZCode 连接方式」可选择 `zcode-mcp（MCP）` 并指定配置文件。
CLI 使用 `--zcode-mcp-config D:/Programs/AgentRelay/zcode-mcp/relay-config.json`。
未配置时仍使用现有桌面连接；MCP 失败不会自动改道或重复发送任务。

配置为普通 stdio MCP 启动配置，例如：

```json
{
  "command": "C:/Program Files/nodejs/node.exe",
  "args": ["D:/Programs/AgentRelay/zcode-mcp/dist/index.js"],
  "cwd": "D:/Programs/AgentRelay/zcode-mcp",
  "mode": "build",
  "env": {
    "ZCODE_BIN": "C:/Program Files/ZCode/resources/glm/zcode.cjs",
    "ZCODE_MCP_STATE_DIR": "D:/Programs/AgentRelay/zcode-mcp/runtime",
    "ZCODE_DATA_BASE_DIR": "D:/Programs/AgentRelay/zcode-mcp/runtime",
    "ZCODE_STORAGE_DIR": "D:/Programs/AgentRelay/zcode-mcp/runtime/storage",
    "ZCODE_LOG_DIR": "D:/Programs/AgentRelay/zcode-mcp/runtime/logs"
  }
}
```

使用 [TechYan/zcode_mcp](https://github.com/TechYan/zcode_mcp) 0.2.0。
Windows 部署需先运行 `node packages/dispatch-bridge/scripts/patch-zcode-mcp-windows.mjs <上游源码目录>`，
再在该目录运行 `npm ci --ignore-scripts` 与 `npm run build`。补丁处理 Windows 绝对路径、隐藏子进程、
无符号链接启动、隔离目录、会话续接及当前 Worker 的 Provider revision；上游源码与 MIT 许可保留在安装目录。
`ZCODE_PROVIDER` 可指定本机已登录的套餐，`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 可指向现有提供方配置（只读）。
不复制模型密钥、不更改用户 ZCode 配置；临时、状态和缓存使用非 C 盘目录。

`mode` 默认 `build`，也可设 `plan` 等上游支持的模式。权限确认被无头服务拒绝时会回报阻塞，
不会自动升级为 `yolo`。`zcode_check` 会创建探测会话；上游未提供项目枚举工具，项目目录需手填。

`zcode_run` 在整轮结束后才返回真实会话编号，初始回执因此为 `accepted`（MCP 已受理），
不是 `delivered`。桥接独立跟踪结果，返回后登记真实会话并自动回传到原群聊。
断线和超时保留为未确认，不冒充完成，不自动重发。`zcode_sessions` 所列的 `sess_...` 可用于继续会话。

| 接口             | 说明                                              |
| ---------------- | ------------------------------------------------- |
| `GET /health`    | 适配器状态、各客户端端口、在途记录                |
| `GET /runs`      | 在途/待确认记录（含原因）                         |
| `POST /probe`    | 只读探测：`{ client }` 返回单个，`{}` 返回三个    |
| `POST /dispatch` | 派发：创建/复用会话并提交提示词，受理后立即返回   |
| `POST /deliver`  | 固定返回 `manual`：原聊天注入尚未实现，不冒充成功 |

`/dispatch` 响应 `{ status: 'delivered', sessionId, projectId, workspacePath, modelId, nativeTurnId }`；
客户端忙、适配器缺失或项目不一致时返回 `queued` / `failed` 与中文原因。

## 结果判定

| 客户端状态           | 回报        | 说明                                                 |
| -------------------- | ----------- | ---------------------------------------------------- |
| `completed`          | `completed` | 本轮结束且有文本；不是「需求已验收」                 |
| `cancelled`          | `blocked`   | 中断不算完成                                         |
| `error` + 待确认请求 | `blocked`   | 摘要带 `perm_*`，界面显示等待确认                    |
| 其他错误             | `failed`    | 带客户端原因                                         |
| 超时                 | 不回报      | 记录为 `unconfirmed`，留待人工核验，**不重发提示词** |

回报带 `idempotencyKey: bridge:<taskId>:<stageId>:<runId>`，重复回报只算一次。

## 安全与限制

- 只监听回环地址；`POST` 要求 JSON 且拒绝跨站来源。
- 桌面方式只用客户端 Runtime 级接口；MCP 方式通过 stdio 服务启动独立的 ZCode app-server。桥接不模拟键鼠、不操作 DOM、不读取模型凭据。
- 客户端调试端口需要客户端以 `--remote-debugging-port` 启动；重启客户端需用户授权。
- Factory 适配器的工作区在其自身代码里固定；桥接遇到其他项目会如实返回失败原因，不改道。
- 「原聊天主动注入」未验证：`/deliver` 一律返回 `manual`，界面显示「需人工处理」。

## 探测

```bash
curl -X POST http://127.0.0.1:7901/probe -H "Content-Type: application/json" -d '{"client":"workbuddy"}'
```

返回 `{ ok, interfaceReady, version, notes, error }`。桌面方式只读；ZCode MCP 的 `zcode_check` 会创建探测会话，不发送模型提示词。

## 测试

```bash
npx vitest run packages/dispatch-bridge
```

12 条桥接测试 + 1 条端到端测试（群聊 → 引擎 → 桥接 → 假客户端 → 结果回到群里）。
