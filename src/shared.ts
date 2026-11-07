import type { LogLine } from './main/logcat'
import type { ExchangeSummary, Exchange, TlsFailure } from './main/proxy'
import type { Progress } from './main/session'
import type { StoreApp } from './main/store/fdroid'
import type { UsbPhone } from './main/store/usb'

export type { LogLine, ExchangeSummary, Exchange, TlsFailure, Progress, StoreApp, UsbPhone }
export type Device = 'capture' | 'play'
export interface LaunchResult {
  device: Device
  pid: number | null
  message?: string
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
  getExchange(id: string): Promise<Exchange | null>
  clear(): Promise<void>
  tap(device: Device, x: number, y: number): Promise<void>
  swipe(device: Device, x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void>
  key(device: Device, code: 'BACK' | 'HOME' | 'APP_SWITCH' | 'POWER'): Promise<void>
  text(device: Device, value: string): Promise<void>
  touch(device: Device, action: 'down' | 'move' | 'up' | 'cancel', pointerId: number, x: number, y: number): Promise<void>
  scroll(device: Device, x: number, y: number, dx: number, dy: number): Promise<void>
  keyEvent(device: Device, event: KeyEvent): Promise<void>
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
  launch(pkg: string): Promise<LaunchResult>
  sendSms(device: Device, from: string, text: string): Promise<void>
  exportHar(): Promise<string | null>
  on(channel: 'progress', cb: (p: Progress) => void): () => void
  on(channel: 'setup-log', cb: (line: string) => void): () => void
  on(channel: 'exchange', cb: (e: ExchangeSummary) => void): () => void
  on(channel: 'tls-failure', cb: (f: TlsFailure) => void): () => void
  on(channel: 'frame', cb: (device: Device, png: Uint8Array) => void): () => void
  on(channel: 'video', cb: (device: Device, packet: VideoPacket) => void): () => void
  on(channel: 'screen-mode', cb: (device: Device, mode: ScreenMode) => void): () => void
  on(channel: 'store-log', cb: (line: string) => void): () => void
  on(channel: 'play-stage', cb: (stage: { stage: 'needs-user' | 'installing' | 'copying' | 'done'; message: string }) => void): () => void
  on(channel: 'logcat', cb: (lines: LogLine[]) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}
