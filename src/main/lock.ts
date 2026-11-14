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
 * A wrong PIN is tried only once, so Android's lockout timer never starts.
 */
export class LockKeeper {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private gaveUp = false

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
      // Wake, raise the PIN pad (MENU dismisses the swipe screen), type the PIN.
      await this.adb.shell('input keyevent KEYCODE_WAKEUP; input keyevent KEYCODE_MENU', 10_000)
      await new Promise((r) => setTimeout(r, 800))
      await this.adb.shell(`input text ${this.pin}; input keyevent KEYCODE_ENTER`, 10_000)
      await new Promise((r) => setTimeout(r, 1_500))
      if ((await keyguardShowing(this.adb)) === false) {
        this.log('Unlocked the phone (it had locked behind its PIN).')
        return true
      }
      this.gaveUp = true
      this.log(
        'The phone is locked and its PIN is not the one Sideglass set. Type the PIN on the phone screen: ' +
          'the PIN pad shows black in the mirror, but typing still reaches it.',
      )
      return false
    } catch {
      return false
    } finally {
      this.busy = false
    }
  }
}
