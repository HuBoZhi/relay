# 异步任务契约

适用代码：`packages/control-room`（`src/async/*`）、`packages/control-room-desktop`。
本文件描述 APP 内部任务引擎对外承诺的接口、事件、路由与持久化语义。

## 1. 边界

- 引擎负责：受理任务、持久化、派发一次、接收回传、路由到原聊天、阶段链、幂等与恢复。
- 引擎不负责：驱动具体的桌面客户端。客户端接入在**派发桥接**后面（见第 8 节），
  桥接不在线时任务停在「已排队」，不会被悄悄改投其他客户端或模型。
- 引擎不用定时器查询任何会话状态。所有状态推进来自：提交回执、桥接回报、接收方回传、用户操作。

## 2. 数据契约

| 对象 | 字段 | 说明 |
| --- | --- | --- |
| 主题 Topic | `id` `name` `slug` `channel` `createdAt` | `name` 是用户输入（可含中文、日期），`slug` 是 ASCII 映射；同一 `name` 复用同一主题 |
| 任务 Task | `id` `topicId` `title` `body` `authorization` `origin` `correlationId` `stageIds` `runIds` `callbackIds` `messageIds` `status` `cancelled` | `origin` 是回传目标聊天的绑定 |
| 阶段 Stage | `id` `taskId` `index` `kind` `label` `dependsOn` `client` `project` `session` `model` `completion` `callback` `queueIfUnavailable` `runIds` `status` | `project` = `{ id, path }`；`model` = `{ account, provider, modelId, reasoning }` |
| 执行实例 Run | `id` `attempt` `requestedModel` `actual` `status` `queuedReason` `lastError` `messageId` | `actual` 由桥接回报，未回报时为 `null` |
| 消息 Message | `id` `topicId` `taskId` `stageId` `runId` `correlationId` `causationId` `idempotencyKey` `sender` `route` `kind` `summary` `createdAt` | 时间线的唯一来源 |
| 回传 Callback | `id` `taskId` `stageId` `runId` `messageId` `outcome` `summary` `evidence` `limits` `dedupeKey` `duplicate` `delivery` | `delivery` = `{ state, attempts, lastAttemptAt, deliveredAt, reason, triggeredStageId }` |

约束：

- 显示名称不是关联键。所有关联只用稳定 ID。
- 模型、账户、思考强度是结构化参数，不接受「写进提示词」。
- `project.path` 比较前规范化大小写、分隔符与尾部分隔符；同一物理目录复用同一 `project.id`。

## 3. 状态分层

四层彼此独立，任何一层都不能推出另一层：

| 层 | 取值 | 不能推出 |
| --- | --- | --- |
| 传输 `transport` | `local-saved` `relay-received` `delivering` `target-received` `delivery-failed` | 任务完成 |
| 执行 `execution` | `awaiting-dependency` `queued` `accepted` `running` `awaiting-confirmation` `blocked` `interrupted` `failed` `turn-ended` `unknown` | 需求已验收 |
| 业务 `business` | `unconfirmed` `developed` `reviewed` `accepted` `rejected` `cancelled` | 原聊天已处理回传 |
| 回传 `callback` | `pending` `queued-in-chat` `in-chat` `awaiting-host` `handled` `manual` | 下一阶段已启动 |

每个状态带 `at`（事件时间）与 `source`（证据来源），例如 `adapter.dispatch`、`callback:cb_…`。

映射规则：

- 客户端原生 `pending permission` → `awaiting-confirmation`，不显示「执行中」。
- 有中断标记 → `interrupted`，不能因「空闲 + 有文本」判完成。
- 原生轮次结束 `turn-ended` 只说明本轮结束；没有回传时业务层保持 `unconfirmed`。
- 回传投递失败或没有可用通道 → `manual`，界面显示「需人工处理」。

## 4. 接口

所有接口在 APP 自己的回环端口上，与观察台同源。`POST` 必须是 `application/json`，
带 `Origin` 时必须与请求 Host 同源。

### 4.1 提交任务

```http
POST /api/async/tasks
```

请求（节选）：

