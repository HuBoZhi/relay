import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

test('chat keeps the composer in view with long histories and preserves reading position',
  { skip: !process.env.RELAY_TEST_BROWSER, timeout: 30000 }, async () => {
    assert.doesNotMatch(tmpdir(), /^C:/i);
    const scratch = await mkdtemp(join(tmpdir(), 'relay-layout-'));
    const web = fileURLToPath(new URL('../web/', import.meta.url));
    const server = createServer(async (req, res) => {
      const file = resolve(web, '.' + new URL(req.url, 'http://localhost').pathname);
      if (!file.startsWith(resolve(web))) { res.writeHead(403).end(); return; }
      try {
        res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'text/plain');
        res.end(await readFile(file));
      } catch { res.writeHead(404).end(); }
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    let browser;
    try {
      browser = await chromium.launch({ executablePath: process.env.RELAY_TEST_BROWSER, headless: true,
        args: [`--disk-cache-dir=${join(scratch, 'cache')}`] });
      const page = await browser.newPage();
      let projectReads = 0;
      let deleted = false;
      await page.route('**/api/**', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/groups/group/delete') deleted = true;
        const body = path.endsWith('/delete') ? { deleted: true }
          : path === '/api/groups' ? { groups: deleted ? [] : [{ id: 'group', name: '长会话', memberCount: 1, messageCount: 80 }] }
          : path === '/api/groups/group' ? { group: { id: 'group', name: '长会话' }, members: [], tasks: [],
            messages: Array.from({ length: 80 }, (_, i) => ({ id: String(i), kind: 'message',
              sender: { agentId: 'relay', displayName: 'Relay' }, mentions: [], body: `消息 ${i}\n第二行`, createdAt: new Date().toISOString() })) }
          : path === '/api/async/projects' && ++projectReads % 2 === 0
            ? { projects: [{ id: 'project', name: '已恢复的项目', path: 'D:\\Recovered' }] }
            : { projects: [], models: [], reason: '测试客户端未运行' };
        return route.fulfill({ json: body });
      });
      for (const [width, height] of [[1360, 900], [1080, 700], [1024, 640]]) {
        await page.setViewportSize({ width, height });
        await page.goto(`http://127.0.0.1:${server.address().port}/chat.html`);
        await page.locator('#body-input').waitFor();
        const bounds = await page.locator('.composer').boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= height + 1, 'Composer must fit inside the window');
        assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true);
        assert.equal(await page.locator('#messages').evaluate((el) => el.scrollHeight > el.clientHeight), true);
        await page.locator('#messages').evaluate((el) => { el.scrollTop = 100; });
        await page.getByRole('button', { name: '刷新', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#messages').scrollTop === 100);
        await page.getByRole('button', { name: '重新读取项目' }).click();
        await page.locator('#path-select').waitFor();
        assert.match(await page.locator('#path-select').textContent(), /已恢复的项目/);
      }
      await page.getByRole('button', { name: '删除群组', exact: true }).click();
      await page.locator('[data-ask-action="cancel"]').click();
      assert.equal(deleted, false);
      await page.getByRole('button', { name: '删除群组', exact: true }).click();
      await page.locator('[data-ask-action="confirm"]').click();
      await page.waitForFunction(() => document.querySelector('#conv-count').textContent === '0');
      assert.equal(await page.locator('#body-input').count(), 0);
      await page.reload();
      await page.getByText('还没有群。点上面的「新建群」开始。').waitFor();
    } finally {
      await browser?.close();
      await new Promise((done) => server.close(done));
      await rm(scratch, { recursive: true, force: true });
    }
  });
