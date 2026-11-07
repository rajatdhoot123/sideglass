import { EventEmitter } from 'node:events'
import type { Adb } from '../adb'
import { ensureAvd, PLAY_PHONE, startEmulator, stopEmulator, type RunningEmulator } from '../emulator'
import { Screen } from '../screen'
import type { Sdk } from '../sdk'
import { apkPaths, isPackageName, pullApp } from './apk'

/** "https://play.google.com/store/apps/details?id=com.foo&hl=en" or "market://details?id=com.foo" or "com.foo". */
export function packageFromPlayLink(input: string): string | null {
  const text = input.trim()
  if (isPackageName(text)) return text
  try {
    const url = new URL(text)
    const id = url.searchParams.get('id')
    return id && isPackageName(id) ? id : null
  } catch {
    return null
  }
}

/**
 * A second, ordinary virtual phone with the Play Store. The user signs in once with their
 * own Google account and taps Install; Sideglass then copies the installed app's APK files.
 * Nothing is downloaded from outside Google Play.
 */
export class PlayHelper extends EventEmitter {
  emulator: RunningEmulator | null = null
  screen: Screen | null = null

  constructor(private readonly sdk: Sdk) {
    super()
  }

  private log = (line: string) => this.emit('log', line)

  async start(): Promise<Adb> {
    if (this.emulator) return this.emulator.adb
    await ensureAvd(this.sdk, PLAY_PHONE, this.log)
    this.emulator = await startEmulator(this.sdk, PLAY_PHONE, this.log)
    this.screen = new Screen(this.emulator.adb)
    this.screen.on('frame', (png: Buffer) => this.emit('frame', png))
    await this.screen.start()
    return this.emulator.adb
  }

  /** Open the app's Play page. Returns true if it is already installed on the Play phone. */
  async open(pkg: string): Promise<boolean> {
    const adb = await this.start()
    if ((await apkPaths(adb, pkg)).length) return true
    await adb.shell(`am start -a android.intent.action.VIEW -d 'market://details?id=${pkg}' com.android.vending`)
    return false
  }

  /** Wait for the user to install it from Play, then copy its APK files to [dir]. */
  async waitAndPull(pkg: string, dir: string, timeoutMs = 15 * 60_000, isCancelled = () => false): Promise<string[]> {
    const adb = await this.start()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !isCancelled()) {
      const paths = await apkPaths(adb, pkg)
      // Play writes the base first and splits right after; wait until the set stops changing.
      if (paths.length) {
        await new Promise((r) => setTimeout(r, 3000))
        if ((await apkPaths(adb, pkg)).length === paths.length) return pullApp(adb, pkg, dir)
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error(isCancelled() ? 'Cancelled' : `${pkg} was not installed within ${timeoutMs / 60_000} minutes`)
  }

  async stop(): Promise<void> {
    this.screen?.stop()
    if (this.emulator) await stopEmulator(this.emulator)
    this.emulator = null
    this.screen = null
  }
}
