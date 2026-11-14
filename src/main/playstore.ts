import type { Adb } from './adb'

/**
 * Apps protected by Google Play licensing (LVL, including PairIP) ask com.android.vending
 * whether the signed-in account owns them. The capture phone is a Play Store image, so the
 * real store is there; these helpers only tell when an app needs it and whether it is ready.
 */

/** The app declares the Play licence permission or bundles PairIP's licence check. */
export function needsPlayLicense(packageDump: string): boolean {
  return /com\.android\.vending\.CHECK_LICENSE\b|com\.pairip\.licensecheck\./i.test(packageDump)
}

/** True when com.android.vending is the real Play Store rather than the LicenseChecker stub. */
export async function hasPlayStore(adb: Adb): Promise<boolean> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const out = await adb.shell('pm path com.android.vending')
      if (/LicenseChecker/i.test(out)) return false
      if (out.includes('.apk')) return true
    } catch {
      // Package manager is often still down after sys.boot_completed.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}
