import { EventEmitter } from 'node:events'
import type { Adb } from '../adb'
import { ensureAvd, PLAY_PHONE, startEmulator, stopEmulator, type RunningEmulator } from '../emulator'
import { Mirror } from '../mirror'
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

class PlayStoreStubError extends Error {
  constructor() {
    super(
      'The Play phone image does not contain the full Google Play Store (only the Android license checker was found).',
    )
    this.name = 'PlayStoreStubError'
  }
}

/** True only when every reported path is the LicenseChecker stub, not Phonesky or another store APK. */
function isLicenseCheckerOnly(pmPath: string): boolean {
  const paths = pmPath
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('package:'))
  return paths.length > 0 && paths.every((line) => /LicenseChecker/i.test(line))
}

/** `pm` often fails until package manager is up, which can be after sys.boot_completed. */
async function readPlayStorePath(adb: Adb): Promise<string> {
  const deadline = Date.now() + 20_000
  let lastError = 'package manager did not answer'
  while (Date.now() < deadline) {
    try {
      const out = await adb.shell('pm path com.android.vending')
      if (out.trim()) return out
      lastError = 'pm path returned no package'
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Could not check Google Play on the Play phone: ${lastError}`)
}

export class PlayHelper extends EventEmitter {
  emulator: RunningEmulator | null = null
  screen: Mirror | null = null
  private storeChecked = false
  private starting: Promise<Adb> | null = null

  constructor(
    private readonly sdk: Sdk,
    private readonly cacheDir: string,
  ) {
    super()
  }

  private log = (line: string) => this.emit('log', line)

  async start(): Promise<Adb> {
    if (this.emulator && this.storeChecked) return this.emulator.adb
    this.starting ??= this.openPlayPhone().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async openPlayPhone(): Promise<Adb> {
    if (!this.emulator) {
      await ensureAvd(this.sdk, PLAY_PHONE, this.log)
      this.emulator = await startEmulator(this.sdk, PLAY_PHONE, this.log)
    }
    try {
      await this.ensureFullPlayStore()
    } catch (error) {
      if (!(error instanceof PlayStoreStubError)) throw error
      // A snapshot boot can still be the LicenseChecker image. Cold-boot once before giving up.
      const alreadyCold = this.emulator?.coldBoot ?? false
      await this.discardEmulator()
      if (alreadyCold) throw error
      this.emulator = await startEmulator(this.sdk, PLAY_PHONE, this.log, undefined, true)
      try {
        await this.ensureFullPlayStore()
      } catch (retryError) {
        if (retryError instanceof PlayStoreStubError) await this.discardEmulator()
        throw retryError
      }
    }
    const emulator = this.emulator
    if (!emulator) throw new Error('Play phone is not running')
    await this.attachScreen(emulator)
    return emulator.adb
  }

  /** Leave the phone running when `pm` fails. The caller shuts it down for a real stub. */
  private async ensureFullPlayStore(): Promise<void> {
    const emulator = this.emulator
    if (!emulator) throw new Error('Play phone is not running')
    const out = await readPlayStorePath(emulator.adb)
    if (isLicenseCheckerOnly(out)) throw new PlayStoreStubError()
    this.storeChecked = true
  }

  private async attachScreen(emulator: RunningEmulator): Promise<void> {
    if (this.screen) return
    this.screen = new Mirror(emulator.adb, this.cacheDir, 2)
    this.screen.on('frame', (png: Buffer) => this.emit('frame', png))
    this.screen.on('video', (packet) => this.emit('video', packet))
    this.screen.on('mode', (mode) => this.emit('screen-mode', mode))
    this.screen.on('log', (line: string) => this.log(line))
    await this.screen.start()
  }

  private async discardEmulator(): Promise<void> {
    const emulator = this.emulator
    this.emulator = null
    this.storeChecked = false
    this.screen?.stop()
    this.screen = null
    if (emulator) await stopEmulator(emulator).catch(() => undefined)
  }

  /** Open the app's Play page. Returns true if it is already installed on the Play phone. */
  async open(pkg: string): Promise<boolean> {
    const adb = await this.start()
    if ((await apkPaths(adb, pkg)).length) return true
    await this.openStoreListing(pkg)
    return false
  }

  async openStoreListing(pkg: string): Promise<void> {
    const adb = await this.start()
    await adb.shell(`am start -a android.intent.action.VIEW -d 'market://details?id=${pkg}' com.android.vending`)
  }

  async isInstalled(pkg: string): Promise<boolean> {
    if (!this.emulator) return false
    return (await apkPaths(this.emulator.adb, pkg)).length > 0
  }

  async isInstalledFromPlay(pkg: string): Promise<boolean> {
    if (!this.emulator) return false
    const out = await this.emulator.adb.shell(`dumpsys package ${pkg}`)
    return /(?:installerPackageName|initiatingPackageName|originatingPackageName)=com\.android\.vending\b/.test(out)
  }

  async launch(pkg: string): Promise<number | null> {
    const adb = await this.start()
    const resolved = await adb.shell(`cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`)
    const component = resolved.trim().split('\n').pop()?.trim() ?? ''
    if (!component.startsWith(`${pkg}/`)) throw new Error(`No launcher activity found for ${pkg} on the Play phone`)
    await adb.shell(`am force-stop ${pkg}`)
    await adb.shell(`am start -n '${component}'`)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const out = (await adb.shell(`pidof ${pkg}`).catch(() => '')).trim()
    return out ? Number(out.split(/\s+/)[0]) : null
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
          await this.openStoreListing(pkg)
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
    this.storeChecked = false
  }
}
