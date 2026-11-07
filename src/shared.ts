import type { LogLine } from './main/logcat'
import type { ExchangeSummary, Exchange, TlsFailure } from './main/proxy'
import type { Progress } from './main/session'

export type { LogLine, ExchangeSummary, Exchange, TlsFailure, Progress }

/** What the window can ask the main process to do. */
export interface Api {
  start(): Promise<void>
  getExchange(id: string): Promise<Exchange | null>
  clear(): Promise<void>
  tap(x: number, y: number): Promise<void>
  swipe(x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void>
  key(code: 'BACK' | 'HOME' | 'APP_SWITCH' | 'POWER'): Promise<void>
  text(value: string): Promise<void>
  installApk(paths: string[]): Promise<string>
  pathForFile(file: File): string
  apps(): Promise<string[]>
  launch(pkg: string): Promise<number | null>
  sendSms(from: string, text: string): Promise<void>
  exportHar(): Promise<string | null>
  on(channel: 'progress', cb: (p: Progress) => void): () => void
  on(channel: 'setup-log', cb: (line: string) => void): () => void
  on(channel: 'exchange', cb: (e: ExchangeSummary) => void): () => void
  on(channel: 'tls-failure', cb: (f: TlsFailure) => void): () => void
  on(channel: 'frame', cb: (png: Uint8Array) => void): () => void
  on(channel: 'logcat', cb: (lines: LogLine[]) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}
