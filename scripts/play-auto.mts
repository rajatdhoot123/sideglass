// Hand-over loop check on the capture phone: Sideglass taps Install itself and the app installs there.
import { Adb } from '../src/main/adb'
import { findSdk } from '../src/main/sdk'
import { apkPaths } from '../src/main/store/apk'
import { PlayHelper } from '../src/main/store/play'

const pkg = process.argv[2] ?? 'com.google.android.apps.authenticator2'
const sdk = findSdk()!
const capture = new Adb(sdk.adb, 'emulator-5590')
const play = new PlayHelper(capture)
play.on('log', (l) => console.log('  log:', l))
play.on('stage', (s) => console.log('  stage:', s.stage, '-', s.message))
await capture.shell(`pm uninstall ${pkg}`).catch(() => '')
console.log('signed in:', await play.signedIn())
console.log('already installed:', await play.open(pkg))
await play.waitAndInstall(pkg, () => false, 5 * 60_000)
console.log('on capture phone:', (await apkPaths(capture, pkg)).length > 0)
process.exit(0)
