/**
 * Desktop settings inside the page.
 *
 * Two behaviours matter here: the bridge list is only editable when the shell is
 * present (a browser page cannot change how the app starts), and an address that is
 * not loopback never reaches the shell.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const settle = () => new Promise((done) => setTimeout(done, 0));

function summary() {
  const now = '2026-11-04T09:00:00.000Z';
  return {
    generatedAt: now,
    dataRoot: 'D:\\RelayData\\async',
    warnings: [],
    topics: [],
    tasks: [],
    stages: [],
    runs: [],
    callbacks: [],
    messages: [],
    clients: [],
    counts: {
      tasks: 0,
      inFlight: 0,
      awaitingConfirmation: 0,
      callbacksPendingDelivery: 0,
      callbacksManual: 0,
      failed: 0,
    },
  };
}

describe('desktop settings page', () => {
  let dom: JSDOM | null = null;

  afterEach(() => {
    dom?.window.close();
    dom = null;
  });

  async function setup(settings = {}) {
    const patches = [];
    dom = new JSDOM(readFileSync(resolve(web, 'tasks.html'), 'utf8'), {
      url: 'http://localhost/tasks.html',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    (window as unknown as { EventSource: unknown }).EventSource = class {
      addEventListener() {}
      close() {}
    };
    (window as unknown as { fetch: unknown }).fetch = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => (String(url).includes('summary') ? JSON.stringify(summary()) : '{}'),
    }));
    (window as unknown as { relayDesktop: unknown }).relayDesktop = {
      platform: 'win32',
      menu: async () => [],
      run: async () => true,
      settings: async () => ({
        settings: {
          closeToTray: false,
          notifications: true,
          loginAtStartup: false,
          dataRoot: null,
          bridges: [],
          ...settings,
        },
        effectiveDataRoot: 'D:\\RelayData\\async',
        warnings: [],
        version: '14.0.0',
        packaged: false,
        loginAtStartup: false,
      }),
      patchSettings: async (patch: unknown) => {
        patches.push(patch);
        return {
          settings: {
            closeToTray: false,
            notifications: true,
            loginAtStartup: false,
            dataRoot: null,
            ...(patch as object),
          },
          effectiveDataRoot: 'D:\\RelayData\\async',
          warnings: [],
          version: '14.0.0',
          packaged: false,
          loginAtStartup: false,
          restartRequired: true,
        };
      },
    };
    window.eval(readFileSync(resolve(web, 'icons.js'), 'utf8'));
    window.eval(readFileSync(resolve(web, 'tasks.js'), 'utf8'));
    await settle();
    await settle();
    await settle();
    const element = (selector: string) => window.document.querySelector(selector) as HTMLElement | null;
    return { window, patches, element, text: () => window.document.body.textContent || '' };
  }

  it('offers the bridge editor when hosted by the shell', async () => {
    const ui = await setup({ bridges: [{ client: 'zcode', url: 'http://127.0.0.1:7901' }] });
    ui.element('[data-nav="settings"]')?.click();
    await settle();
    expect(ui.text()).toContain('派发桥接');
    expect(ui.text()).toContain('http://127.0.0.1:7901');
    expect(ui.text()).toContain('移除');
  });

  it('adds a loopback bridge and asks for a restart', async () => {
    const ui = await setup();
    ui.element('[data-nav="settings"]')?.click();
    await settle();
    (ui.element('#bridge-client') as HTMLSelectElement).value = 'zcode';
    (ui.element('#bridge-url') as HTMLInputElement).value = 'http://127.0.0.1:7901';
    ui.element('#add-bridge')?.click();
    await settle();
    await settle();

    expect(ui.patches).toHaveLength(1);
    expect((ui.patches[0] as { bridges: unknown[] }).bridges).toEqual([
      { client: 'zcode', url: 'http://127.0.0.1:7901' },
    ]);
    expect(ui.text()).toContain('重启后生效');
  });

  it('refuses a bridge that is not on this machine', async () => {
    const ui = await setup();
    ui.element('[data-nav="settings"]')?.click();
    await settle();
    (ui.element('#bridge-url') as HTMLInputElement).value = 'http://10.0.0.5:7901';
    ui.element('#add-bridge')?.click();
    await settle();

    expect(ui.patches).toHaveLength(0);
    expect(ui.text()).toContain('本机回环地址');
  });
});
