import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Single-quote a command for an inner shell (su -c, sh -c). */
export function shellQuote(command: string): string {
  return `'${command.replaceAll("'", `'\\''`)}'`
}

/** Thin wrapper over the adb binary for one device. */
export class Adb {
  constructor(
    readonly adbPath: string,
    readonly serial: string,
  ) {}

  static async devices(adbPath: string): Promise<{ serial: string; state: string }[]> {
    const { stdout } = await run(adbPath, ['devices'])
    return stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 2 && parts[0])
      .map(([serial, state]) => ({ serial, state }))
  }

  async exec(args: string[], timeoutMs = 60_000, signal?: AbortSignal): Promise<string> {
    const { stdout } = await run(this.adbPath, ['-s', this.serial, ...args], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      signal,
    })
    return stdout
  }

  async execBuffer(args: string[], timeoutMs = 15_000): Promise<Buffer> {
    const { stdout } = await run(this.adbPath, ['-s', this.serial, ...args], {
      timeout: timeoutMs,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout
  }

  shell(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
    return this.exec(['shell', command], timeoutMs, signal)
  }

  spawn(args: string[]): ChildProcess {
    return spawn(this.adbPath, ['-s', this.serial, ...args])
  }

  async waitForBoot(timeoutMs = 240_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    await this.exec(['wait-for-device'], timeoutMs)
    while (Date.now() < deadline) {
      const booted = await this.shell('getprop sys.boot_completed').catch(() => '')
      if (booted.trim() === '1') return
      await new Promise((r) => setTimeout(r, 1500))
    }
    throw new Error(`${this.serial} did not finish booting in ${timeoutMs / 1000}s`)
  }

  /**
   * Run a command as root through Magisk's su (the capture phone is a Play Store image,
   * where `adb root` does not exist). The command is passed to su as one string; quote
   * nested quotes with shellQuote().
   */
  async su(command: string, timeoutMs?: number): Promise<string> {
    return this.shell(`su -c ${shellQuote(command)}`, timeoutMs)
  }

  /**
   * A way to run commands as root: the adb shell itself on images where `adb root` works,
   * Magisk's su on the Play Store capture phone. Null when the phone is not rooted.
   */
  async asRoot(): Promise<((command: string, timeoutMs?: number) => Promise<string>) | null> {
    if ((await this.shell('id -u').catch(() => '')).trim() === '0') return (c, t) => this.shell(c, t)
    if ((await this.su('id -u', 10_000).catch(() => '')).trim() === '0') return (c, t) => this.su(c, t)
    return null
  }

  /** Resolve once `adb devices` no longer lists this serial, in any state. */
  async untilGone(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const listed = (await Adb.devices(this.adbPath)).some((d) => d.serial === this.serial)
      if (!listed) return
      await new Promise((r) => setTimeout(r, 400))
    }
    throw new Error(`${this.serial} did not shut down`)
  }

  /** `adb remount`; returns stdout and stderr together, since adb splits its messages across both. */
  async remount(): Promise<string> {
    const result = await run(this.adbPath, ['-s', this.serial, 'remount'], { timeout: 120_000 }).catch(
      (e: { stdout?: string; stderr?: string; message: string }) => ({ stdout: e.stdout ?? '', stderr: e.stderr || e.message }),
    )
    return `${result.stdout}\n${result.stderr}`
  }

  /** Reboot and wait until the phone has finished booting again. */
  async reboot(timeoutMs = 240_000): Promise<void> {
    await this.exec(['reboot']).catch(() => undefined)
    // `wait-for-device` can return before the phone goes down; wait for it to leave first.
    const down = Date.now() + 60_000
    while (Date.now() < down) {
      const booted = await this.shell('getprop sys.boot_completed', 5_000).catch(() => '')
      if (booted.trim() !== '1') break
      await new Promise((r) => setTimeout(r, 1000))
    }
    await this.waitForBoot(timeoutMs)
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    const out = await this.shell('wm size')
    const match = /Override size: (\d+)x(\d+)/.exec(out) ?? /Physical size: (\d+)x(\d+)/.exec(out)
    if (!match) throw new Error(`Unexpected wm size output: ${out}`)
    return { width: Number(match[1]), height: Number(match[2]) }
  }
}
