import { EventEmitter } from 'node:events'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Adb } from './adb'

/**
 * Screenshot fallback: repeated `screencap` frames and `input` taps. Works on any device
 * with no extra binary. `Mirror` uses it when the scrcpy stream cannot start.
 *
 * With `shotDir` (emulators only) frames come from the emulator itself instead. Android
 * blanks FLAG_SECURE windows (PIN pads, banking screens) in `screencap` and scrcpy, but
 * the emulator's own screenshot is of the composed display, so they show.
 */
export class Screen extends EventEmitter {
  private running = false
  private ticket = 0
  size = { width: 1080, height: 2400 }

  constructor(
    private readonly adb: Adb,
    private readonly shotDir?: string,
  ) {
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
        const png = this.shotDir ? await this.emulatorShot(this.shotDir) : await this.adb.execBuffer(['exec-out', 'screencap', '-p'])
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

  /** One PNG from the emulator console. It names the file itself, so the folder is emptied each time. */
  private async emulatorShot(dir: string): Promise<Buffer> {
    // The console would split a path with spaces and save into the emulator's working folder.
    if (/\s/.test(dir)) throw new Error('emulator screenshot folder must not contain spaces')
    await mkdir(dir, { recursive: true })
    for (const old of await readdir(dir)) await rm(join(dir, old), { force: true })
    await this.adb.exec(['emu', 'screenrecord', 'screenshot', dir], 10_000)
    const files = (await readdir(dir)).filter((name) => name.endsWith('.png'))
    if (!files.length) throw new Error('the emulator saved no screenshot')
    const png = await readFile(join(dir, files[0]))
    await rm(join(dir, files[0]), { force: true })
    return png
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