```json
{
  "idempotencyKey": "chat_original_7:20261104-1",
  "topic": { "name": "20261104-MediaDock-需求开发2" },
  "title": "实现内容主题替换",
  "body": "……",
  "authorization": { "scopes": ["develop", "review"], "allowChain": true },
  "origin": {
    "app": "codex",
    "device": "desktop-01",
    "chatId": "chat_original_7",
    "senderId": "agent_original",
    "workflowIds": ["wf_dev_review"]
  },
  "stages": [
    {
      "kind": "develop",
      "client": "zcode",
      "project": { "id": "proj_mediadock", "path": "D:\\Work\\MediaDock" },
      "session": { "policy": "new", "sessionId": null },
      "model": { "account": "BigModel", "provider": "zhipu", "modelId": "GLM-5.3-Flash", "reasoning": "max" },
      "completion": { "condition": "开发完成且测试通过", "requiresEvidence": true },
      "queueIfUnavailable": true
    },
    { "kind": "review", "dependsOn": ["#0"], "client": "zcode", "...": "…" }
  ]
}
```

响应 `202`：

```json
{
  "taskId": "task_…", "stageId": "stg_…", "runId": "run_…", "messageId": "msg_…",
  "topicId": "top_…", "topicName": "20261104-MediaDock-需求开发2", "topicSlug": "20261104-mediadock-2",
  "phase": "queued",
  "client": "zcode",
  "sessionId": null,
  "projectId": "proj_mediadock",
  "model": { "requested": { }, "actual": null },
  "reason": "未接入「zcode」的派发通道，任务已排队",
  "status": { "transport": {}, "execution": {}, "business": {}, "callback": {} },
  "acceptedAt": "2026-11-04T07:00:00.000Z",
  "idempotent": false
}
```

- `phase`：`queued` = 仅本地持久化；`delivered` = 目标客户端已受理提示词。二者都不代表任务完成。
- 返回时机：目标就绪时在派发完成后返回；目标不可用时立即返回 `queued` 与原因。接口**不等待**模型生成。
- 相同 `idempotencyKey`（或缺省时相同请求体）返回同一组 ID，`idempotent=true`，不会重复派发。

错误：

| 状态 | 含义 |
| --- | --- |
| `400` | 校验失败，`issues[]` 指明字段路径（如 `stages[0].project.path`） |
| `403` | 跨站来源 |
| `404` | 任务/阶段/回传不存在 |
| `413` | 请求体超过 256 KB |
| `415` | 非 JSON 请求体 |

### 4.2 接收回传

```http
POST /api/async/callbacks
```

```json
{
  "taskId": "task_…", "stageId": "stg_…", "runId": "run_…",
  "outcome": "completed",
  "summary": "开发完成，npm test 通过",
  "evidence": { "commit": "abc123", "tests": ["npm test"], "sessionId": "session_…" },
  "limits": []
}
```

响应 `202` 为 `CallbackReceipt`：`recorded`（首次记录为 `true`，重放为 `false`）、
`delivery`（回传投递状态）、`continuedStageId`（本次触发的后续阶段）。

- 相同 `dedupeKey`（`idempotencyKey` 或语义哈希）只产生一条回传、一次有效处理。
- 同一 `runId` 的第二条不同回传会被记录为 `duplicate`，不触发后续阶段。
- 任务已取消时回传仅记录状态，不启动任何阶段。

### 4.3 其它接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/async/summary` | 主题、任务、阶段、运行、回传、客户端矩阵与计数 |
| `GET /api/async/tasks/:id` | 单任务详情（阶段、运行、回传、时间线） |
| `POST /api/async/tasks/:id/cancel` | 取消；`{ "reason": "…" }` |
| `POST /api/async/tasks/:id/stages/:stageId/callback` | 重新绑定回传聊天；`{ app, device, chatId }`，并把 `manual`/`pending` 回传置回待投递 |
| `POST /api/async/callbacks/:id/retry` | 显式重投一条回传（用户操作，非自动轮询） |
| `POST /api/async/runs/:id/state` | 桥接回报原生轮次状态：`{ execution, detail }` |
| `GET /api/async/clients` | 客户端能力矩阵 |
| `POST /api/async/clients/:id/probe` | 单次显式探测，不进入定时轮询 |

## 5. 路由与阶段链

- 回传承载 `taskId`+`stageId`+`runId`，三者必须互相匹配，否则 `400`；未知则 `404`。
- 后续阶段只在这些条件全部成立时启动：
  1. 回传 `outcome=completed`；
  2. 任务 `authorization.allowChain=true`；
  3. 目标阶段的 `dependsOn` 全部已有非重复的 `completed` 回传；
  4. 任务未取消。
- 失败或阻塞**不会**启动审查阶段。
- 回传内容不能新增发布、付款、扩权等授权；它只能推进提交时声明的阶段。

## 6. 事件

