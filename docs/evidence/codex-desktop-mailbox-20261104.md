# Codex 当前聊天的 Relay 收件入口

2026-11-04，Asia/Shanghai。

共享 `relay-agent-connect` 技能原来只介绍独立 Codex App Server，缺少当前桌面聊天的收件方式。新增按完整 thread UUID 区分的收件身份、注册和查收入口，并更新 `D:\codex\skills\relay-agent-connect\SKILL.md`；源码快照在 `scripts/desktop-relay/relay-agent-connect/SKILL.md`。

安装位置：

- `scripts/desktop-relay/codex-mailbox.mjs` → `D:\Programs\AgentRelay\scripts\codex-mailbox.mjs`
- `scripts/desktop-relay/Invoke-CodexMailbox.ps1` → `D:\Programs\AgentRelay\Invoke-CodexMailbox.ps1`

## 验证

- `node --check scripts/desktop-relay/codex-mailbox.mjs` 通过。
- 共享技能通过 `python -X utf8 .../quick_validate.py`；默认 GBK 读取器无法解码 UTF-8，显式 UTF-8 后通过。
- 重复注册前后凭据文件哈希一致；读取未登记的 thread 被拒绝，不会静默创建身份。
- Claude、Factory、ZCode 的现有技能入口与 D 盘共享正文哈希一致；已打开会话可能仍缓存旧技能。
- 当前聊天注册为 `codex-desktop-01a1a440-1926-7b31-aab6-362cc5ab5e69`。
- 从现有 `operator` 身份经托管 Relay 发送专用测试消息，消息 ID `243553654387752960`。
- 目标入口的 `inbox.get` 和 `inbox.list` 均读到相同消息 ID 和测试正文，实际正文已由当前聊天读取。
- 凭据目录继承现有运行目录的受限 ACL，仅当前 Windows 用户和 SYSTEM 拥有访问权；输出不包含 token 或 workspace key。

## 交付边界

该入口是主动查收的邮箱，不是自动唤醒桥。`autoWake=false`；未启动常驻模型，也未验证向空闲 Codex 桌面聊天自动注入消息。消息队列状态仍可能显示 queued，不能据此声称任务已执行。

不将聊天 UUID 固定在共享技能的发送模板里；调用方应使用实际接收方登记后提供的 recipient。历史登记文件不证明会话在线。

`trail` 未安装，未通过下载额外工具生成轨迹；此文件保留本次决策与验证证据。

## 临时目录清理

已核验 `D:\CodexTemp\relay-codex-skill-20261104` 为本任务真实 D 盘目录，包含 Node 编译缓存。自动审批拒绝了对此目录的 PowerShell 递归清理命令（返回 `blocked by policy`，未提供更具体原因），因此该目录尚未清理；没有改用其他执行器绕过拒绝。每次已安装包装入口自身创建的 `relay-codex-mailbox-*` 临时目录已正常清理。
