# ZCode MCP 项目列表接入与部署

日期：2026-11-06。Relay 源码：`c75891076`；MCP 源码：HuBoZhi/zcode_mcp 的 `f339373`。

## 实现与验证

- Relay 通过同一条受管理的 stdio 连接调用 `zcode_projects`，支持结构化与 JSON 文本响应，保留原始 ID 与路径，不缓存项目列表。
- 老 MCP 缺少工具、查询报错或数据格式错误时显示明确原因，不将失败当成空项目列表。群聊直接显示项目读取失败原因；修正手填目录示例。
- 233 项 Relay 测试、2 项浏览器测试通过。更新了仍只加载旧菜单脚本的渲染测试夹具，使其加载真实共享菜单和导航脚本。
- MCP 6 项测试通过，真实模型可用性测试默认跳过；本次未发送模型任务。

## 打包

Relay 目录：`packages/control-room-desktop/release/20261106-zcode-projects/`。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| RelaySystem-14.0.0-安装包.exe | 74861208 | 2AB44C2BAC72966FC3282A21D7141D2766F46E807271F7FBC25A3347E16FB274 |
| RelaySystem-14.0.0-便携版.exe | 74645582 | 0BAEA870182ABF7A7241D00FC3D243ED031F1432DE78297C2FDEC1884405B10E |

MCP 安装包：`D:/Programs/AgentRelay/packages/zcode-mcp-20261106/zcode-mcp-0.2.0.tgz`。
SHA-256：`391AEB6F982C6B782EFC2FE1C1712B0CBEED9F24A43DB295B01E9ABC6E2C7013`。
两个程序分别打包，MCP 继续通过现有外部配置连接。未发布 npm 包或远程正式版本。

## 本机部署

- 替换 `D:/Programs/RelaySystem` 的 exe 与 ASAR，以及 `D:/Programs/AgentRelay/zcode-mcp` 的 dist、src、README。
- 保留 MCP 的 relay-config、runtime、依赖与凭据配置；保留 Relay 数据、设置、快捷方式及启动项。
- 备份：`D:/Programs/AgentRelay/data/zcode-projects-backup-20261106`。
- 部署前无执行中任务，正常请求关闭后确认旧进程已全部退出，再替换文件并按原参数启动。
- 已安装 ASAR 与构建产物哈希一致：`CA4E0DD26B1C7914814DA79B900E1C76FBD210A5C210FB0BFF5165080D6754DF`。
- 设置哈希不变：`0D648B5787F8A7FF89E401D040B786328499367E92002DB2A150A3E032E24A77`。
- 原生群聊窗口已恢复，`/api/health` 返回 `ok=true, mode=live, target=relaycast`。
- 实际 `/api/async/projects?client=zcode` 返回 6 个项目且 `reason=null`。
- 对已安装服务运行浏览器验收：下拉框出现 relay、空白、REA-Work、Opus5.5-Ai-Worker、AIWorkerHub、MediaDock；选择 MediaDock 后目录为 `G:\Coding\Gitee\MediaDock`，ID 为 `04c12ef2-d46f-48f0-b855-ae11fc10e900`。
- 任务计数部署前后均为 3 个任务、0 个执行中、0 个待回传、1 个历史失败。仅选择项目验收，未派发或修改任务。
- 本轮构建缓存、快照与浏览器临时文件均位于 D/G 盘。
