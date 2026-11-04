# 异步协作验收记录（2026-11-04）

对应需求：`20261104-Relay本地桌面应用与异步协作完整需求.md`。
本记录只写实际做过的事；未做的一律标为「未验证」，不用「整体已支持」收尾。

## 1. 环境

| 项目 | 值 |
| --- | --- |
| 代码 | `G:\Coding\Github\relay`，分支 `feat/control-room-channel-flow` |
| 运行时 | Node.js 22 / Electron 33.4.11（打包壳） |
| 任务数据目录（本轮验证） | `D:\Temp\relay-ui-check\*`（非系统盘） |
| 界面验证浏览器 | Edge（Playwright 驱动），视口 1440×900 与 1080×800 |

## 2. 本轮交付

1. 任务引擎：契约、四层状态、持久化、幂等、回传路由、阶段链（`packages/control-room/src/async/`）。
2. 本地接口：`/api/async/*` 挂在观察台同一端口，事件复用 SSE。
3. 任务工作台：概览、派发表单、任务详情、回传处理、客户端矩阵、设置（`packages/control-room/web/tasks.*`）。
3b. 群聊界面（`packages/control-room/web/chat.*`）：主题即群、`@` 派活（模型 / 思考强度 / 项目）、
   成员会话登记、结果回报与投递状态；桌面 APP 默认打开这一页。
4. 桌面 APP：主进程承载引擎与设置，默认关窗即退出，托盘显示任务计数，通知可跳转任务。
5. 文档：`docs/design/relay-async/contract.md`。

## 3. 验收项对照

| 编号 | 结论 | 证据 / 说明 |
| --- | --- | --- |
| AC-01 | 部分通过 | 冒烟运行 `electron . --smoke --demo` 打开现有风格主界面，无需终端、无需单独启服务；安装包仍由 `npm run desktop:package` 生成，本轮未重新打包签名 |
| AC-02 | 通过（引擎层） | `POST /api/async/tasks` 在目标未接入时 900 ms 内返回 `202` + `phase=queued` + 原因；已接入桥接时返回 `delivered`。接口不等待模型。见 `engine.test.ts`「returns a queued receipt…」 |
| AC-03 | **未验证** | 需要真实宿主把回传注入同一聊天并产生新轮次。本机尚无已验收的注入通道，回传一律落在 `manual` 并显示「需人工处理」 |
| AC-04 | 部分通过 | 引擎为每个阶段独立创建 run/会话策略与模型参数，并在回执记录 `sessionId`/`projectId`/`model.actual`；「在指定桌面项目下可见」依赖客户端桥接，未验证 |
| AC-05 | 通过（本仓库内） | 等待期间没有任何 inbox / readSession / sleep / 状态轮询调用；状态推进只来自提交回执、桥接回报、回传与用户操作。引擎无定时器 |
| AC-06 | 通过（引擎层） | `reportRunState(awaiting-confirmation)` 映射为「等待确认」；`turn-ended` 不再推出完成，业务层保持「未确认」；失败/阻塞回传不启动审查 |
| AC-07 | 通过 | 同一条回传投递三次：只生成 1 条回传、1 次有效处理、1 个后续阶段（`engine.test.ts` 与真实 HTTP 三次 POST 均验证） |
| AC-08 | 通过 | 回传按 `taskId`+`stageId`+`runId` 校验；不匹配返回 400，不会串线 |
| AC-09 | 部分通过 | 退出时先退订引擎、再关服务、再关引擎；进程结束后端口不再监听（`curl` 连接被拒）。未被旧看护脚本自动拉起需在安装版清点后确认 |
| AC-10 | 未验证 | 需要真实后端离线回传；引擎侧只保证「重启不重复派发、状态可恢复」 |
| AC-11 | 部分通过 | 重复事件幂等、重启恢复已通过自动化测试；断网重连与「投递后未确认」的真实宿主行为未验证 |
| AC-12 | 通过 | 宿主无主动接收能力时显示「未接入 / 未验证 / 需人工处理」，不以通知或新 CLI 会话替代 |

群聊链路的实测（本机，2026-11-04）：

