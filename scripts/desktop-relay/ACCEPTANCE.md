# 桌面直连验收

## Factory 接入（2026-11-03，Asia/Shanghai）

- 用户本轮授权重启 Factory，并明确允许 Factory 自身保存接入必要的 C 盘会话和日志。Relay 代码、回执、临时目录与测试缓存仍位于 D/G 盘。
- 最终验收版本为 Factory 1.2.0，原生协议 `1.291.0`，本机端口 `19373`。首次启动的 1.1.0 被应用自动更新到 1.2.0，自动重启时丢失调试参数；随后对当前版本重新启用端口。没有修改客户端安装文件或调用 UI 输入。
- 路径为 Relay Action → 本机 CDP Runtime → `electronAPI.daemon.sendMessage/onMessage` → Factory 自带 Droid daemon。没有启动独立 Droid CLI。登录令牌仅在 renderer 内传给原生 daemon，不回传给 Relay。
- 专用会话：`e90cad0c-fbc1-4748-b4bf-bbe79b0f9870`；工作目录：`D:/Programs/AgentRelay/desktop-workspace`；Action：`desktop.factory.execute`。
- 算术探针：`inv_idem_e459f79ce46f11cf49e5053e01d5fcae697b7396b1554e02aa7128961ac2deaa`，返回 `RELAY_DESKTOP_3def83f1-6f95-40ee-91c3-7929076e85fd:437`，`mode=probe / ok=true`。
- Markdown 复用同一会话：`inv_idem_f0d446301bd14f5ead4160a03f27080569f422b569865abce8a8db0b85967deb`，返回 `NATIVE_MARKDOWN_TASK_V2_READY`，`mode=task / ok=true`。经已安装 PowerShell 入口完整投递、轮询、Relay 回执核验通过。
- 最终协议 `1.291.0` 复测：`inv_idem_239b14443495e76b9dc8010042253cc326727911995617ad720eb95018d6c669`，返回 `RELAY_DESKTOP_c4ef898e-3354-4e8f-8b60-378a1c698ce9:437`，`mode=probe / ok=true`。
- Factory 用会话 ID 与本轮消息 ID 查询原生 turn outcome，并校验 outcome 内的 turn ID；只有原生 `reason=completed` 才计为完成。错误、额度耗尽或其他结束原因不计为成功。单元测试覆盖错误关联、历史轮次、忙碌会话、工作目录、新会话权限和会话恢复；共 17 项通过。两个 PowerShell 入口通过语法解析，Factory 启动入口已实机验证 ready 检测且未重复重启。
- 当前限制仍为按需执行，无常驻收件服务；Factory 专用会话关闭自动权限批准并自动拒绝权限请求，仅验收无工具任务。未验收文件编辑、构建或部署。
- 结构化回执保留于 `D:/Programs/AgentRelay/reports/factory-desktop-native-<UUID>.json`，最近成功回执为 `factory-desktop-native-via-relay.json`。
- 当前 Factory 进程运行所需的 D 盘临时目录保留，记录于 `D:/Programs/AgentRelay/data/desktop-host-36348.json`，待该进程及其子进程退出后清理。

## WorkBuddy 与 ZCode 初始验收

核查日期：2026-10-31，Asia/Shanghai。

| 项目 | WorkBuddy | ZCode |
|---|---|---|
| 桌面版本 | 5.9.2 | 3.16.3 |
| 通道 | CDP → 原生 `wb` SDK → 当前桌面 daemon | CDP → 已连接的 MessagePort 服务代理 → 当前桌面 host |
| 专用会话 | `2fed03f1-fc4b-425a-8238-4760dc7496b8` | `session_f480aadd1fe6c4724e7e511cb10ca339` |
| Action | `desktop.workbuddy.execute` | `desktop.zcode.execute` |
| 调用 ID | `inv_idem_2f4497c17944aedd9537620c837c01b12eef6d88d48eac4c6a74bfc93d1e90c1` | `inv_idem_33d2c98f9cb547f0a97d37fef553844c14329fca3ad394a00eabe9963bf96cc3` |
| 桌面执行与回传 | `output.ok=true` | `output.ok=true` |

