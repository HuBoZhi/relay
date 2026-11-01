# 桌面直连验收

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

本轮 WorkBuddy 实机任务入口尝试遇到 `ECONNREFUSED 127.0.0.1:19371`，保存为 `adapter_error / ok=false`。当前客户端未开放端口，启动入口正确拒绝强制结束运行中的应用。因此 Markdown 任务入口的第二轮实机往返仍待重新开放端口后验收，不能把此前探针成功作为本轮已通过的证明。

诊断脚本和测试任务的临时副本已清理。`D:\CodexTemp\relay-native-20261031` 中由桌面应用产生的运行文件可能仍被应用及其子进程使用，暂予保留；清理待办已写入 `D:\Programs\AgentRelay\data\desktop-host-retained-temp.json`，不能在确认相关进程退出前递归删除。
