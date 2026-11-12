import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { entryNames, readEntry } from './zip'

const run = promisify(execFile)

/** apktool (Apache-2.0, with smali/baksmali, BSD), downloaded on first use. */
const APKTOOL_VERSION = '3.0.3'
const APKTOOL_URL = `https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/apktool_${APKTOOL_VERSION}.jar`
const APKTOOL_SHA256 = 'dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423'

/** Java for apktool: JAVA_HOME, Android Studio's bundled runtime, then whatever is on PATH. */
function findJava(): string {
  const bin = platform() === 'win32' ? 'java.exe' : 'java'
  const homes = [
    process.env.JAVA_HOME,
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Android Studio', 'jbr'),
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    '/opt/android-studio/jbr',
  ].filter((p): p is string => Boolean(p))
  return homes.map((home) => join(home, 'bin', bin)).find((p) => existsSync(p)) ?? bin
}

async function apktool(dir: string, log: (l: string) => void): Promise<string> {
  const jar = join(dir, `apktool_${APKTOOL_VERSION}.jar`)
  if (existsSync(jar)) return jar
  log(`Downloading apktool ${APKTOOL_VERSION} (first time only)…`)
  const response = await fetch(APKTOOL_URL)
  if (!response.ok) throw new Error(`apktool download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const sum = createHash('sha256').update(bytes).digest('hex')
  if (sum !== APKTOOL_SHA256) throw new Error('apktool download did not match its checksum')
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${jar}.part`, bytes)
  renameSync(`${jar}.part`, jar)
  return jar
}

function smaliFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) smaliFiles(path, out)
    else if (name.endsWith('.smali')) out.push(path)
  }
  return out
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Apps often have their provider authorities written into the code as well as the manifest
 * (for example a ContentProvider that checks its authority starts with the package name).
 * Rename those strings in the app's dex files the same way the manifest was renamed.
 *
 * Returns the rebuilt dex files by entry name, or null when the code has none of the names.
 * Class names are untouched: they use slashes in dex (Lcom/example/Foo;), the names here use dots.
 */
export async function renameInCode(
  apk: string,
  renames: Map<string, string>,
  work: string,
  toolsDir: string,
  log: (l: string) => void,
): Promise<{ dex: Map<string, Buffer>; changed: number } | null> {
  const olds = [...renames.keys()].filter((old) => old !== renames.get(old)).sort((a, b) => b.length - a.length)
  if (!olds.length) return null
  const zip = readFileSync(apk)
  const dexNames = entryNames(zip).filter((n) => /^classes\d*\.dex$/.test(n))
  // Package names are ASCII, so they appear in dex strings byte for byte. Skip apktool when none do.
  const needles = olds.map((o) => Buffer.from(o))
  if (!dexNames.some((n) => needles.some((needle) => readEntry(zip, n)!.includes(needle)))) return null

  const java = findJava()
  const jar = await apktool(toolsDir, log)
  const dir = join(work, 'smali')
  rmSync(dir, { recursive: true, force: true })
  log('Renaming the same names inside the app code (this can take a minute)…')
  // -r: code only. Resources and the manifest stay as they are; only the dex files are used.
  await run(java, ['-jar', jar, 'd', '-r', '--no-assets', '-f', '-o', dir, apk], { timeout: 900_000, maxBuffer: 64 * 1024 * 1024 })
  const pattern = new RegExp(olds.map(escape).join('|'), 'g')
  let changed = 0
  for (const file of smaliFiles(dir)) {
    const text = readFileSync(file, 'utf8')
    let count = 0
    const updated = text.replace(pattern, (old) => (count++, renames.get(old)!))
    if (count) {
      writeFileSync(file, updated)
      changed += count
    }
  }
  if (!changed) return null
  await run(java, ['-jar', jar, 'b', '--no-apk', '-f', dir], { timeout: 900_000, maxBuffer: 64 * 1024 * 1024 })
  const built = join(dir, 'build', 'apk')
  const dex = new Map<string, Buffer>()
  for (const name of dexNames) {
    const path = join(built, name)
    if (existsSync(path)) dex.set(name, readFileSync(path))
  }
  rmSync(dir, { recursive: true, force: true })
  if (!dex.size) throw new Error('apktool built no dex files')
  return { dex, changed }
}
