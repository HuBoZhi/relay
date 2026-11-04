/**
 * Bridge between the page and the shell.
 *
 * A handful of narrow functions only: the menu model, one whitelisted action, the
 * platform, and the desktop settings the page is allowed to edit. No Node, no
 * filesystem, no arbitrary IPC — the page stays a web page that happens to know it
 * is hosted in a desktop window.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relayDesktop', {
  platform: process.platform,
  menu: () => ipcRenderer.invoke('desktop:menu'),
  run: (id) => ipcRenderer.invoke('desktop:run', String(id)),
  settings: () => ipcRenderer.invoke('desktop:settings:get'),
  patchSettings: (patch) => ipcRenderer.invoke('desktop:settings:patch', patch),
});
