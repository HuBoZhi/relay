import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/settings.mjs';
import { applySettingsPatch, settingsNeedRestart } from '../lib/settings-transaction.mjs';

describe('desktop settings transaction', () => {
  it('rejects relative and C-drive task roots before writing preferences', async () => {
    const save = vi.fn();
    for (const dataRoot of ['relative-folder', 'C:\\Tasks']) {
      await expect(applySettingsPatch(DEFAULT_SETTINGS, { dataRoot }, { save, applyLogin() {}, loginEnabled: false })).rejects.toThrow();
    }
    expect(save).not.toHaveBeenCalled();
  });
  it('rejects failed persistence without changing login startup or current settings', async () => {
    const current = { ...DEFAULT_SETTINGS };
    const applyLogin = vi.fn();
    await expect(applySettingsPatch(current, { notifications: false, loginAtStartup: true }, {
      save: async () => { throw new Error('disk full'); }, applyLogin, loginEnabled: false,
    })).rejects.toThrow('disk full');
    expect(applyLogin).not.toHaveBeenCalled();
    expect(current.notifications).toBe(true);
  });
  it('rolls the file back if the operating system refuses the login change', async () => {
    const save = vi.fn(async (value) => value);
    await expect(applySettingsPatch(DEFAULT_SETTINGS, { loginAtStartup: true }, {
      save, applyLogin: () => { throw new Error('startup denied'); }, loginEnabled: false,
    })).rejects.toThrow('startup denied');
    expect(save).toHaveBeenLastCalledWith(DEFAULT_SETTINGS);
  });
  it('keeps restart required until runtime matches all connector settings', () => {
    expect(settingsNeedRestart(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, connectors: [] })).toBe(true);
    expect(settingsNeedRestart(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, bridgePort: 7909 })).toBe(true);
    expect(settingsNeedRestart(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, notifications: false })).toBe(false);
  });
});
