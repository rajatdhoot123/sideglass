import { EventEmitter } from 'node:events'
import type { Adb } from '../adb'
import { apkPaths, isPackageName } from './apk'

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
 * Installing apps from the Play Store on the capture phone itself. The capture phone is a
 * Magisk-rooted Play Store image: the user's own Google account works, and Sideglass taps
 * Install via uiautomator so the user only steps in for things only they can do (sign-in,
 * prompts, paid apps).
 */
export type PlayStage = 'needs-user' | 'installing' | 'done'

export class PlayHelper extends EventEmitter {
  constructor(private adb: Adb) {
    super()
  }

  private log = (line: string) => this.emit('log', line)

  /** Point at the phone Sideglass is currently running (it can change after reboots). */
  adopt(adb: Adb): void {
    this.adb = adb
  }

  /** Open the app's Play page. Returns true if the app is already installed. */
  async open(pkg: string): Promise<boolean> {
    if ((await apkPaths(this.adb, pkg)).length) return true
    await this.adb.shell(`am start -a android.intent.action.VIEW -d 'market://details?id=${pkg}' com.android.vending`)
    return false
  }

  /** Is a Google account signed in on the capture phone? */
  async signedIn(): Promise<boolean> {
    const out = await this.adb.shell('dumpsys account').catch(() => '')
    return /Account \{name=[^,]+, type=com\.google\}/.test(out)
  }

  /**
   * Tap the Play page's "Install" (or "Update") button if it is on screen. Returns true if it
   * tapped. Reads the screen with uiautomator; never taps "Buy" or price buttons.
   */
  async tapInstall(): Promise<boolean> {
    const xml = await this.adb
      .shell('uiautomator dump /sdcard/sideglass-ui.xml >/dev/null && cat /sdcard/sideglass-ui.xml')
      .catch(() => '')
    const node = [...xml.matchAll(/<node [^>]*>/g)]
      .map((m) => m[0])
      .find((n) => /(text|content-desc)="(Install|Update)"/.test(n) && /enabled="true"/.test(n))
    const bounds = node && /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node)
    if (!bounds) return false
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number)
    await this.adb.shell(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`)
    return true
  }

  /**
   * Hand-over loop. Sideglass drives the Play Store itself and only stops for things the
   * user must do (sign in, accept something, pay). Each change of stage is emitted as
   * 'stage' so the window can show what is needed; once the user is done, the loop picks
   * up again by itself. Ends when the app is installed on this phone.
   */
  async waitAndInstall(pkg: string, isCancelled = () => false, timeoutMs = 20 * 60_000): Promise<void> {
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
      const paths = await apkPaths(this.adb, pkg)
      if (paths.length) {
        // Play writes the base first and splits right after; wait until the set stops changing.
        await new Promise((r) => setTimeout(r, 3000))
        if ((await apkPaths(this.adb, pkg)).length === paths.length) {
          set('done', `${pkg} is installed.`)
          this.log(`${pkg} installed (${paths.length} APK file(s))`)
          return
        }
        continue
      }
      if (!(await this.signedIn())) {
        set(
          'needs-user',
          'Sign in with a Google account on the phone on the right. Sideglass continues by itself once you are signed in.',
        )
        reopened = false
      } else {
        if (!reopened) {
          // Back on the app's page after sign-in.
          await this.adb.shell(`am start -a android.intent.action.VIEW -d 'market://details?id=${pkg}' com.android.vending`)
          reopened = true
          await new Promise((r) => setTimeout(r, 2500))
        }
        if (Date.now() - lastTap > 8000 && (await this.tapInstall())) {
          lastTap = Date.now()
          set('installing', `Tapped Install for ${pkg}. The store is downloading it…`)
        } else if (Date.now() - lastTap > 30_000) {
          set(
            'needs-user',
            'The Play Store needs you on the phone on the right (for example to accept a prompt, or the app is paid). Sideglass continues once it is installed.',
          )
        }
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error(isCancelled() ? 'Cancelled' : `${pkg} was not installed within ${timeoutMs / 60_000} minutes`)
  }
}
