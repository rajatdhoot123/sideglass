// Headless end-to-end check: set up a session, open a page in the phone, print what was captured.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Session } from '../src/main/session'

const dataDir = join(process.cwd(), '.smoke-data')
mkdirSync(dataDir, { recursive: true })
const session = new Session(dataDir)
session.on('progress', (p) => console.log(`[${p.state}] ${p.step}: ${p.message}`))
session.on('setup-log', (l) => console.log(`   ${l}`))

const keep = process.argv.includes('--keep')
await session.start()
let frames = 0
session.on('frame', () => frames++)
const adb = session.emulator!.adb
await adb.shell('am start -a android.intent.action.VIEW -d https://example.com/?from=build-with-me')
await new Promise((r) => setTimeout(r, 25_000))
const all = [...session.proxy.exchanges.values()]
console.log(`\nCaptured ${all.length} requests, ${session.proxy.tlsFailures.length} TLS refusals, ${frames} screen frames`)
for (const e of all.slice(0, 25)) console.log(`  ${e.status ?? '...'} ${e.method} ${e.url.slice(0, 110)}`)
const refused = new Map<string, number>()
for (const f of session.proxy.tlsFailures) refused.set(f.host, (refused.get(f.host) ?? 0) + 1)
console.log('TLS refusals by host:', [...refused].sort((a, b) => b[1] - a[1]).slice(0, 10))
const example = all.find((e) => e.host === 'example.com')
console.log(example ? `\nOK example.com captured: ${example.status}, ${example.responseBodySize} bytes` : '\nexample.com NOT captured')
if (keep) {
  session.screen?.stop()
  session.logcat?.stop()
  await session.proxy.stop()
} else {
  await session.stop()
}
process.exit(example ? 0 : 1)
