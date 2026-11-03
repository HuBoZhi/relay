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
  const server = await startControlRoom({ source, port: 0, webRoot: fileURLToPath(new URL('../web/', import.meta.url)), log: () => {} });
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
