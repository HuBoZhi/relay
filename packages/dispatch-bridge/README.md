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
- 只用客户端 Runtime 级接口：不模拟键鼠、不操作 DOM、不读取模型凭据、不启动独立 CLI。
- 客户端调试端口需要客户端以 `--remote-debugging-port` 启动；重启客户端需用户授权。
- Factory 适配器的工作区在其自身代码里固定；桥接遇到其他项目会如实返回失败原因，不改道。
- 「原聊天主动注入」未验证：`/deliver` 一律返回 `manual`，界面显示「需人工处理」。

## 探测（不改动任何状态）

```bash
curl -X POST http://127.0.0.1:7901/probe -H "Content-Type: application/json" -d '{"client":"workbuddy"}'
```

返回 `{ ok, interfaceReady, version, notes, error }`。只读：不创建会话、不发提示词。

## 测试

```bash
npx vitest run packages/dispatch-bridge
```

12 条桥接测试 + 1 条端到端测试（群聊 → 引擎 → 桥接 → 假客户端 → 结果回到群里）。
