import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Adb } from './adb'

/**
 * Apps protected by Google Play licensing (LVL, including PairIP) ask com.android.vending
 * whether the signed-in account owns them. The capture phone is a rootable Google APIs image,
 * whose com.android.vending is only a LicenseChecker stub, so those apps show "Something went
 * wrong". We swap the stub for the real Play Store, taken from the Play phone's system image.
 * The change lives in the emulator's writable-system overlay, so it survives cold boots.
 */

const STUB_DIR = '/product/app/LicenseChecker'
const STORE_DIR = '/product/priv-app/Phonesky'
const STORE_APK = `${STORE_DIR}/Phonesky.apk`
/** Allowlist for the Play Store's privileged permissions; without it the system refuses to boot. */
const PERMISSIONS = '/product/etc/permissions/privapp-permissions-google-p.xml'

export interface PlayStoreFiles {
  apk: string
  permissions: string
}

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

/** Copy the Play Store's system APK and its permission allowlist off the Play phone, once. */
export async function pullPlayStore(play: Adb, cacheDir: string): Promise<PlayStoreFiles> {
  mkdirSync(cacheDir, { recursive: true })
  const files = { apk: join(cacheDir, 'Phonesky.apk'), permissions: join(cacheDir, 'privapp-permissions-google-p.xml') }
  for (const [local, remote] of [
    [files.apk, STORE_APK],
    [files.permissions, PERMISSIONS],
  ]) {
    if (existsSync(local)) continue
    // Pull to a temporary name so an interrupted copy is never mistaken for a cached one.
    await play.exec(['pull', remote, `${local}.part`], 300_000)
    renameSync(`${local}.part`, local)
  }
  return files
}

/** Replace the stub with the Play Store on a rooted phone started with -writable-system. */
export async function installPlayStore(adb: Adb, files: PlayStoreFiles, log: (line: string) => void): Promise<void> {
  await adb.root()
  let out = await adb.remount()
  if (/reboot/i.test(out)) {
    // The first remount turns on the overlay, which applies after a reboot.
    log('Enabling a writable system on the capture phone (reboot)…')
    await adb.reboot()
    await adb.root()
    out = await adb.remount()
  }
  if (!/remount succeeded/i.test(out)) {
    throw new Error(
      `Could not make the capture phone's system writable (${out.trim() || 'no output'}). ` +
        'Quit Sideglass and close the capture phone emulator so it restarts with a writable system.',
    )
  }
  log('Installing Google Play on the capture phone…')
  await adb.shell(`rm -rf ${STUB_DIR} && mkdir -p ${STORE_DIR} && chmod 755 ${STORE_DIR}`)
  await adb.exec(['push', files.apk, STORE_APK], 300_000)
  await adb.exec(['push', files.permissions, PERMISSIONS])
  await adb.shell(`chmod 644 ${STORE_APK} ${PERMISSIONS}`)
  log('Restarting the capture phone…')
  await adb.reboot()
  if (!(await hasPlayStore(adb))) throw new Error('Google Play did not register on the capture phone after the reboot')
}
