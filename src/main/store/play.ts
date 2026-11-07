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
export type PlayStage = 'needs-user' | 'installing' | 'copying' | 'done'

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

  /** Is a Google account signed in on the Play phone? */
  async signedIn(): Promise<boolean> {
    const adb = await this.start()
    const out = await adb.shell('dumpsys account').catch(() => '')
    return /Account \{name=[^,]+, type=com\.google\}/.test(out)
  }

  /**
   * Tap the Play page's "Install" (or "Update") button if it is on screen. Returns true if it
   * tapped. Reads the screen with uiautomator; never taps "Buy" or price buttons.
   */
  async tapInstall(): Promise<boolean> {
    const adb = await this.start()
    const xml = await adb.shell('uiautomator dump /sdcard/sideglass-ui.xml >/dev/null && cat /sdcard/sideglass-ui.xml').catch(() => '')
    const node = [...xml.matchAll(/<node [^>]*>/g)]
      .map((m) => m[0])
      .find((n) => /(text|content-desc)="(Install|Update)"/.test(n) && /enabled="true"/.test(n))
    const bounds = node && /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node)
    if (!bounds) return false
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number)
    await adb.shell(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`)
    return true
  }

  /**
   * Hand-over loop. Sideglass drives the Play phone itself and only stops for things the user
   * must do (sign in, accept something, pay). Each change of stage is emitted as 'stage' so the
   * window can show what is needed; once the user is done, the loop picks up again by itself.
   * Ends by copying the installed app's APK files to [dir].
   */
  async waitAndPull(pkg: string, dir: string, timeoutMs = 20 * 60_000, isCancelled = () => false): Promise<string[]> {
    const adb = await this.start()
    const deadline = Date.now() + timeoutMs
    let stage = ''
    let lastTap = 0
    let reopened = false
    const set = (next: PlayStage, message: string) => {
      if (next === stage) return
      stage = next
      this.emit('stage', { stage: next, message })
    }
    while (Date.now() < deadline && !isCancelled()) {
      const paths = await apkPaths(adb, pkg)
      if (paths.length) {
        // Play writes the base first and splits right after; wait until the set stops changing.
        await new Promise((r) => setTimeout(r, 3000))
        if ((await apkPaths(adb, pkg)).length === paths.length) {
          set('copying', 'Installed on the Play phone. Copying it to the capture phone…')
          return pullApp(adb, pkg, dir)
        }
        continue
      }
      if (!(await this.signedIn())) {
        set('needs-user', 'Sign in with a Google account on the phone below. Sideglass continues by itself once you are signed in.')
        reopened = false
      } else {
        if (!reopened) {
          // Back on the app's page after sign-in.
          await adb.shell(`am start -a android.intent.action.VIEW -d 'market://details?id=${pkg}' com.android.vending`)
          reopened = true
          await new Promise((r) => setTimeout(r, 2500))
        }
        if (Date.now() - lastTap > 8000 && (await this.tapInstall())) {
          lastTap = Date.now()
          set('installing', 'Tapped Install. Play is downloading the app…')
        } else if (Date.now() - lastTap > 30_000) {
          set('needs-user', 'Play needs you on the phone below (for example accept a prompt, or the app is paid or not offered here). Sideglass continues once it is installed.')
        }
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
