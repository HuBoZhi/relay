import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { DemoControlRoomSource } from '../dist/demo-source.js';
import { startControlRoom } from '../dist/server.js';

test('channel graph keeps visible text separate at desktop and mobile sizes', { timeout: 45000 }, async () => {
  if (process.platform === 'win32') assert.doesNotMatch(tmpdir(), /^C:/i, 'Set TEMP/TMP/TMPDIR to a D-drive task directory');
  const executablePath = process.env.RELAY_LAYOUT_BROWSER;
  assert.ok(executablePath, 'Set RELAY_LAYOUT_BROWSER to an existing Chromium executable');
  await access(executablePath);
  const scratch = await mkdtemp(join(tmpdir(), 'relay-labels-'));
  const source = new DemoControlRoomSource({ timezone: 'Asia/Shanghai' });
  const server = await startControlRoom({ source, port: 0, webRoot: process.env.RELAY_LAYOUT_WEB_ROOT || fileURLToPath(new URL('../web/', import.meta.url)), log: () => {} });
  let context;
  try {
    context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
      executablePath, headless: true, downloadsPath: join(scratch, 'downloads'),
      env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch },
      args: [`--disk-cache-dir=${scratch}/cache`],
    });
    const original = await source.bootstrap();
    const errors = [];
    for (const count of [1, 4, 7]) {
      for (const width of [1680, 1280, 390]) {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.setViewportSize({ width, height: 1100 });
        const channel = { ...original.channels.find(c => c.name === 'engineering'), memberCount: count };
        const members = original.agents.filter(a => a.channelNames.includes(channel.name));
        const others = original.agents.filter(a => !a.channelNames.includes(channel.name));
        const agents = [...members, ...others].slice(0, count).map(a => ({ ...a, channelNames: [channel.name] }));
        await page.route('**/api/bootstrap', route => route.fulfill({ json: { ...original, channels: [channel], agents } }));
        await page.goto(server.url);
        await page.locator('#channel-list button').first().click();
        await page.locator('#network .agent-node').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        if (count === 4 && width === 1680) {
          const before = Number((await page.locator('#zoom-value').textContent()).replace('%', ''));
          const stage = await page.locator('#graph-stage').boundingBox();
          await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
          await page.mouse.wheel(0, -150);
          await page.waitForTimeout(100);
          const enlarged = Number((await page.locator('#zoom-value').textContent()).replace('%', ''));
          assert.ok(enlarged > before, 'Wheel up must zoom in');
          await page.mouse.wheel(0, 150);
          await page.waitForTimeout(100);
          assert.ok(Number((await page.locator('#zoom-value').textContent()).replace('%', '')) < enlarged, 'Wheel down must zoom out');
          for (let step = 0; step < 3; step++) await page.mouse.wheel(0, 400);
          await page.waitForTimeout(100);
          assert.ok(await page.locator('#zoom-out').isDisabled(), 'Zoom out must stop at the readable text limit');
          await page.locator('#zoom-reset').click();
        }
        const smallText = await page.evaluate(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const small = [];
          while (walker.nextNode()) {
            const node = walker.currentNode, el = node.parentElement;
            if (!node.textContent.trim() || !el || ['SCRIPT', 'STYLE', 'TITLE'].includes(el.tagName.toUpperCase())) continue;
            const box = el.getBoundingClientRect();
            if (!box.width || !box.height || getComputedStyle(el).visibility === 'hidden') continue;
            const matrix = el instanceof SVGGraphicsElement ? el.getScreenCTM() : null;
            const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
            const size = parseFloat(getComputedStyle(el).fontSize) * scale;
            if (size < 12.95) small.push({ text: node.textContent.trim().slice(0, 25), size, tag: el.tagName, cls: el.getAttribute('class') });
          }
          return small;
        });
        assert.deepEqual(smallText, [], `${count} nodes at ${width}px must show text at 13px or larger`);
        const collisions = await page.evaluate(() => {
          const texts = [...document.querySelectorAll('#network text')].map(el => ({ text: el.textContent, box: el.getBoundingClientRect() })).filter(t => t.box.width > 0 && t.box.height > 0);
          const collisions = [];
          for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
            const a = texts[i], b = texts[j];
            if (Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 0.5 && Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 0.5) collisions.push([a.text, b.text]);
          }
          return collisions;
        });
        assert.deepEqual(collisions, [], `${count} nodes at ${width}px must have no text overlap`);
        assert.equal(await page.locator('#network .agent-node').count(), count);
        if (process.env.RELAY_LAYOUT_OUTPUT_DIR && count === 4 && width === 1680) {
          await page.screenshot({ path: join(process.env.RELAY_LAYOUT_OUTPUT_DIR, 'channel-fixed.png'), fullPage: true });
          await page.locator('#network-panel').screenshot({ path: join(process.env.RELAY_LAYOUT_OUTPUT_DIR, 'network-fixed.png') });
        }
        if (count === 4 && width === 1680) {
          await page.locator('#overview-button').click();
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const overviewSmall = await page.locator('#network text').evaluateAll(texts => texts.filter(el => {
            const matrix = el.getScreenCTM(), box = el.getBoundingClientRect();
            return box.width && box.height && parseFloat(getComputedStyle(el).fontSize) * Math.hypot(matrix.a, matrix.b) < 12.95;
          }).map(el => el.textContent));
          assert.deepEqual(overviewSmall, [], 'Overview graph text must also stay at least 13px');
          if (process.env.RELAY_LAYOUT_OUTPUT_DIR) await page.screenshot({ path: join(process.env.RELAY_LAYOUT_OUTPUT_DIR, 'overview-fixed.png'), fullPage: true });
        }
        await page.close();
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    await server.close();
    await source.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
