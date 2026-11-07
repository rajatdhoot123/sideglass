// Hand-over loop check on a signed-in Play phone: Sideglass taps Install itself, then copies the app.
import { join } from 'node:path'
import { Adb } from '../src/main/adb'
import { findSdk } from '../src/main/sdk'
import { apkPaths, installApks } from '../src/main/store/apk'
import { PlayHelper } from '../src/main/store/play'

const pkg = process.argv[2] ?? 'com.google.android.apps.authenticator2'
const sdk = findSdk()!
const capture = new Adb(sdk.adb, 'emulator-5590')
const play = new PlayHelper(sdk, join(process.cwd(), '.smoke-data', 'scrcpy'))
play.on('log', (l) => console.log('  log:', l))
play.on('stage', (s) => console.log('  stage:', s.stage, '-', s.message))
const playAdb = await play.start()
await playAdb.shell(`pm uninstall ${pkg}`).catch(() => '')
console.log('signed in:', await play.signedIn())
console.log('already installed:', await play.open(pkg))
const apks = await play.waitAndPull(pkg, join(process.cwd(), '.smoke-data', 'apks', 'play'), 5 * 60_000)
console.log('pulled', apks.length, 'file(s):', await installApks(capture, apks))
console.log('on capture phone:', (await apkPaths(capture, pkg)).length > 0)
play.screen?.stop()
process.exit(0)
