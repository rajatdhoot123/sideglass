import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { KeyEvent } from '../shared'
import { toHar } from './har'
import { Session } from './session'

let session: Session | null = null
let window: BrowserWindow | null = null

function send(channel: string, ...args: unknown[]): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    title: 'Sideglass',
    backgroundColor: '#0f1115',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true },
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

function requireSession(): Session {
  if (!session) throw new Error('Session not started')
  return session
}

ipcMain.handle('session:start', async () => {
  if (session) return
  session = new Session(join(app.getPath('userData'), 'data'))
  session.on('progress', (p) => send('progress', p))
  session.on('setup-log', (l) => send('setup-log', l))
  session.on('frame', (png: Buffer) => send('frame', 'capture', new Uint8Array(png)))
  session.on('play-frame', (png: Buffer) => send('frame', 'play', new Uint8Array(png)))
  session.on('video', (packet) => send('video', 'capture', packet))
  session.on('play-video', (packet) => send('video', 'play', packet))
  session.on('screen-mode', (mode) => send('screen-mode', 'capture', mode))
  session.on('play-screen-mode', (mode) => send('screen-mode', 'play', mode))
  session.on('store-log', (l) => send('store-log', l))
  session.on('play-stage', (st) => send('play-stage', st))
  session.on('logcat', (lines) => send('logcat', lines))
  session.proxy.on('exchange', (e) => send('exchange', e))
  session.proxy.on('tls-failure', (f) => send('tls-failure', f))
  try {
    await session.start()
  } catch (error) {
    send('setup-log', `Setup stopped: ${(error as Error).message}`)
    const failed = session
    session = null
    await failed.stop().catch(() => undefined)
  }
})
ipcMain.handle('exchange:get', (_, id: string) => requireSession().proxy.exchanges.get(id) ?? null)
ipcMain.handle('capture:clear', () => requireSession().proxy.clear())
type Device = 'capture' | 'play'
const screenOf = (device: Device) => (device === 'play' ? requireSession().play?.screen : requireSession().screen)
ipcMain.handle('screen:tap', (_, device: Device, x: number, y: number) => screenOf(device)?.tap(x, y))
ipcMain.handle('screen:swipe', (_, device: Device, x1: number, y1: number, x2: number, y2: number, ms: number) =>
  screenOf(device)?.swipe(x1, y1, x2, y2, ms),
)
ipcMain.handle('screen:key', (_, device: Device, code: 'BACK' | 'HOME' | 'APP_SWITCH' | 'POWER') => screenOf(device)?.key(code))
ipcMain.handle('screen:text', (_, device: Device, value: string) => screenOf(device)?.text(value))
ipcMain.handle('screen:touch', (_, device: Device, action: 'down' | 'move' | 'up' | 'cancel', pointerId: number, x: number, y: number) =>
  screenOf(device)?.touch(action, pointerId, x, y),
)
ipcMain.handle('screen:scroll', (_, device: Device, x: number, y: number, dx: number, dy: number) =>
  screenOf(device)?.scroll(x, y, dx, dy),
)
ipcMain.handle('screen:keyevent', (_, device: Device, event: KeyEvent) => screenOf(device)?.keyEvent(event))
ipcMain.handle('screen:refresh', (_, device: Device) => screenOf(device)?.refresh())
ipcMain.handle('screen:frames', (_, device: Device) => screenOf(device)?.useFrames())
ipcMain.handle('screen:state', () => ({
  capture: requireSession().screen?.mode ?? 'frames',
  play: requireSession().play?.screen?.mode ?? 'frames',
}))
ipcMain.handle('apk:install', (_, paths: string[]) => requireSession().installApk(paths))
ipcMain.handle('store:featured', () => requireSession().featuredApps())
ipcMain.handle('store:search', (_, q: string) => requireSession().searchStore(q))
ipcMain.handle('store:install', (_, pkg: string) => requireSession().installFromStore(pkg))
ipcMain.handle('play:install', (_, link: string) => requireSession().installFromPlay(link))
ipcMain.handle('play:cancel', () => requireSession().cancelPlay())
ipcMain.handle('usb:phones', () => requireSession().usbPhones())
ipcMain.handle('usb:apps', (_, serial: string) => requireSession().usbApps(serial))
ipcMain.handle('usb:install', (_, serial: string, pkg: string) => requireSession().installFromUsb(serial, pkg))
ipcMain.handle('apps:list', () => requireSession().packages())
ipcMain.handle('app:launch', (_, pkg: string) => requireSession().launch(pkg))
ipcMain.handle('sms:send', (_, from: string, text: string) => requireSession().sendSms(from, text))
ipcMain.handle('har:export', async () => {
  const s = requireSession()
  const target = await dialog.showSaveDialog({ defaultPath: `capture-${Date.now()}.har` })
  if (target.canceled || !target.filePath) return null
  writeFileSync(target.filePath, JSON.stringify(toHar([...s.proxy.exchanges.values()]), null, 2))
  return target.filePath
})

app.whenReady().then(() => {
  createWindow()
  // Debug aid: SIDEGLASS_SNAPSHOT=/path/file.png saves the window every 3 s (for screenshots in tests and docs).
  const snapshot = process.env.SIDEGLASS_SNAPSHOT
  if (snapshot) {
    setInterval(async () => {
      if (!window || window.isDestroyed()) return
      const image = await window.webContents.capturePage()
      writeFileSync(snapshot, image.toPNG())
    }, 3000)
  }
})
app.on('window-all-closed', async () => {
  await session?.stop().catch(() => undefined)
  app.quit()
})