任务事件复用观察台的 SSE 通道（`/api/stream`），事件名 `async`：

```json
{ "type": "async", "event": { "type": "callback.received", "at": "…", "taskId": "…", "stageId": "…", "outcome": "completed", "message": "收到回传" } }
```

事件类型：`task.submitted` `stage.dispatched` `stage.queued` `callback.received`
`callback.delivered` `task.cancelled` `client.updated`。

事件用于界面刷新与桌面通知；事实以持久化状态为准，丢一帧不影响正确性。

## 7. 持久化与恢复

数据根目录（默认取非系统盘，可在设置中修改）：

```
<dataRoot>/
  state.json      # 权威快照，临时文件 + rename 原子替换
  journal.jsonl   # 追加写入的审计日志（超过 16 MB 轮转为 .old）
```

- 每次变更一次性落盘；写入串行化，避免并发提交互相覆盖。
- 崩溃在 `state.json` 写入过程中时，旧快照仍然完整；损坏的快照会被另存为 `state.json.corrupt-<时间戳>` 后从空状态启动。
- 重启只恢复状态，**不会**重新派发已提交的任务，也不会重新创建会话。
- 「已投递但未收到确认」的执行实例显示 `execution` 原状并保留 `lastError`；是否重发由用户通过重新绑定/重投决定，系统不盲目重发提示词。

## 8. 派发桥接协议

桥接是拥有客户端集成（本机 CDP → 原生 IPC）的进程，与引擎通过回环 HTTP 通信：

| 接口 | 请求 | 响应 |
| --- | --- | --- |
| `POST /dispatch` | `DispatchRequest`（任务、阶段、项目、会话策略、模型、回传路由、幂等键） | `{ status: "delivered"\|"queued"\|"failed", sessionId, projectId, modelId, account, reasoning, nativeTurnId, workspacePath, reason }` |
| `POST /deliver` | `DeliverRequest`（回传摘要、结论、目标聊天） | `{ state: "in-chat"\|"queued-in-chat"\|"awaiting-host"\|"manual"\|"failed", reason, nativeTurnId }` |
| `POST /probe` | `{ client }` | `{ ok, interfaceReady, version, notes, error }` |

- 地址必须是回环（`127.0.0.1`/`localhost`/`::1`），否则注册失败。
- `/dispatch` 必须在目标受理提示词后返回，不得等待模型完成。
- 桥接超时（默认 10 s）按 `failed` 记录并给出原因，不自动重试。
- 桥接未注册的客户端，派发结果固定为 `queued`，界面如实显示「未接入」。

## 9. 客户端能力矩阵

矩阵在 `packages/control-room/src/async/adapters.ts` 中以静态基线给出，运行时由探测与真实回传覆盖。
`unsupported` 与 `unverified` 都是正式取值，不能合并为「已连接」。

当前基线（依据 `D:\Programs\AgentRelay\desktop-native\ACCEPTANCE.md` 的历史验收记录）：

| 能力 | WorkBuddy 5.9.2 | ZCode 3.16.3 | Factory 1.2.0 | ChatGPT / Codex |
| --- | --- | --- | --- | --- |
| 创建桌面可见会话 | 支持 | 支持 | 支持 | 未验证 |
| 项目归属 | 支持 | 支持 | 支持 | 未验证 |
| 账户/模型/思考强度 | 未验证 | 未验证 | 未验证 | 未验证 |
| 提交即返回 | 未验证 | 未验证 | 未验证 | 未验证 |
| 执行结束事件 | 支持 | 支持 | 支持 | 未验证 |
| 业务结果回传 | 未验证 | 未验证 | 未验证 | 未验证 |
| **原聊天主动注入** | 未验证 | 未验证 | 未验证 | 未验证 |
| 繁忙时排队 | 未验证 | 未验证 | 未验证 | 未验证 |

「原聊天主动注入」只有观察到回传真正进入同一聊天（`delivery.state = in-chat`）后才升级为「支持」。
现有的手动收件箱（`codex-mailbox.mjs`）不计为通过。

## 10. 已知限制

1. 本版不包含任何已验收的客户端派发桥接实现；未接入时任务停留在 `queued`。
2. 原聊天主动注入（P0 门槛）在本机尚未验证，界面与回执都按「未验证」显示。
3. 消息后端仍是现有 Relaycast；离线期间的可恢复性以服务端保留为准，本版不承诺端到端恰好一次。
4. `handled`（宿主已处理回传）需要宿主回报处理轮次，当前没有客户端能提供，故界面不会显示。
