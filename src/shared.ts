import type { LogLine } from './main/logcat'
import type { PhoneInput } from './main/timeline'
import type { ExchangeSummary, Exchange, TlsFailure } from './main/proxy'
import type { ProxyRule } from './main/rules'
import type { ReplayEdit } from './main/replay'
import type { Progress } from './main/session'
import type { StorageEntry } from './main/storage'
import type { Refusal, RefusalKind } from './main/refusal'
import type { HooksSnapshot } from './main/hooks'
import type { StoreApp } from './main/store/fdroid'
import type { UsbPhone } from './main/store/usb'
import type { CloneOptions, CloneResult } from './main/clone'
import type { SaveFormat, SaveLayout } from './main/export-calls'

export type { CloneOptions, CloneResult, LogLine, ExchangeSummary, Exchange, TlsFailure, Progress, StoreApp, UsbPhone, PhoneInput, ProxyRule, ReplayEdit, StorageEntry, Refusal, RefusalKind, HooksSnapshot, SaveFormat, SaveLayout }
/** Where a save wrote, and how many requests made it into the file or folder. */
export interface SaveResult {
  path: string
  count: number
  /** Requests the window asked for that were no longer in the session. */
  missing: number
}
export type Device = 'capture' | 'play'
/** Which phone Sideglass captures: its own rooted emulator, or the user's phone over USB. */
export type PhoneMode = 'virtual' | 'usb'
export interface Settings {
  phone?: PhoneMode
  /** For USB mode: the phone to use when more than one is connected. */
  usbSerial?: string
}
export interface LaunchResult {
  device: Device
  pid: number | null
  /** Something the user has to do, shown instead of the usual status. */
  message?: string
  /** True only when this start injected the Frida agent. */
  hooked?: boolean
}
export interface LaunchOptions {
  /** Spawn the app with Frida so certificate checks do not reject the capture proxy. */
  unpin?: boolean
}
export interface SavedSession {
  id: string
  startedAt: number
  count: number
}
export type ScreenMode = 'video' | 'frames'

/** One scrcpy video packet. `pts` is microseconds, as a number so it can cross IPC. */
export interface VideoPacket {
  type: 'configuration' | 'data'
  data: Uint8Array
  keyframe?: boolean
  pts?: number
  width: number
  height: number
}

/** A key from the desktop keyboard, while the phone picture has focus. */
export interface KeyEvent {
  action: 'down' | 'up'
  code: string
  key: string
  repeat: boolean
  alt: boolean
  shift: boolean
  ctrl: boolean
  meta: boolean
}

/** What the window can ask the main process to do. */
export interface Api {
  start(): Promise<void>
  settings(): Promise<Settings>
  /** Saves and stops the current session; call start() afterwards. */
  saveSettings(settings: Settings): Promise<Settings>
  openCertificateSettings(): Promise<void>
  getExchange(id: string): Promise<Exchange | null>
  clear(): Promise<void>
  tap(device: Device, x: number, y: number): Promise<string | null>
  swipe(device: Device, x1: number, y1: number, x2: number, y2: number, ms: number): Promise<string | null>
  key(device: Device, code: 'BACK' | 'HOME' | 'APP_SWITCH' | 'POWER'): Promise<string | null>
  text(device: Device, value: string): Promise<string | null>
  touch(device: Device, action: 'down' | 'move' | 'up' | 'cancel', pointerId: number, x: number, y: number): Promise<string | null>
  scroll(device: Device, x: number, y: number, dx: number, dy: number): Promise<string | null>
  keyEvent(device: Device, event: KeyEvent): Promise<string | null>
  inputShot(id: string, jpeg: string): Promise<void>
  refreshVideo(device: Device): Promise<void>
  useFrames(device: Device): Promise<void>
  screenState(): Promise<Record<Device, ScreenMode>>
  installApk(paths: string[]): Promise<string>
  featured(): Promise<StoreApp[]>
  searchStore(query: string): Promise<StoreApp[]>
  installFromStore(pkg: string): Promise<string>
  installFromPlay(link: string): Promise<string>
  cancelPlay(): Promise<void>
  usbPhones(): Promise<UsbPhone[]>
  usbApps(serial: string): Promise<string[]>
  installFromUsb(serial: string, pkg: string): Promise<string>
  pathForFile(file: File): string
  apps(): Promise<string[]>
  launch(pkg: string, options?: LaunchOptions): Promise<LaunchResult>
  setHooks(enabled: boolean): Promise<HooksSnapshot>
  hooksState(): Promise<HooksSnapshot>
  /** Install a renamed, re-signed copy of an installed app next to the original. */
  cloneApp(options: CloneOptions): Promise<CloneResult>
  copyText(text: string): Promise<void>
  replay(id: string, edit?: ReplayEdit): Promise<void>
  rules(): Promise<ProxyRule[]>
  addRule(rule: Omit<ProxyRule, 'id'>): Promise<ProxyRule[]>
  removeRule(id: string): Promise<ProxyRule[]>
  loadProto(): Promise<string[]>
  decodeSchema(id: string, side: 'request' | 'response', typeName: string): Promise<string>
  sessions(): Promise<SavedSession[]>
  searchSessions(query: string): Promise<ExchangeSummary[]>
  loadSession(id: string): Promise<ExchangeSummary[]>
  openHar(): Promise<ExchangeSummary[] | null>
  storage(pkg: string): Promise<StorageEntry[]>
  sendSms(device: Device, from: string, text: string): Promise<void>
  exportHar(): Promise<string | null>
  /**
   * Write the given requests to a file the user picks.
   * `each` asks for a folder and writes one file per request. Cancelled dialogs return null.
   */
  saveCalls(ids: string[], format: SaveFormat, layout: SaveLayout): Promise<SaveResult | null>
  on(channel: 'progress', cb: (p: Progress) => void): () => void
  on(channel: 'setup-log', cb: (line: string) => void): () => void
  on(channel: 'exchanges', cb: (batch: ExchangeSummary[]) => void): () => void
  on(channel: 'tls-failure', cb: (f: TlsFailure) => void): () => void
  on(channel: 'frame', cb: (device: Device, png: Uint8Array) => void): () => void
  on(channel: 'video', cb: (device: Device, packet: VideoPacket) => void): () => void
  on(channel: 'screen-mode', cb: (device: Device, mode: ScreenMode) => void): () => void
  on(channel: 'store-log', cb: (line: string) => void): () => void
  on(channel: 'play-stage', cb: (stage: { stage: 'needs-user' | 'installing' | 'copying' | 'done'; message: string }) => void): () => void
  on(channel: 'logcat', cb: (lines: LogLine[]) => void): () => void
  on(channel: 'input', cb: (input: PhoneInput) => void): () => void
  on(channel: 'hooks-log', cb: (line: string) => void): () => void
  on(channel: 'hooks-state', cb: (snapshot: HooksSnapshot) => void): () => void
  on(channel: 'app-refusal', cb: (refusal: Refusal) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}
