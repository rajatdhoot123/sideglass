import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Thin wrapper over the adb binary for one device. */
export class Adb {
  constructor(
    private readonly adbPath: string,
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

  async exec(args: string[], timeoutMs = 60_000): Promise<string> {
    const { stdout } = await run(this.adbPath, ['-s', this.serial, ...args], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
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

  shell(command: string, timeoutMs?: number): Promise<string> {
    return this.exec(['shell', command], timeoutMs)
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

  /** Restart adbd as root. Works on Google APIs (userdebug) images, not Play Store images. */
  async root(): Promise<void> {
    const out = await this.exec(['root']).catch((e: Error) => e.message)
    if (/cannot run as root/i.test(out)) {
      throw new Error('This emulator image cannot run as root. Use a Google APIs image, not Google Play.')
    }
    await this.exec(['wait-for-device'])
    const id = (await this.shell('id -u')).trim()
    if (id !== '0') throw new Error(`adb root did not take effect (uid ${id})`)
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    const out = await this.shell('wm size')
    const match = /Override size: (\d+)x(\d+)/.exec(out) ?? /Physical size: (\d+)x(\d+)/.exec(out)
    if (!match) throw new Error(`Unexpected wm size output: ${out}`)
    return { width: Number(match[1]), height: Number(match[2]) }
  }
}
