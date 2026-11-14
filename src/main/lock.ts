import type { Adb } from './adb'

/**
 * The PIN on the capture phone. Play asks for a screen lock before it will verify purchases with
 * a fingerprint, and Android hides the PIN pad from screen capture, so the mirror shows black while
 * the phone is locked. Sideglass owns this phone, so it keeps it awake and types the PIN itself.
 */
export const CAPTURE_PIN = '1234'

/** `dumpsys window policy` has a KeyguardServiceDelegate block with `showing=true|false`. */
export function keyguardShowingFrom(policy: string): boolean | null {
  const match = /^\s*showing=(true|false)\s*$/m.exec(policy)
  return match ? match[1] === 'true' : null
}

/** A PIN Android's `input text` can type without shell quoting. */
export function isPin(value: string): boolean {
  return /^[0-9]{4,16}$/.test(value)
}

async function keyguardShowing(adb: Adb): Promise<boolean | null> {
  const policy = await adb.shell('dumpsys window policy', 10_000).catch(() => '')
  return keyguardShowingFrom(policy)
}

/**
 * Keeps the capture phone unlocked: the screen stays on, and whenever the lock screen comes
 * back (a reboot, a phone runtime restart for the launch hooks, the power key) the PIN is typed.
 * The PIN is verified without the screen first, so a wrong one is never typed and Android's lockout never starts.
 */
export class LockKeeper {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private gaveUp = false
  /** The PIN was confirmed once; it stays right for this phone. */
  private verified = false

  constructor(
    private readonly adb: Adb,
    private readonly pin: string,
    private readonly log: (line: string) => void,
  ) {}

  async start(): Promise<void> {
    await this.adb.shell('svc power stayon true').catch(() => undefined)
    await this.check()
    this.timer = setInterval(() => void this.check(), 4_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Unlock now if the lock screen is showing. Resolves true when the phone ends up unlocked. */
  async check(): Promise<boolean> {
    if (this.busy) return false
    this.busy = true
    try {
      if ((await keyguardShowing(this.adb)) !== true) return true
      if (this.gaveUp || !isPin(this.pin)) return false
      // Checked without the screen first, so a wrong PIN is never typed into the lock screen
      // (five of those start Android's lockout). This also unlocks the user's storage after a
      // boot, which apps and the package manager need before anything can launch.
      if (!this.verified) {
        const verify = await this.adb.shell(`locksettings verify --old ${this.pin}`, 10_000).catch(() => '')
        if (!/verified successfully/i.test(verify)) {
          this.gaveUp = true
          this.log(
            'The phone is locked and its PIN is not the one Sideglass set. Type the PIN on the phone screen: ' +
              'the PIN pad shows black in the mirror, but typing still reaches it.',
          )
          return false
        }
        this.verified = true
      }
      // Wake, swipe up to raise the PIN pad, type the PIN. Too early after a boot the swipe
      // does nothing; the next check tries again.
      const { width, height } = await this.adb.screenSize().catch(() => ({ width: 1080, height: 2400 }))
      const x = Math.round(width / 2)
      await this.adb.shell(
        `input keyevent KEYCODE_WAKEUP; sleep 0.5; input swipe ${x} ${Math.round(height * 0.8)} ${x} ${Math.round(height * 0.2)} 250`,
        10_000,
      )
      await new Promise((r) => setTimeout(r, 1_200))
      await this.adb.shell(`input text ${this.pin}; input keyevent KEYCODE_ENTER`, 10_000)
      await new Promise((r) => setTimeout(r, 1_500))
      if ((await keyguardShowing(this.adb)) === false) {
        this.log('Unlocked the phone (it had locked behind its PIN).')
        return true
      }
      return false
    } catch {
      return false
    } finally {
      this.busy = false
    }
  }
}
