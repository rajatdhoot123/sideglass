import { EventEmitter } from 'node:events'
import type { Adb } from './adb'

/**
 * Screenshot fallback: repeated `screencap` frames and `input` taps. Works on any device
 * with no extra binary. `Mirror` uses it when the scrcpy stream cannot start.
 */
export class Screen extends EventEmitter {
  private running = false
  private ticket = 0
  size = { width: 1080, height: 2400 }

  constructor(private readonly adb: Adb) {
    super()
  }

  async start(): Promise<void> {
    const ticket = ++this.ticket
    this.size = await this.adb.screenSize().catch(() => this.size)
    if (ticket !== this.ticket) return
    this.running = true
    void this.loop(ticket)
  }

  stop(): void {
    this.running = false
    this.ticket++
  }

  private async loop(ticket: number): Promise<void> {
    while (this.running && ticket === this.ticket) {
      const started = Date.now()
      try {
        const png = await this.adb.execBuffer(['exec-out', 'screencap', '-p'])
        if (png.length > 0) this.emit('frame', png)
      } catch (error) {
        // A frame can fail while the device reboots or shuts down; report it, never throw.
        if (this.running && ticket === this.ticket) this.emit('frame-error', error)
        await new Promise((r) => setTimeout(r, 1000))
      }
      const wait = Math.max(0, 200 - (Date.now() - started))
      await new Promise((r) => setTimeout(r, wait))
    }
  }

  /** x and y are fractions (0..1) of the shown image. */
  tap(x: number, y: number): Promise<string> {
    const px = Math.round(x * this.size.width)
    const py = Math.round(y * this.size.height)
    return this.adb.shell(`input tap ${px} ${py}`)
  }

  swipe(x1: number, y1: number, x2: number, y2: number, ms: number): Promise<string> {
    const w = this.size.width
    const h = this.size.height
    return this.adb.shell(
      `input swipe ${Math.round(x1 * w)} ${Math.round(y1 * h)} ${Math.round(x2 * w)} ${Math.round(y2 * h)} ${Math.max(50, Math.round(ms))}`,
    )
  }

  key(code: 'BACK' | 'HOME' | 'APP_SWITCH' | 'POWER'): Promise<string> {
    return this.adb.shell(`input keyevent KEYCODE_${code}`)
  }

  text(value: string): Promise<string> {
    // `input text` needs spaces as %s and shell metacharacters escaped.
    const escaped = value.replace(/ /g, '%s').replace(/(["'`\\$&|;<>()])/g, '\\$1')
    return this.adb.shell(`input text "${escaped}"`)
  }
}
