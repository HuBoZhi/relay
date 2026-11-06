import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send(message.id, {
    protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'zcode-mcp-fixture', version: '1' },
  });
  if (message.method === 'tools/list') return send(message.id, { tools: ['zcode_run', 'zcode_check', 'zcode_sessions', ...(process.env.PROJECT_MODE === 'legacy' ? [] : ['zcode_projects'])].map((name) => ({ name, inputSchema: { type: 'object' } })) });
  const { name, arguments: args } = message.params;
  if (name === 'zcode_projects') {
    const mode = process.env.PROJECT_MODE;
    const body = { projects: mode === 'empty' ? [] : mode === 'invalid' ? [{ id: 'bad' }] : [{ id: 'desktop-id', name: '桌面项目', path: 'G:\\真实项目' }] };
    return send(message.id, mode === 'error' ? { isError: true, content: [{ type: 'text', text: '项目数据库不存在' }] }
      : { ...(mode === 'text' ? {} : { structuredContent: body }), content: [{ type: 'text', text: JSON.stringify(body) }] });
  }
  if (name === 'zcode_check') return send(message.id, { content: [{ type: 'text', text: 'models: GLM-5.3, GLM-5.3-Flash\nstatus: ok' }] });
  if (name === 'zcode_sessions') return send(message.id, { content: [{ type: 'text', text: '(no sessions)' }] });
  if (name === 'zcode_run') setTimeout(() => send(message.id, {
    isError: args.prompt.includes('FAIL'), content: [{ type: 'text', text: `${args.prompt.includes('FAIL') ? 'zcode turn FAILED: permission denied' : '本轮完成'}\n\n---\nsession_id: ${args.session_id || 'sess_mcp_real'}\nmodel: GLM-5.3\ncwd: ${args.cwd}` }],
  }), 150);
});