| 步骤 | 调用 | 结果 |
| --- | --- | --- |
| 建群 | `POST /api/groups`（名称 `20261104-MediaDock-需求开发2`） | `201`，`grp_730656c6…`，发起人为 owner |
| @ 派活 | `POST /api/groups/:id/messages`，`@zcode` + `GLM-5.3-Flash` + `max` + `D://Work//MediaDock` | `202`，消息 `queued`，原因「未接入 zcode 的派发通道」 |
| 入群 | `POST /api/groups/:id/join`，`sessionId=session_a1b2c3` | `200`，成员行记录会话，群内出现「已加入（会话 …）」 |
| 回报 | `POST /api/groups/:id/results`，`completed` | `202`，结果消息 `manual`（`codex` 回传通道未接入），回传记录已写入 |
| 会话顺序 | — | `system > request > join > result` |

界面同一路径已由 Edge 走通：切换身份发消息、再以 Codex 派活，得到 4 条气泡、2 条系统提示，
徽标为「已排队 / 完成 / 原聊天未收到，需人工处理」，无控制台错误。

## 3b. 派发桥接与只读探测（2026-11-04 16:26）

桥接 `packages/dispatch-bridge` 启动后以引擎同款格式做了**只读**探测，未创建会话、未发送提示词：

| 客户端 | 调试端口 | 结果 | 证据 |
| --- | --- | --- | --- |
| WorkBuddy | 19371 | `interfaceReady=supported` | `Chrome/138.0.7204.251`，`wb.conversations.create / get` 存在 |
| ZCode | 19372 | 已连接，接口 `unverified` | `Chrome/152.0.7977.130`；服务注册表在实际派发时校验 |
| Factory | 19373 | 端口未开放 | `端口 19373 未开放：需要以 --remote-debugging-port=19373 启动该客户端` |

结论：WorkBuddy 与 ZCode 的调试端口当前可用，说明「桥接能连上客户端」这一环已具备条件；
真正的派发（会在客户端里跑一轮模型）未执行，等待用户授权。

自动化证据：`npx vitest run packages/dispatch-bridge` → 13 条通过，其中端到端一条走完
「群聊 @ → 引擎 → 桥接 → 假客户端会话 → 结果回到群里」，并断言未接回传通道时结果状态为 `manual`。

## 3b. 派发桥接与只读探测（2026-11-04 16:26）

桥接 `packages/dispatch-bridge` 启动后以引擎同款格式做了**只读**探测，未创建会话、未发送提示词：

| 客户端 | 调试端口 | 结果 | 证据 |
| --- | --- | --- | --- |
| WorkBuddy | 19371 | `interfaceReady=supported` | `Chrome/138.0.7204.251`，`wb.conversations.create / get` 存在 |
| ZCode | 19372 | 已连接，接口 `unverified` | `Chrome/152.0.7977.130`；服务注册表在实际派发时校验 |
| Factory | 19373 | 端口未开放 | `端口 19373 未开放：需要以 --remote-debugging-port=19373 启动该客户端` |

结论：WorkBuddy 与 ZCode 的调试端口当前可用，说明「桥接能连上客户端」这一环已具备条件；
真正的派发（会在客户端里跑一轮模型）未执行，等待用户授权。

自动化证据：`npx vitest run packages/dispatch-bridge` → 13 条通过，其中端到端一条走完
「群聊 @ → 引擎 → 桥接 → 假客户端会话 → 结果回到群里」，并断言未接回传通道时结果状态为 `manual`。

界面与数据验收：

- 四层状态分别显示，均可追溯到事件时间与来源。
- 中文主题名（`20261104-MediaDock-需求开发2`）正确显示，ASCII slug 单独展示。
- 重启后任务、回传、路由与未投递回传不丢失（`durability` 测试）。
- 任务正文、日志、接口响应不含模型密钥；数据目录可改为非系统盘。
- 截图：`docs/design/relay-control-room/acceptance-2026-11-04/`
  - `tasks-overview.png`、`tasks-receipt-queued.png`、`tasks-callback-manual.png`、`tasks-client-matrix.png`
  - `chat-group.png`（桌面窗口默认打开群聊）、`chat-dispatch-flow.png`（发消息 + 派活后的会话）

## 4. 自动化测试

```
npx vitest run packages/control-room/ packages/control-room-desktop/
→ 13 files, 151 tests passed
```

