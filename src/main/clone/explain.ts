import type { Adb } from '../adb'

/** Why an install of a clone failed, in words a user can act on. */
export function explainInstallError(message: string, newPkg: string): string {
  const rules: [RegExp, string][] = [
    [/CONFLICTING_PROVIDER/, 'The app declares a content provider whose name could not be renamed, so it clashes with the original app. This app cannot be cloned.'],
    [/DUPLICATE_PERMISSION/, 'The app defines a permission that another installed app also defines. This app cannot be cloned while that app is installed.'],
    [/already installed and signed with another key|UPDATE_INCOMPATIBLE/, `${newPkg} is already used by another app. Pick a different package name.`],
    [/INSUFFICIENT_STORAGE/, 'The phone does not have enough free space for the clone.'],
    [/MISSING_SHARED_LIBRARY/, 'The app needs a system library this phone does not have.'],
    [/NO_MATCHING_ABIS/, 'The app has no native code for this phone’s processor.'],
    [/INSTALL_PARSE_FAILED|INVALID_APK|NO_CERTIFICATES/, 'Android could not read the rewritten app. This app’s format is not supported by the cloner.'],
    [/MISSING_SPLIT/, 'Some parts (split APKs) of the app are missing on the phone, so it cannot be copied whole.'],
  ]
  const hit = rules.find(([pattern]) => pattern.test(message))
  return hit ? `${hit[1]} (${message.trim().split('\n').pop()})` : `Android refused to install the clone: ${message.trim().split('\n').pop()}`
}

/** A crash cause, turned into the limitation behind it. */
function explainCrash(cause: string): string {
  const rules: [RegExp, string][] = [
    [/signature|signing|tamper|SigningInfo|getPackageInfo.*GET_SIGNATURES/i, 'The app checks its own signature. A clone is signed with a different key, so it refuses to run.'],
    [/pairip|LicenseClient|LicenseChecker|com\.android\.vending\.licensing|licen[cs]e/i, 'The app checks its Google Play licence, which is tied to the original package name.'],
    [/integrity|SafetyNet|attestation/i, 'The app uses Play Integrity or SafetyNet, which reports the clone as modified.'],
    [/should start with your package name|authority|ContentProvider/i, 'The app’s code expects its original package name for a content provider, and that name could not be changed in the code.'],
    [/google_app_id|FirebaseApp|Firebase/i, 'Firebase is set up for the original package name only.'],
    [/UnsatisfiedLinkError/i, 'The app’s native code could not load in the clone (it may check the package name or install path).'],
  ]
  const hit = rules.find(([pattern]) => pattern.test(cause))
  return hit ? hit[1] : 'The app crashed on start. It probably checks something only the original has (its package name, signature or install source).'
}

/** Logcat writes "Process: com.example.app, PID: …". A longer name such as com.example.app.debug is not this package. */
export function crashLogMentionsPackage(log: string, pkg: string): boolean {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const line = new RegExp(`Process: ${escaped}(?![\\w.])`)
  return log.split('\n').some((entry) => line.test(entry))
}

/**
 * Start the clone once and watch it for a few seconds. Returns null when it keeps running,
 * otherwise what went wrong and the limitation behind it.
 * When [open] is false, a clone that stays up is closed again: the check has to start it,
 * but the user asked for it not to be left in front.
 */
export async function checkClone(adb: Adb, pkg: string, open = true): Promise<string | null> {
  const resolved = await adb
    .shell(`cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`)
    .catch(() => '')
  const component = resolved.trim().split('\n').pop()?.trim() ?? ''
  if (!component.startsWith(`${pkg}/`)) return null // No launcher screen (a service or keyboard app); nothing to start.
  await adb.shell('logcat -c -b crash').catch(() => undefined)
  await adb.shell(`am force-stop ${pkg}; am start -n '${component}'`).catch(() => undefined)
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const crash = await adb.shell('logcat -d -b crash').catch(() => '')
    const lines = crash.split('\n')
    if (crashLogMentionsPackage(crash, pkg)) {
      const causes = lines.filter((l) => /Caused by:|FATAL EXCEPTION|Exception:/.test(l)).map((l) => l.replace(/^.*?AndroidRuntime:\s*/, '').trim())
      const cause = causes.filter((c) => c.startsWith('Caused by')).pop() ?? causes.find((c) => !c.startsWith('FATAL')) ?? ''
      await adb.shell(`am force-stop ${pkg}`).catch(() => undefined)
      return `${explainCrash(cause)}${cause ? `\nDetails: ${cause.slice(0, 300)}` : ''}`
    }
  }
  const alive = (await adb.shell(`pidof ${pkg}`).catch(() => '')).trim()
  if (!alive) return 'The clone closed by itself right after starting. The app probably checks that it is the original (its signature or package name) and quits.'
  if (!open) await adb.shell(`am force-stop ${pkg}`).catch(() => undefined)
  return null
}
