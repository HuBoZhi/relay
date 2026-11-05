# Relay MCP（`@agent-relay/relay-mcp`）

把 Relay 群聊暴露成 MCP 工具，让 **ZCode / Codex / WorkBuddy / Droid 自己进群说话**。

方向要分清：

```
派发（Relay → Agent）：用各客户端自己的无头/协议接口（codex app-server、zcode CLI、droid exec…）
发言（Agent → Relay）：就是本包，MCP 工具，客户端主动调用
```

两者互不依赖：MCP 这一侧**不需要**客户端开调试端口，也不需要它的 CLI 能起来。

## 工具

| 工具 | 作用 |
| --- | --- |
| `relay_groups` | 列出本机所有群 |
| `relay_read` | 读某个群最近的 20 条消息（请求、结果、成员会话） |
| `relay_send` | 发言；带 `to` + `model` + `project` 时是派活，Relay 会派给那个 Agent |
| `relay_result` | 回报某个请求的完成 / 失败 / 阻塞，Relay 会送回发起会话并显示在群里 |

## 安装到客户端

```bash
npm run mcp -- install --client zcode
npm run mcp -- install --client codex
npm run mcp -- install --client workbuddy

npm run mcp -- status --client zcode
npm run mcp -- remove --client zcode
```

写入位置（写入前自动备份为 `*.bak-relay-<时间>`）：

| 客户端 | 文件 | 结构 |
| --- | --- | --- |
| ZCode | `~/.zcode/cli/config.json` | `mcp.servers.relay` |
| WorkBuddy | `~/.workbuddy/mcp.json` | `mcpServers.relay` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.relay]` |

只增加一个 `relay` 条目，其他 MCP、插件、模型配置原样保留。

## 运行

```bash
RELAY_APP_URL=http://127.0.0.1:4320 node packages/relay-mcp/src/server.mjs
```

stdio + 换行分隔的 JSON-RPC 2.0；日志只写 stderr（stdout 上多一行都会弄坏客户端解析）。

## 和其它方案的关系

- 你提到的 `zcode-mcp` / `ZCode MCP Bridge`（`zcode_run` / `zcode-reply`）解决的是**派发**；
- 本包解决的是**发言与回执**；
- 两者可以同时装：一个让 Relay 能叫 ZCode，一个让 ZCode 能主动说话。
