// Headless check of the app sources. Uses emulator-5590 (capture) and starts emulator-5592 (Play).
// A fresh Play phone has no Google sign-in, so an F-Droid app installed on it stands in for a Play install.
import { join } from 'node:path'
import { Adb } from '../src/main/adb'
import { findSdk } from '../src/main/sdk'
import { installFromFdroid, search } from '../src/main/store/fdroid'
import { apkPaths, installApks } from '../src/main/store/apk'
import { packageFromPlayLink, PlayHelper } from '../src/main/store/play'

const sdk = findSdk()!
const capture = new Adb(sdk.adb, 'emulator-5590')
const dir = join(process.cwd(), '.smoke-data', 'apks')
const log = (l: string) => console.log('  ', l)

console.log('F-Droid search "wikipedia":', (await search('wikipedia')).slice(0, 3).map((a) => a.packageName))
console.log('F-Droid install NewPipe:', await installFromFdroid(capture, 'org.schabi.newpipe', join(dir, 'fdroid'), log))

const pkg = packageFromPlayLink('https://play.google.com/store/apps/details?id=org.wikipedia&hl=en_IN')!
console.log('Play link ->', pkg)
const play = new PlayHelper(sdk, join(process.cwd(), '.smoke-data', 'scrcpy'))
play.on('log', log)
const playAdb = await play.start()
await capture.shell(`pm uninstall ${pkg}`).catch(() => '')
if (!(await apkPaths(playAdb, pkg)).length) await installFromFdroid(playAdb, pkg, join(dir, 'fdroid'), log)
console.log('  already on Play phone:', await play.open(pkg))
const apks = await play.waitAndPull(pkg, join(dir, 'play'), 60_000)
console.log('  pulled', apks.length, 'APK file(s)')
console.log('  install on capture phone:', await installApks(capture, apks))
console.log('  on capture phone:', (await apkPaths(capture, pkg)).length > 0)
await play.stop()
