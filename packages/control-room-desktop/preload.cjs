/**
 * Bridge between the page and the shell.
 *
 * Three narrow functions only: read the menu model, run one whitelisted action,
 * and learn the platform. No Node, no filesystem, no arbitrary IPC — the page
 * stays a web page that happens to know it is hosted in a desktop window.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relayDesktop', {
  platform: process.platform,
  menu: () => ipcRenderer.invoke('desktop:menu'),
  run: (id) => ipcRenderer.invoke('desktop:run', String(id)),
});
