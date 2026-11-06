import { mergeSettings } from './settings.mjs';

export function settingsNeedRestart(active, next) {
  return ['dataRoot', 'connectors', 'bridgePort', 'bridges'].some(
    (key) => JSON.stringify(active[key]) !== JSON.stringify(next[key])
  );
}

/** Commit persistent preferences before exposing them to the running window. */
export async function applySettingsPatch(current, patch, { save, applyLogin, loginEnabled }) {
  const next = mergeSettings(current, patch);
  await save(next);
  try {
    // Unrelated edits must not silently rewrite login startup.
    if ('loginAtStartup' in patch && next.loginAtStartup !== loginEnabled) {
      await applyLogin(next.loginAtStartup);
    }
  } catch (error) {
    await save(current);
    throw error;
  }
  return next;
}
