import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const textOf = (result) => (result?.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');

/** One managed stdio MCP connection; it never reads or logs model credentials. */
export class ZCodeMcpConnection {
  constructor(config) { this.config = config; this.jobs = new Map(); }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.open().catch((error) => { this.ready = null; throw error; });
    return this.ready;
  }
  async open() {
    const cwd = resolve(this.config.cwd || process.cwd());
    if (/^C:[\\/]/i.test(await realpath(cwd))) throw new Error('ZCode MCP 工作目录必须位于非 C 盘');
    const temporary = join(cwd, 'runtime', 'temp');
    await mkdir(temporary, { recursive: true });
    const env = { ...process.env, ...this.config.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const transport = new StdioClientTransport({ command: this.config.command || 'node',
      args: this.config.args || [], cwd, env, stderr: 'pipe' });
    transport.stderr?.resume();
    const client = new Client({ name: 'relay-zcode', version: '1.0.0' }, { capabilities: {} });
    this.client = client;
    client.onclose = () => { if (this.client === client) this.ready = null; };
    this.transport = transport;
    try {
      await client.connect(transport, { timeout: 15000 });
      const { tools } = await client.listTools();
      if (!tools.some((tool) => tool.name === 'zcode_run')) throw new Error('MCP 服务未提供 zcode_run 工具');
      this.tools = new Set(tools.map((tool) => tool.name));
    } catch (error) { await client.close().catch(() => {}); throw error; }
  }
  async tool(name, args = {}, timeout = 30000) {
    await this.connect();
    if (!this.tools.has(name)) throw new Error(`MCP 服务未提供 ${name}`);
    return this.client.callTool({ name, arguments: args }, undefined, { timeout });
  }
  async probe() {
    const result = await this.tool('zcode_check', {}, 60000);
    const text = textOf(result);
    const ok = !result.isError && /^status:\s*ok\s*$/im.test(text);
    return { client: 'zcode', ok, interfaceReady: ok ? 'supported' : 'unverified',
      version: 'zcode-mcp', notes: ['MCP stdio；zcode_check 会创建探测会话'], error: ok ? null : text.slice(0, 500) };
  }
  async listModels() {
    if (this.models) return this.models;
    const result = await this.tool('zcode_check', {}, 60000);
    if (result.isError) throw new Error(textOf(result));
    const ids = textOf(result).match(/^models:\s*(.+)$/im)?.[1] || '';
    this.models = ids.split(',').map((id) => id.trim()).filter((id) => id && id !== '(none)')
      .map((id) => ({ id, label: id, reasoning: ['low', 'high', 'max'] }));
    return this.models;
  }
  async listProjects() {
    await this.connect();
    if (!this.tools.has('zcode_projects')) throw new Error('当前 zcode-mcp 未提供 zcode_projects，请更新 MCP 服务后重新读取项目');
    const result = await this.tool('zcode_projects');
    if (result.isError) throw new Error(textOf(result) || 'ZCode 项目查询失败');
    let body = result.structuredContent;
    if (!body) {
      try { body = JSON.parse(textOf(result)); }
      catch { throw new Error('zcode_projects 返回了无效的项目数据'); }
    }
    if (!Array.isArray(body?.projects) || body.projects.some((project) =>
      !project || typeof project.id !== 'string' || !project.id.trim() ||
      typeof project.name !== 'string' || typeof project.path !== 'string' || !project.path.trim())) {
      throw new Error('zcode_projects 返回了无效的项目数据');
    }
    return body.projects.map(({ id, name, path }) => ({ id, name: name || path, path }));
  }
  async close() {
    await this.client?.close();
    this.ready = null;
    this.models = null;
  }
}

/** zcode_run completes asynchronously; unknown session ids remain null until evidenced. */
export class ZCodeMcpDesktop {
  constructor(connection, sessionId, options = {}) {
    this.connection = connection; this.sessionId = sessionId; this.workspace = options.workspace; this.model = options.model;
    this.permissionMode = options.permissionMode;
    this.acceptanceStatus = 'accepted';
  }
  async createSession() { return { sessionId: null }; }
  async submit(sessionId, prompt, requestId) {
    if (this.connection.jobs.has(requestId)) return;
    if (this.permissionMode) {
      await this.connection.connect();
      if (!this.connection.tools.has('zcode_set_mode')) throw new Error('当前 zcode-mcp 不支持已验证的权限切换，请更新 MCP 服务');
    }
    const timeout = this.connection.config.timeoutMs || 600000;
    const job = { status: 'running', sessionId: sessionId || null, response: '' };
    this.connection.jobs.set(requestId, job);
    const args = { prompt, cwd: this.workspace, mode: this.permissionMode || this.connection.config.mode || 'build', timeout_ms: timeout,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(this.model?.modelId ? { model: this.model.providerId ? `${this.model.providerId}/${this.model.modelId}` : this.model.modelId } : {}),
      ...(this.model?.options?.reasoningLevel ? { reasoning_level: this.model.options.reasoningLevel } : {}),
    };
    // No automatic retry: a lost reply must never start the same model task twice.
    void this.connection.tool('zcode_run', args, timeout + 10000).then((result) => {
      const text = textOf(result);
      const id = text.match(/(?:^|\n)session_id:\s*(sess_[\w-]+)\s*(?:\n|$)/)?.[1];
      job.sessionId = id || job.sessionId;
      job.response = text.split(/\n---\n/)[0].trim();
      job.status = result.isError ? 'error' : id ? 'completed' : 'unknown';
      if (result.isError) job.error = { message: job.response,
        code: /interaction|permission|confirmation/i.test(text) ? 'desktop_confirmation_required' : 'mcp_tool_error' };
    }).catch((error) => {
      job.status = 'unknown';
      job.nativeReason = `MCP 请求结果未确认：${error.message}`;
    });
  }
  async poll(_sessionId, requestId) { return this.connection.jobs.get(requestId) || { status: 'unknown', sessionId: null }; }
}
