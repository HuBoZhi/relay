import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

test('shared workspace navigation, menu and guided connection checks',
  { skip: !process.env.RELAY_TEST_BROWSER, timeout: 30000 }, async () => {
    assert.doesNotMatch(tmpdir(), /^C:/i);
    const scratch = await mkdtemp(join(tmpdir(), 'relay-workspace-'));
    const web = fileURLToPath(new URL('../web/', import.meta.url));
    const server = createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = resolve(web, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(resolve(web))) { res.writeHead(403).end(); return; }
      try {
        res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'text/plain');
        res.end(await readFile(file));
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    let browser;
    try {
      browser = await chromium.launch({ executablePath: process.env.RELAY_TEST_BROWSER,
        headless: true, args: [`--disk-cache-dir=${join(scratch, 'cache')}`] });
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.relayDesktop = { menu: async () => [{ label: '应用', items: [{ id: 'settings', label: '打开设置' }] }],
          run: async id => { window.lastMenuAction = id; }, settings: async () => null };
      });
      let checked = false;
      const client = () => ({ client: 'zcode', label: 'ZCode', version: '3.16.3',
        interfaceReady: checked ? 'supported' : 'unverified', lastError: checked ? null : '客户端未启动',
        chatInjection: { state: 'unverified', reason: '等待实际任务验证' }, notes: ['测试桥接'],
        canBindProject: 'supported', canCreateVisibleSession: 'supported' });
      await page.route('**/api/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/probe')) { checked = true; return route.fulfill({ json: client() }); }
        if (path === '/api/async/summary') return route.fulfill({ json: {
          clients: [client()], counts: { tasks: 0 }, topics: [], tasks: [], callbacks: [], warnings: [],
        } });
        if (path === '/api/groups') return route.fulfill({ json: { groups: [] } });
        return route.fulfill({ status: 404, json: { error: '测试环境未提供该接口' } });
      });
      const origin = `http://127.0.0.1:${server.address().port}`;
      for (const [width, height] of [[1698, 1138], [1080, 700], [1024, 640]]) {
        await page.setViewportSize({ width, height });
        for (const [path, active] of [['/tasks.html#clients', 'tasks'], ['/chat.html', 'chat'], ['/', 'observer']]) {
          await page.goto(origin + path);
          await page.locator('.workspace-header').waitFor();
          assert.equal(await page.locator('.workspace-nav [aria-current]').getAttribute('data-workspace-link'), active);
          assert.equal(await page.locator('.workspace-header').evaluate(el => el.getBoundingClientRect().top), 0);
          await page.locator('#menu-button').click();
          await page.locator('#menu-pop button').waitFor();
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('#menu-pop').isVisible(), false);
          assert.equal(await page.locator('#menu-button').evaluate(el => el === document.activeElement), true);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
      }
      await page.goto(origin + '/tasks.html#clients');
      await page.locator('#menu-button').click();
      await page.getByRole('menuitem', { name: '打开设置' }).click();
      assert.equal(await page.evaluate(() => window.lastMenuAction), 'settings');
      await page.getByRole('button', { name: '检查连接', exact: true }).click();
      await page.getByText('接口可用', { exact: true }).waitFor();
      await page.getByRole('link', { name: '去群聊派活' }).waitFor();
      assert.equal(await page.locator('.client-diagnostics').getAttribute('open'), null);
      await page.locator('.client-diagnostics summary').click();
      assert.equal(await page.getByText('等待实际任务验证', { exact: true }).isVisible(), true);
      await page.locator('.workspace-nav a[data-workspace-link="chat"]').click();
      await page.waitForURL('**/chat.html');
      await page.locator('.workspace-tools a[href$="#clients"]').click();
      await page.waitForURL('**/tasks.html#clients');
      await page.getByText('连接你的 AI 客户端', { exact: true }).waitFor();
      if (process.env.RELAY_UI_SCREENSHOT) await page.screenshot({ path: process.env.RELAY_UI_SCREENSHOT, fullPage: true });
    } finally {
      await browser?.close();
      await new Promise(done => server.close(done));
      await rm(scratch, { recursive: true, force: true });
    }
  });
