'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glance', {
  init: () => ipcRenderer.invoke('glance:init'),
  onSessions: (fn) => ipcRenderer.on('sessions', (_e, data) => fn(data)),
  onPrefs: (fn) => ipcRenderer.on('prefs', (_e, data) => fn(data)),
  onUsage: (fn) => ipcRenderer.on('usage', (_e, data) => fn(data)),
  refreshUsage: () => ipcRenderer.send('glance:usage-refresh'),
  onAttention: (fn) => ipcRenderer.on('attention', (_e, data) => fn(data)),
  permission: (requestId, decision) => ipcRenderer.send('glance:permission', { requestId, decision }),
  answer: (requestId, answers) => ipcRenderer.send('glance:answer', { requestId, answers }),
  dismiss: (id) => ipcRenderer.send('glance:dismiss', id),
  jump: (id) => ipcRenderer.send('glance:jump', id),
  hide: () => ipcRenderer.send('glance:hide'),
  collapse: (value) => ipcRenderer.send('glance:collapse', value),
  sound: (value) => ipcRenderer.send('glance:sound', value),
  connect: () => ipcRenderer.send('glance:connect'),
  resize: (h) => ipcRenderer.send('glance:resize', h),
  userResize: (size) => ipcRenderer.send('glance:user-resize', size),
});
