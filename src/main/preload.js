'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL_RE = /^(app|i18n|settings|auth|users|categories|products|funds|purchases|ledger|report|data):[A-Za-z]+$/;

contextBridge.exposeInMainWorld('api', {
  invoke(channel, payload) {
    if (!CHANNEL_RE.test(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
});
