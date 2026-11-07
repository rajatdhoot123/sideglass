import { contextBridge, ipcRenderer, webUtils } from 'electron'

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('api', {
  start: invoke('session:start'),
  getExchange: invoke('exchange:get'),
  clear: invoke('capture:clear'),
  tap: invoke('screen:tap'),
  swipe: invoke('screen:swipe'),
  key: invoke('screen:key'),
  text: invoke('screen:text'),
  installApk: invoke('apk:install'),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  apps: invoke('apps:list'),
  launch: invoke('app:launch'),
  sendSms: invoke('sms:send'),
  exportHar: invoke('har:export'),
  on: (channel: string, cb: (...args: unknown[]) => void) => {
    const listener = (_: unknown, ...args: unknown[]) => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
})
