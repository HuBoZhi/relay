import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

describe('desktop menus across pages', () => {
  for (const name of ['chat', 'tasks']) {
    it(`${name} exposes settings and quit, keyboard navigation, and restores focus on Escape`, async () => {
      const base = new URL('../../web/', import.meta.url);
      const dom = new JSDOM(readFileSync(new URL(`${name}.html`, base), 'utf8'), { runScripts: 'outside-only' });
      try {
        const { window } = dom;
        const run = vi.fn();
        Object.assign(window, { relayDesktop: { menu: async () => [{ label: '应用', items: [
          { id: 'open-settings', label: '设置' }, { id: 'quit', label: '退出' },
        ] }], run } });
        window.eval(readFileSync(new URL('desktop-menu.js', base), 'utf8'));
        (window as any).relayMountDesktopMenu();
        const trigger = window.document.querySelector('#menu-button') as HTMLButtonElement;
        trigger.click();
        await new Promise((done) => setTimeout(done, 0));
        const items = window.document.querySelectorAll('[role=menuitem]');
        expect(items).toHaveLength(2);
        expect(window.document.activeElement === items[0]).toBe(true);
        items[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(window.document.activeElement === items[1]).toBe(true);
        items[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(window.document.querySelector<HTMLElement>('#menu-pop')!.hidden).toBe(true);
        expect(window.document.activeElement === trigger).toBe(true);
        trigger.click(); await new Promise((done) => setTimeout(done, 0));
        (window.document.querySelector('[role=menuitem]') as HTMLButtonElement).click();
        expect(run).toHaveBeenCalledWith('open-settings');
      } finally { dom.window.close(); }
    });
  }
});
