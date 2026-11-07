import type { LogLine } from './main/logcat'
import type { ExchangeSummary, Exchange, TlsFailure } from './main/proxy'
import type { Progress } from './main/session'
import type { StoreApp } from './main/store/fdroid'
import type { UsbPhone } from './main/store/usb'

export type { LogLine, ExchangeSummary, Exchange, TlsFailure, Progress, StoreApp, UsbPhone }
export type Device = 'capture' | 'play'
/** Which phone Sideglass captures: its own rooted emulator, or the user's phone over USB. */
export type PhoneMode = 'virtual' | 'usb'
export interface Settings {
  phone?: PhoneMode
  /** For USB mode: the phone to use when more than one is connected. */
  usbSerial?: string
}
export interface LaunchResult {
  pid: number | null
  /** Something the user has to do, shown instead of the usual status. */
  message?: string
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
  tap(device: Device, x: number, y: number): Promise<void>
  swipe(device: Device, x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void>
  key(device: Device, code: 'BACK' | 'HOME' | 'APP_SWITCH' | 'POWER'): Promise<void>
  text(device: Device, value: string): Promise<void>
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
  launch(pkg: string): Promise<LaunchResult>
  sendSms(from: string, text: string): Promise<void>
  exportHar(): Promise<string | null>
  on(channel: 'progress', cb: (p: Progress) => void): () => void
  on(channel: 'setup-log', cb: (line: string) => void): () => void
  on(channel: 'exchange', cb: (e: ExchangeSummary) => void): () => void
  on(channel: 'tls-failure', cb: (f: TlsFailure) => void): () => void
  on(channel: 'frame', cb: (device: Device, png: Uint8Array) => void): () => void
  on(channel: 'store-log', cb: (line: string) => void): () => void
  on(channel: 'play-stage', cb: (stage: { stage: 'needs-user' | 'installing' | 'copying' | 'done'; message: string }) => void): () => void
  on(channel: 'logcat', cb: (lines: LogLine[]) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}
