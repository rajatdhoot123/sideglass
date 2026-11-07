// Re-run the CA install on the running emulator and count namespaces patched.
import { join } from 'node:path'
import { Adb } from '../src/main/adb'
import { installSystemCa, loadOrCreateCa } from '../src/main/certificate'
import { findSdk } from '../src/main/sdk'
const sdk = findSdk()!
const adb = new Adb(sdk.adb, process.argv[2] ?? 'emulator-5590')
const ca = await loadOrCreateCa(join(process.cwd(), '.smoke-data', 'ca'))
await installSystemCa(adb, ca)
const missing = await adb.shell(`for p in /proc/[0-9]*; do nsenter --mount=$p/ns/mnt -- ls /apex/com.android.conscrypt/cacerts/${ca.androidName} >/dev/null 2>&1 || echo miss; done | wc -l`)
console.log('processes still missing the CA:', missing.trim())
