// Headless check of the app sources against emulator-5590 (the capture phone).
// F-Droid installs directly; the Play flow installs on the capture phone itself.
import { join } from 'node:path'
import { Adb } from '../src/main/adb'
import { findSdk } from '../src/main/sdk'
import { installFromFdroid, search } from '../src/main/store/fdroid'
import { apkPaths } from '../src/main/store/apk'
import { packageFromPlayLink, PlayHelper } from '../src/main/store/play'

const sdk = findSdk()!
const capture = new Adb(sdk.adb, 'emulator-5590')
const dir = join(process.cwd(), '.smoke-data', 'apks')
const log = (l: string) => console.log('  ', l)

console.log('F-Droid search "wikipedia":', (await search('wikipedia')).slice(0, 3).map((a) => a.packageName))
console.log('F-Droid install NewPipe:', await installFromFdroid(capture, 'org.schabi.newpipe', join(dir, 'fdroid'), log))

const pkg = packageFromPlayLink('https://play.google.com/store/apps/details?id=org.wikipedia&hl=en_IN')!
console.log('Play link ->', pkg)
const play = new PlayHelper(capture)
play.on('log', log)
play.on('stage', (s) => console.log('  stage:', s.stage, '-', s.message))
await capture.shell(`pm uninstall ${pkg}`).catch(() => '')
console.log('already installed:', await play.open(pkg))
await play.waitAndInstall(pkg, () => false, 60_000)
console.log('on capture phone:', (await apkPaths(capture, pkg)).length > 0)
process.exit(0)
