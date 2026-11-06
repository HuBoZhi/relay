import { describe, expect, it, vi } from 'vitest';
import { shutdownDesktop } from '../lib/shutdown.mjs';
import { startManagedBridge } from '../lib/bridge-process.mjs';

describe('desktop exit', () => {
  it('does not start a bridge after exit, and handles missing executables without crashing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(startManagedBridge({ signal: controller.signal, executablePath: 'D:/missing-relay.exe' }))
      .resolves.toMatchObject({ managed: false });
    await expect(startManagedBridge({ engineUrl: 'http://127.0.0.1:1', dataDir: 'D:/unused', executablePath: 'D:/missing-relay.exe' }))
      .resolves.toMatchObject({ managed: false });
  });
  it('waits for settings, closes ingress and bridge, then flushes the engine', async () => {
    const order: string[] = [];
    let finishSave!: () => void;
    const saving = new Promise<void>((resolve) => { finishSave = resolve; });
    const pending = shutdownDesktop({
      unsubscribe: () => order.push('unsubscribe'),
      room: { close: async () => { order.push('room'); } },
      bridge: { stop: async () => { order.push('bridge'); } },
      settingsUpdates: saving,
      engine: { close: async () => { order.push('engine'); } },
    });
    await Promise.resolve();
    expect(order).not.toContain('engine');
    finishSave();
    await pending;
    expect(order[0]).toBe('unsubscribe');
    expect(order.at(-1)).toBe('engine');
  });
  it('still closes the engine when a bridge fails and bounds a hung shutdown', async () => {
    const close = vi.fn(async () => {});
    await shutdownDesktop({ bridge: { stop: async () => { throw new Error('stopped'); } }, engine: { close } });
    expect(close).toHaveBeenCalledOnce();
    await expect(shutdownDesktop({ room: { close: () => new Promise(() => {}) } }, 10))
      .resolves.toMatchObject({ timedOut: true });
  });
});