两轮任务都是无工具的算术测试，结果必须同时包含每轮独立生成的 UUID 和 `19×23=437` 的结果。调用方重新从 Relay 读取完成回执，并逐字段核验其内容。仅 `relayStatus=completed` 不代表任务成功，需同时检查 `output.ok`。

本轮用户明确授权新建专用会话、允许两个应用保存接入所需的 C 盘会话数据，并允许一次重启来启用本机 CDP。连接脚本、记录、缓存与测试输出均位于 D/G 盘。该授权不代表以后可以任意重启桌面客户端。

早期失败未计为通过：WorkBuddy 的独立 CLI 认证失败；WBIPC 的已公开通道不包含任务操作；ZCode 旧接口创建的空会话在发送时触发外键错误，正式适配改用 v4 创建会话；Relay 暂时无法分发的尝试也未计为完成。测试前探索过的 UI 自动化原型没有随此适配交付。

当前限制：本地按需执行，无常驻服务；内部接口存在版本依赖；仅验收模型回复和消息往返，未验收文件编辑、构建或部署任务；桌面端退出或不带调试参数重启后需要重新开启本机端口。没有发布 npm 包、合并主分支或创建正式版本。

原始结构化回执保留在 `D:\Programs\AgentRelay\reports\workbuddy-desktop-native-via-relay.json` 和 `zcode-desktop-native-via-relay.json`，均不包含认证凭据。

## 后续入口验证（2026-11-01）

已安装 Markdown 任务入口、启动检查入口、独立 UUID 回执与每端进程锁。9 项单元测试通过，两个 PowerShell 入口通过语法解析。会话复用过滤旧回答、Markdown 原文保留、空回答与旧随机标识拒绝均有覆盖。

早先 WorkBuddy 实机任务入口尝试遇到 `ECONNREFUSED 127.0.0.1:19371`，保存为 `adapter_error / ok=false`。当时启动入口正确拒绝强制结束运行中的应用。用户随后明确授权重启未开放端口的客户端，已重启两端并完成以下验收。

### 重启后会话复用与 Markdown 实机验收

- WorkBuddy：调用 `inv_idem_58cb089571dcfa75a7bf311e7600795cf908a331aa0d00c315b5013e8e3a4aee`，原会话 `2fed03f1-fc4b-425a-8238-4760dc7496b8`，`mode=task / ok=true`。
- ZCode：调用 `inv_idem_d58393783a0df5d942441c8ec159b9ad8fde52ff45c679f93cb95bc93d564958`，原会话 `session_f480aadd1fe6c4724e7e511cb10ca339`，`mode=task / ok=true`，完整入口自动执行、轮询与回传通过。
- 两轮均通过已安装的 `Invoke-DesktopTask.ps1 -TaskFile .../verification-task.md` 执行，返回 `NATIVE_MARKDOWN_TASK_V2_READY`，不是此前的算术回复。11 项单元测试通过。
- 修复 WorkBuddy 自动生成标题引发的误拒绝，改为绑定会话 ID、local transport 与工作目录；补上 ZCode 非活动会话恢复，并按 `info.messageId` 和原命令 ID 关联新一轮回复。
- ZCode 首次复用的回答已经完成，但旧适配器误读消息 ID 而未识别；该调用按原命令 ID 取回并补回 Relay，没有重发任务。以上列出的后续调用则由修复后的完整入口独立通过。

旧进程及其子进程退出后，已核验并清理 `D:\CodexTemp\relay-native-20261031`，诊断脚本和测试任务的临时副本也已删除。当前运行中的桌面进程使用独立的 `relay-desktop-host-*` 临时目录，路径和 PID 保存在 `data/desktop-host-25984.json`、`data/desktop-host-34384.json`，须待对应进程退出后再清理。
