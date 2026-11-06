import { describe, expect, it } from 'vitest';
import { restoreWindowState } from '../lib/window-state.mjs';

const displays = [{ x: 0, y: 0, width: 1024, height: 640 }];
describe('window restoration', () => {
  it('keeps the whole window reachable after a monitor is unplugged', () => {
    const restored = restoreWindowState({ x: 4000, y: -1000, width: 1360, height: 900, maximized: true }, displays);
    expect(restored.bounds).toEqual({ x: 0, y: 0, width: 1024, height: 640 });
    expect(restored.maximized).toBe(true);
  });
  it('restores size, position and zoom on a still-connected monitor', () => {
    const state = { x: 25, y: 20, width: 950, height: 600, zoomLevel: 0.5 };
    expect(restoreWindowState(state, displays)).toMatchObject({ bounds: { x: 25, y: 20, width: 950, height: 600 }, zoomLevel: 0.5 });
  });
  it('recovers safely from corrupt or implausible geometry', () => {
    const restored = restoreWindowState({ x: NaN, y: Infinity, width: -20, height: 'wrong', zoomLevel: 99 }, displays);
    expect(restored.bounds).toEqual({ x: 0, y: 0, width: 1024, height: 640 });
    expect(restored.zoomLevel).toBe(0);
  });
});
