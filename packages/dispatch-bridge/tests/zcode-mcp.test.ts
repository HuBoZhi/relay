import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ZCodeMcpConnection, ZCodeMcpDesktop } from '../src/zcode-mcp.mjs';
import { listProjectsFor } from '../src/drivers.mjs';

describe('ZCode through MCP', () => {
  it.each(['structured', 'text', 'empty'])('reads %s project responses through the shared MCP connection', async (mode) => {
    const connection = new ZCodeMcpConnection({ command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/zcode-mcp.mjs', import.meta.url))], cwd: process.env.TEMP,
      env: { PROJECT_MODE: mode } });
    try {
      expect(await listProjectsFor({ drivers: { zcodeMcp: connection }, client: 'zcode' })).toEqual(
        mode === 'empty' ? [] : [{ id: 'desktop-id', name: '桌面项目', path: 'G:\\真实项目' }]);
      expect((await connection.probe()).ok).toBe(true);
    } finally { await connection.close(); }
  });
  it.each([['legacy', '请更新'], ['invalid', '无效的项目数据'], ['error', '项目数据库不存在']])('reports %s failures without inventing an empty catalogue', async (mode, message) => {
    const connection = new ZCodeMcpConnection({ command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/zcode-mcp.mjs', import.meta.url))], cwd: process.env.TEMP,
      env: { PROJECT_MODE: mode } });
    try { await expect(connection.listProjects()).rejects.toThrow(message); }
    finally { await connection.close(); }
  });
  it('handshakes, submits without waiting for the turn, and returns only a real session id', async () => {
    const connection = new ZCodeMcpConnection({ command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/zcode-mcp.mjs', import.meta.url))], cwd: process.env.TEMP });
    try {
      await connection.connect();
      expect((await connection.probe()).ok).toBe(true);
      const desktop = new ZCodeMcpDesktop(connection, null, { workspace: 'D:/test-project', model: { modelId: 'GLM-5.3', options: { reasoningLevel: 'high' } } });
      expect((await desktop.createSession()).sessionId).toBeNull();
      await desktop.submit(null, '只做一轮', 'req_1');
      expect(await desktop.poll(null, 'req_1')).toMatchObject({ status: 'running', sessionId: null });
      await new Promise((done) => setTimeout(done, 250));
      expect(await desktop.poll(null, 'req_1')).toMatchObject({ status: 'completed', sessionId: 'sess_mcp_real', response: '本轮完成' });
    } finally { await connection.close(); }
  });
  it('resumes the requested session, reports failures, and never treats unknown jobs as completed', async () => {
    const connection = new ZCodeMcpConnection({ command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/zcode-mcp.mjs', import.meta.url))], cwd: process.env.TEMP });
    try {
      await connection.connect();
      const desktop = new ZCodeMcpDesktop(connection, 'sess_resume', { workspace: 'D:/test-project' });
      await desktop.submit('sess_resume', 'FAIL', 'req_2');
      await new Promise((done) => setTimeout(done, 250));
      expect(await desktop.poll('sess_resume', 'req_2')).toMatchObject({ status: 'error', sessionId: 'sess_resume' });
      expect(await desktop.poll(null, 'lost')).toMatchObject({ status: 'unknown' });
    } finally { await connection.close(); }
  });
});