新增测试分布：

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `control-room/src/async/__tests__/engine.test.ts` | 17 | 回执边界、实际会话/模型、适配器异常、幂等提交、字段级校验、同主题多任务、阶段链只启动一次、重放折叠、失败不审查、越权回传拒绝、取消后晚到回传、manual 投递、注入能力只在真实投递后升级、重启恢复、审计日志、等待确认映射、slug |
| `control-room/src/async/__tests__/http.test.ts` | 8 | 202 回执、重复提交同 ID、回传与投递分离、非 JSON/跨站拒绝、字段级错误、观察接口不受影响 |
| `control-room/src/async/__tests__/groups.test.ts` | 9 | 同名复用同一群、`@` 派活携带模型/项目、缺项目被拒、普通消息不派发、结果回到原聊天、失败不启动后续、同群两请求互不串线、未受邀先发言自动入群、重启恢复 |
| `control-room/src/__tests__/tasks-web.test.ts` | 3 | 列表与分层渲染、回执不夸大为已送达、字段错误就地显示 |
| `control-room/src/__tests__/chat-web.test.ts` | 3 | 请求气泡显示目标/模型/项目与投递状态、缺项目不发请求、普通消息只寻址 |
| `control-room-desktop/tests/desktop.test.ts` | +8（共 30） | 托盘任务行、新菜单项、设置默认值/回环桥接过滤/损坏文件降级/往返保存 |

## 5. 使用

### 5.0 群聊（推荐入口）

打开 `http://127.0.0.1:<端口>/chat.html`（桌面 APP 默认就是这一页）：

1. 「新建群（主题）」→ 输入主题名，例如 `20261104-MediaDock-需求开发2`。
2. 在底部选择 `@ZCode`、模型 `GLM-5.3-Flash`、思考强度 `max`、项目目录与项目 ID，写清要干的活，点「@ 派活」。
3. 气泡按投递状态标注「已排队」或「已送达目标会话」；未接入桥接时显示原因。
4. 接收方完成时调用 `POST /api/groups/:id/results`，群里出现结果气泡，并按回传状态显示
   「回传已进入原聊天」或「原聊天未收到，需人工处理」。
5. 「发送消息」只发消息：会 `@` 到某个 Agent，但不派发、不建会话。

### 5.1 桌面 APP

```powershell
npm run desktop            # 开发运行
npm run desktop:package    # 生成安装包与便携版
```

- 双击打开主窗口；关闭窗口默认退出（引擎、订阅、端口一起停）。
- 托盘：任务计数、打开任务工作台、设置、缩小到托盘、开机启动、退出。
- 设置页（任务工作台 → 设置与数据）：关窗行为、通知、开机启动、任务数据目录。
- 设置文件位于 Electron `userData/settings.json`（仅此一条记录）；任务数据在数据目录内。
  开发/测试可用 `RELAY_DESKTOP_SETTINGS` 覆盖设置文件位置。

### 5.2 只读 CLI（带任务引擎）

```bash
node packages/control-room/dist/cli.js --tasks --data-root "D:/RelayData/async"
# 可选：注册本机派发桥接
node packages/control-room/dist/cli.js --tasks --bridge zcode=http://127.0.0.1:7900
```

不带 `--tasks` 时行为与之前一致：只读观察，不开放写接口。

### 5.3 接收方回传

```bash
curl -X POST http://127.0.0.1:4320/api/async/callbacks \
  -H "Content-Type: application/json" \
  -d '{"taskId":"task_…","stageId":"stg_…","runId":"run_…","outcome":"completed","summary":"开发完成"}'
```

## 6. 迁移与回滚

- 迁移：旧安装（`D:\Programs\AgentRelay`、`D:\Programs\RelayControlRoom`）不需要数据迁移即
  可继续只读使用；启用任务引擎后首次启动会在数据目录新建 `state.json` 与 `journal.jsonl`，
  不会改动旧报告、会话文件或 Relay 工作空间。
- 主题与历史：旧脚本产生的主题名直接作为任务主题 `name` 复用，不会静默创建新工作空间。
- 回滚：删除/停用新版 APP 即回到旧安装；任务数据目录保留可读，不参与旧流程。
- 清点旧启动项：未在本轮执行（需要用户确认哪些属于旧 Relay 部署），见「遗留」。

## 7. 未支持与已知限制

1. **原聊天主动注入未验证（P0 门槛）**。没有客户端桥接时回传统一为 `manual`，界面显示「需人工处理」，
   提供「重新投递」与「重新绑定回传聊天」。这不是「已支持异步闭环」。
2. 未内置已验收的客户端派发桥接；`HttpBridgeAdapter` 是接口，不是某客户端的实现。
   桥接不存在时任务停在 `queued`。
3. 未验证项：账户/模型/思考强度的实际生效、提交即返回的客户端侧实现、繁忙时排队、
   离线期间的回传补投。
4. 安装包：本轮未重新构建、未签名、未做升级/回滚安装验证。
5. 旧启动项（Windows 服务、计划任务、看护脚本）清点与移除未执行，避免误删其他软件。
