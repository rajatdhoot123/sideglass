import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'
import type { ExchangeSummary, KeyEvent, Settings } from '../shared'
import type { ReplayEdit } from './replay'
import type { ProxyRule } from './rules'
import { fileNames, parseSaveRequest, renderCalls, saveExtension, saveFilterName, unusedName } from './export-calls'
import { toHar } from './har'
import { publicExchange } from './proxy'
import { appendLog, installQuietLog } from './quiet'
import { Batcher } from './batch'
import { Session } from './session'
import { loadSettings, saveSettings } from './settings'
import { findSdk, sdkAt } from './sdk'
import { usbPhones } from './store/usb'
import type { CloneOptions, CodeSearchOptions } from '../shared'

let session: Session | null = null
let window: BrowserWindow | null = null
/** Busy apps make hundreds of requests a second. The window gets them in batches, not one by one. */
let exchangeBatch: Batcher<ExchangeSummary> | null = null

function send(channel: string, ...args: unknown[]): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
}

const windowColor = () => (nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f4f5f7')

function createWindow(): void {
  window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    title: 'Sideglass',
    backgroundColor: windowColor(),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true },
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

const settingsFile = () => join(app.getPath('userData'), 'settings.json')

function requireSession(): Session {
  if (!session) throw new Error('Session not started')
  return session
}

ipcMain.handle('session:start', async () => {
  // A leftover session (for example its phone died under it) must not swallow the click.
  if (session) {
    const stale = session
    session = null
    await stale.stop().catch(() => undefined)
  }
  const settings = loadSettings(settingsFile())
  if (!settings.phone) return
  const current = new Session(join(app.getPath('userData'), 'data'), settings)
  session = current
  current.on('progress', (p) => send('progress', p))
  current.on('setup-log', (l) => {
    send('setup-log', l)
    appendLog(join(app.getPath('userData'), 'sideglass.log'), l)
  })
  current.on('frame', (png: Buffer) => send('frame', 'capture', new Uint8Array(png)))
  current.on('play-frame', (png: Buffer) => send('frame', 'play', new Uint8Array(png)))
  current.on('video', (packet) => send('video', 'capture', packet))
  current.on('play-video', (packet) => send('video', 'play', packet))
  current.on('screen-mode', (mode) => send('screen-mode', 'capture', mode))
  current.on('play-screen-mode', (mode) => send('screen-mode', 'play', mode))
  current.on('store-log', (l) => send('store-log', l))
  current.on('play-stage', (st) => send('play-stage', st))
  current.on('logcat', (lines) => send('logcat', lines))
  current.on('hooks-log', (l) => send('hooks-log', l))
  current.on('hooks-state', (s) => send('hooks-state', s))
  current.on('app-refusal', (r) => send('app-refusal', r))
  current.on('code-progress', (p) => send('code-progress', p))
  exchangeBatch?.discard()
  const batch = new Batcher<ExchangeSummary>((items) => send('exchanges', items))
  exchangeBatch = batch
  current.proxy.on('exchange', (e: ExchangeSummary) => batch.push(e))
  current.proxy.on('tls-failure', (f) => send('tls-failure', f))
  try {
    await current.start()
  } catch (error) {
    send('setup-log', `Setup stopped: ${(error as Error).message}`)
    // A settings change may already have replaced this session. Don't drop the new one.
    if (session === current) session = null
    await current.stop().catch(() => undefined)
  }
})
ipcMain.handle('settings:get', () => loadSettings(settingsFile()))
// Saving stops the current session; the window then starts a new one with the new choice.
ipcMain.handle('settings:save', async (_, settings: Settings) => {
  const previous = session
  session = null
  await previous?.stop().catch(() => undefined)
  return saveSettings(settingsFile(), settings)
})
ipcMain.handle('cert:open-settings', () => requireSession().openCertificateSettings())
ipcMain.handle('exchange:get', (_, id: string) => {
  const exchange = requireSession().getExchange(id)
  return exchange ? publicExchange(exchange) : null
})
ipcMain.handle('capture:clear', () => {
  const current = requireSession()
  exchangeBatch?.discard()
  current.proxy.clear()
  current.timeline.clear()
})
type Device = 'capture' | 'play'
const screenOf = (_device: Device) => requireSession().screen
const point = (device: Device, x: number, y: number) => {
  const size = screenOf(device)?.frames.size ?? { width: 1080, height: 2400 }
  return `${Math.round(x * size.width)},${Math.round(y * size.height)}`
}
/** Record one thing the user did on the phone. Returns an id the window can attach a thumbnail to. */
function note(device: Device, kind: 'tap' | 'swipe' | 'scroll' | 'key' | 'text', label: string): string | null {
  if (!session) return null
  const input = session.timeline.add({ device, kind, label })
  send('input', input)
  return input.id
}
const fingers = new Map<string, { x: number; y: number }>()
const lastScroll = new Map<Device, number>()
ipcMain.handle('screen:tap', (_, device: Device, x: number, y: number) => {
  const id = note(device, 'tap', `Tap at ${point(device, x, y)}`)
  void screenOf(device)?.tap(x, y)
  return id
})
ipcMain.handle('screen:swipe', (_, device: Device, x1: number, y1: number, x2: number, y2: number, ms: number) => {
  const id = note(device, 'swipe', `Swipe from ${point(device, x1, y1)} to ${point(device, x2, y2)}`)
  void screenOf(device)?.swipe(x1, y1, x2, y2, ms)
  return id
})
ipcMain.handle('screen:key', (_, device: Device, code: 'BACK' | 'HOME' | 'APP_SWITCH' | 'POWER') => {
  const id = note(device, 'key', code === 'APP_SWITCH' ? 'Recent apps' : code[0] + code.slice(1).toLowerCase())
  void screenOf(device)?.key(code)
  return id
})
ipcMain.handle('screen:text', (_, device: Device, value: string) => {
  const id = note(device, 'text', `Type “${value.slice(0, 80)}”`)
  void screenOf(device)?.text(value)
  return id
})
ipcMain.handle('screen:touch', (_, device: Device, action: 'down' | 'move' | 'up' | 'cancel', pointerId: number, x: number, y: number) => {
  const key = `${device}:${pointerId}`
  if (action === 'down') fingers.set(key, { x, y })
  if (action === 'cancel') fingers.delete(key)
  let id: string | null = null
  if (action === 'up') {
    const start = fingers.get(key)
    fingers.delete(key)
    // A right-click, or an up whose down was lost, must not steal the next two seconds of requests.
    if (start) {
      const moved = Math.hypot(x - start.x, y - start.y) >= 0.02
      id = note(
        device,
        moved ? 'swipe' : 'tap',
        moved ? `Swipe from ${point(device, start.x, start.y)} to ${point(device, x, y)}` : `Tap at ${point(device, x, y)}`,
      )
    }
  }
  void screenOf(device)?.touch(action, pointerId, x, y)
  return id
})
ipcMain.handle('screen:scroll', (_, device: Device, x: number, y: number, dx: number, dy: number) => {
  const now = Date.now()
  const id = now - (lastScroll.get(device) ?? 0) > 400 ? note(device, 'scroll', `Scroll at ${point(device, x, y)}`) : null
  if (id) lastScroll.set(device, now)
  void screenOf(device)?.scroll(x, y, dx, dy)
  return id
})
ipcMain.handle('screen:keyevent', (_, device: Device, event: KeyEvent) => {
  const id = event.action === 'down' && !event.repeat ? note(device, 'key', event.key.length === 1 ? `Key “${event.key}”` : event.code) : null
  void screenOf(device)?.keyEvent(event)
  return id
})
ipcMain.handle('input:shot', (_, id: string, shot: string) => {
  if (typeof shot !== 'string' || shot.length > 200_000) return
  const input = requireSession().timeline.shot(id, shot)
  if (input) send('input', input)
})
ipcMain.handle('screen:refresh', (_, device: Device) => screenOf(device)?.refresh())
ipcMain.handle('screen:frames', (_, device: Device) => screenOf(device)?.useFrames())
ipcMain.handle('screen:state', () => ({
  capture: requireSession().screen?.mode ?? 'frames',
  play: requireSession().screen?.mode ?? 'frames',
}))
ipcMain.handle('apk:install', (_, paths: string[]) => requireSession().installApk(paths))
ipcMain.handle('store:featured', () => requireSession().featuredApps())
ipcMain.handle('store:search', (_, q: string) => requireSession().searchStore(q))
ipcMain.handle('store:install', (_, pkg: string) => requireSession().installFromStore(pkg))
ipcMain.handle('play:install', (_, link: string) => requireSession().installFromPlay(link))
ipcMain.handle('play:cancel', () => requireSession().cancelPlay())
// Also used before any session exists (first-run choice, settings), so it only needs the SDK.
ipcMain.handle('usb:phones', () => {
  const sdk = findSdk() ?? sdkAt(join(homedir(), '.sideglass', 'android-sdk'))
  return sdk && existsSync(sdk.adb) ? usbPhones(sdk.adb) : []
})
ipcMain.handle('usb:apps', (_, serial: string) => requireSession().usbApps(serial))
ipcMain.handle('usb:install', (_, serial: string, pkg: string) => requireSession().installFromUsb(serial, pkg))
ipcMain.handle('apps:list', () => requireSession().packages())
ipcMain.handle('app:clone', (_, options: CloneOptions) => requireSession().cloneApp(options))
ipcMain.handle('app:launch', (_, pkg: string, options?: { unpin?: boolean }) => requireSession().launch(pkg, options))
ipcMain.handle('hooks:set', (_, enabled: boolean) => requireSession().setHooksEnabled(Boolean(enabled)))
ipcMain.handle('hooks:state', () => requireSession().hooksState())
ipcMain.handle('clipboard:write', (_, text: string) => {
  if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Nothing to copy')
  clipboard.writeText(text)
})
ipcMain.handle('request:replay', (_, id: string, edit?: ReplayEdit) => requireSession().replay(id, edit))
ipcMain.handle('rule:list', () => requireSession().listRules())
ipcMain.handle('rule:add', (_, rule: Omit<ProxyRule, 'id'>) => requireSession().addRule(rule))
ipcMain.handle('rule:remove', (_, id: string) => requireSession().removeRule(id))
ipcMain.handle('proto:load', async () => {
  const picked = await dialog.showOpenDialog({
    title: 'Load a .proto file',
    filters: [{ name: 'Protocol buffer', extensions: ['proto'] }],
    properties: ['openFile'],
  })
  if (picked.canceled || !picked.filePaths[0]) return []
  return requireSession().loadProto(picked.filePaths[0])
})
ipcMain.handle('proto:decode', (_, id: string, side: 'request' | 'response', typeName: string) => requireSession().decodeSchema(id, side, typeName))
ipcMain.handle('history:list', () => requireSession().sessions())
ipcMain.handle('history:search', (_, query: string) => requireSession().searchSessions(query))
ipcMain.handle('history:load', (_, id: string) => requireSession().loadSession(id))
ipcMain.handle('har:open', async () => {
  const picked = await dialog.showOpenDialog({
    title: 'Open a HAR file',
    filters: [{ name: 'HAR', extensions: ['har'] }],
    properties: ['openFile'],
  })
  if (picked.canceled || !picked.filePaths[0]) return null
  return requireSession().openHarText(readFileSync(picked.filePaths[0], 'utf8'))
})
ipcMain.handle('storage:list', (_, pkg: string) => requireSession().storage(pkg))
ipcMain.handle('code:decompile', (_, pkg: string, force?: boolean) => requireSession().decompile(pkg, force))
ipcMain.handle('code:cancel', (_, pkg: string) => requireSession().cancelDecompile(pkg))
ipcMain.handle('code:index', (_, pkg: string) => requireSession().codeIndex(pkg))
ipcMain.handle('code:file', (_, pkg: string, file: string) => requireSession().codeFile(pkg, String(file)))
ipcMain.handle('code:search', (_, pkg: string, query: string, options?: CodeSearchOptions) =>
  requireSession().searchCode(pkg, String(query), { skipLibraries: Boolean(options?.skipLibraries), matchCase: Boolean(options?.matchCase) }),
)
ipcMain.handle('code:export', async (_, pkg: string) => {
  const current = requireSession()
  const exportName = current.codeExportName(pkg)
  const picked = await dialog.showOpenDialog({
    title: `Export the decompiled code of ${pkg}`,
    buttonLabel: 'Export here',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (picked.canceled || !picked.filePaths[0]) return null
  const dir = picked.filePaths[0]
  // A new folder, so an export never mixes with files already there.
  const folder = join(dir, unusedName(exportName, (name) => existsSync(join(dir, name))))
  const count = await current.exportCode(pkg, folder)
  shell.showItemInFolder(folder)
  return { path: folder, count }
})
ipcMain.handle('sms:send', (_, device: Device, from: string, text: string) => requireSession().sendSms(device, from, text))
ipcMain.handle('har:export', async () => {
  const s = requireSession()
  const target = await dialog.showSaveDialog({ defaultPath: `capture-${Date.now()}.har` })
  if (target.canceled || !target.filePath) return null
  writeFileSync(target.filePath, JSON.stringify(toHar([...s.proxy.exchanges.values()], s.timeline.inputs), null, 2))
  return target.filePath
})
ipcMain.handle('calls:save', async (_, ids: unknown, format: unknown, layout: unknown) => {
  const request = parseSaveRequest(ids, format, layout)
  const current = requireSession()
  // Bodies stay in the main process. The window only says which rows it is showing.
  const exchanges = request.ids.flatMap((id) => {
    const found = current.getExchange(id)
    return found ? [found] : []
  })
  if (exchanges.length === 0) throw new Error('Those requests are no longer in this session')
  // Older live requests drop out of the session. Say how many, so a short file is not a surprise.
  const missing = request.ids.length - exchanges.length
  if (request.layout === 'each') {
    const picked = await dialog.showOpenDialog({
      title: `Save ${exchanges.length} files, one request each`,
      buttonLabel: 'Save here',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const dir = picked.filePaths[0]
    // A new folder, so a second save does not mix with files the user already has.
    const folder = join(dir, unusedName(`sideglass-${exchanges.length}`, (name) => existsSync(join(dir, name))))
    mkdirSync(folder)
    const names = fileNames(exchanges, request.format)
    try {
      exchanges.forEach((exchange, index) => writeFileSync(join(folder, names[index]), renderCalls([exchange], request.format)))
    } catch (error) {
      // The folder is new, so removing it leaves nothing half written behind.
      rmSync(folder, { recursive: true, force: true })
      throw error
    }
    return { path: folder, count: exchanges.length, missing }
  }
  const target = await dialog.showSaveDialog({
    title: `Save ${exchanges.length} requests`,
    defaultPath: `sideglass-${exchanges.length}.${saveExtension(request.format)}`,
    filters: [{ name: saveFilterName(request.format), extensions: [saveExtension(request.format)] }],
  })
  if (target.canceled || !target.filePath) return null
  writeFileSync(target.filePath, renderCalls(exchanges, request.format))
  return { path: target.filePath, count: exchanges.length, missing }
})

app.whenReady().then(() => {
  const logFile = join(app.getPath('userData'), 'sideglass.log')
  installQuietLog(logFile)
  appendLog(logFile, `Sideglass ${new Date().toISOString()}`)
  createWindow()
  nativeTheme.on('updated', () => {
    if (window && !window.isDestroyed()) window.setBackgroundColor(windowColor())
  })
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
