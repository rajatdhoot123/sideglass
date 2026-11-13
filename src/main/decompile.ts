import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { cp, readdir, readFile, stat } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import type { Adb } from './adb'
import { findJava } from './clone/code'
import { readEntry } from './clone/zip'
import { isPackageName, pullApp } from './store/apk'

/** jadx (Apache-2.0), downloaded on first use. Checked against the digest GitHub publishes for the release. */
const JADX_VERSION = '1.5.6'
const JADX_URL = `https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip`
const JADX_SHA256 = '545ea2be9c242511bc145755cf4bda2485ade42966e096f8b4d3da2a230e8974'
const JADX_JAR = `lib/jadx-${JADX_VERSION}-all.jar`

/** Files the search reads. Images, fonts and other binaries in resources/ are skipped. */
const TEXT_FILE = /\.(java|kt|smali|xml|json|txt|properties|pro|js|html|css|proto|yaml|yml|gradle|kts|MF|SF|version)$/i
const MAX_FILE = 4 * 1024 * 1024
const MAX_HITS = 500

/**
 * Well-known libraries. The search can leave them out, so an app's own code is not buried under
 * androidx and Kotlin. Paths are relative to `sources/`.
 */
export const LIBRARY_PREFIXES = [
  'android/', 'androidx/', 'kotlin/', 'kotlinx/', 'j$/', 'java/', 'javax/', 'dalvik/', 'org/intellij/', 'org/jetbrains/',
  'com/google/', 'okhttp3/', 'okio/', 'retrofit2/', 'com/squareup/', 'io/reactivex/', 'io/grpc/', 'dagger/', 'hilt_aggregated_deps/',
  'com/facebook/', 'org/apache/', 'com/fasterxml/', 'com/bumptech/', 'coil/', 'io/coil/', 'io/sentry/', 'timber/', 'org/slf4j/',
  'org/json/', 'org/chromium/', 'com/airbnb/', 'io/ktor/', 'com/github/', 'org/greenrobot/', 'com/jakewharton/', 'org/reactivestreams/',
  'com/firebase/', 'com/crashlytics/', 'com/appsflyer/', 'com/adjust/', 'io/branch/', 'com/onesignal/', 'com/revenuecat/', 'io/flutter/',
  'com/amplitude/', 'com/mixpanel/', 'com/posthog/', 'com/razorpay/', 'com/stripe/', 'org/bouncycastle/', 'org/joda/', 'com/caverock/',
  'net/sqlcipher/', 'io/realm/', 'com/tencent/', 'com/bytedance/', 'com/unity3d/', 'com/applovin/', 'com/ironsource/', 'org/checkerframework/',
]

export function isLibraryPath(path: string): boolean {
  if (!path.startsWith('sources/')) return false
  const rest = path.slice('sources/'.length)
  return LIBRARY_PREFIXES.some((prefix) => rest.startsWith(prefix))
}

export interface CodeIndex {
  pkg: string
  /** Every file jadx wrote, relative to the output folder ("sources/…" or "resources/…"), sorted. */
  files: string[]
  /** versionName (versionCode) of the copy that was decompiled. */
  version: string
  decompiledAt: number
  /** The app on the phone was updated after this copy was decompiled. */
  stale: boolean
  /** Classes jadx could not fully decompile; their bodies are shown as best-effort code. */
  errors: number
}

export interface CodeHit {
  file: string
  line: number
  text: string
}

export interface CodeSearch {
  hits: CodeHit[]
  /** True when there were more hits than were returned. */
  truncated: boolean
  scanned: number
}

export interface CodeSearchOptions {
  skipLibraries?: boolean
  matchCase?: boolean
}

export interface CodeProgress {
  pkg: string
  message: string
  /** 0–100 while jadx runs; undefined for steps without a measure. */
  percent?: number
  done?: boolean
}

interface Meta {
  key: string
  version: string
  decompiledAt: number
  errors: number
}

/** "INFO  - progress: 2861 of 14417 (19%)" → 19 */
export function parseJadxProgress(line: string): number | null {
  const match = /progress:\s*(\d+)\s+of\s+(\d+)/.exec(line)
  if (!match) return null
  const total = Number(match[2])
  return total ? Math.min(100, Math.floor((Number(match[1]) / total) * 100)) : null
}

/** "ERROR - finished with errors, count: 12" → 12 */
export function parseJadxErrors(text: string): number {
  const match = /finished with errors, count:\s*(\d+)/.exec(text)
  return match ? Number(match[1]) : 0
}

/** versionCode, versionName and install time from `dumpsys package`, to know when a decompiled copy is out of date. */
export function packageVersion(dumpsys: string): { key: string; label: string } {
  const code = /versionCode=(\d+)/.exec(dumpsys)?.[1] ?? '?'
  const name = /versionName=(\S+)/.exec(dumpsys)?.[1] ?? '?'
  const updated = /lastUpdateTime=([^\n]+)/.exec(dumpsys)?.[1]?.trim() ?? ''
  return { key: `${code}|${updated}`, label: `${name} (${code})` }
}

/** A path inside the output folder, or an error if [rel] tries to leave it. */
export function insideOutput(root: string, rel: string): string {
  const full = resolve(root, rel)
  if (full !== root && !full.startsWith(root + sep)) throw new Error('Path is outside the decompiled app')
  return full
}

/** Find [query] in [text], line by line. */
export function searchText(text: string, query: string, matchCase: boolean, file: string, limit: number): CodeHit[] {
  const hits: CodeHit[] = []
  const haystack = matchCase ? text : text.toLowerCase()
  const needle = matchCase ? query : query.toLowerCase()
  let from = 0
  // Line numbers are counted only up to each hit, so a file without one costs a single indexOf.
  let line = 1
  let counted = 0
  while (hits.length < limit) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    const lineStart = text.lastIndexOf('\n', at - 1) + 1
    let lineEnd = text.indexOf('\n', at)
    if (lineEnd < 0) lineEnd = text.length
    for (let i = text.indexOf('\n', counted); i >= 0 && i < lineStart; i = text.indexOf('\n', i + 1)) line++
    counted = lineStart
    hits.push({ file, line, text: text.slice(lineStart, lineEnd).trim().slice(0, 300) })
    from = lineEnd + 1
  }
  return hits
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  if (existsSync(root)) await walk(root)
  return out.sort()
}

/** Decompiles installed apps with jadx and keeps the result per package, so it opens instantly next time. */
export class Decompiler {
  private running = new Map<string, ChildProcess | null>()
  private cancelled = new Set<string>()
  private indexes = new Map<string, string[]>()

  constructor(
    private readonly dataDir: string,
    private readonly progress: (p: CodeProgress) => void,
  ) {}

  private appDir(pkg: string): string {
    if (!isPackageName(pkg)) throw new Error(`Invalid package name: ${pkg}`)
    return join(this.dataDir, 'code', pkg)
  }

  private outDir(pkg: string): string {
    return join(this.appDir(pkg), 'out')
  }

  private readMeta(pkg: string): Meta | null {
    try {
      return JSON.parse(readFileSync(join(this.appDir(pkg), 'meta.json'), 'utf8')) as Meta
    } catch {
      return null
    }
  }

  private async files(pkg: string): Promise<string[]> {
    let files = this.indexes.get(pkg)
    if (!files) {
      files = await listFiles(this.outDir(pkg))
      this.indexes.set(pkg, files)
    }
    return files
  }

  isRunning(pkg: string): boolean {
    return this.running.has(pkg)
  }

  /** The decompiled copy of [pkg], if there is one. [adb] is used to tell whether the phone has a newer version. */
  async index(pkg: string, adb: Adb | null): Promise<CodeIndex | null> {
    const meta = this.readMeta(pkg)
    if (!meta) return null
    let stale = false
    if (adb) {
      const dumpsys = await adb.shell(`dumpsys package ${pkg}`).catch(() => '')
      if (dumpsys.includes('versionCode=')) stale = packageVersion(dumpsys).key !== meta.key
    }
    return { pkg, files: await this.files(pkg), version: meta.version, decompiledAt: meta.decompiledAt, stale, errors: meta.errors }
  }

  cancel(pkg: string): void {
    if (!this.running.has(pkg)) return
    this.cancelled.add(pkg)
    this.running.get(pkg)?.kill()
  }

  /** Pull [pkg] from the phone and decompile it. Reuses the last result unless the app changed or [force] is set. */
  async decompile(adb: Adb, pkg: string, force = false): Promise<CodeIndex> {
    if (this.running.has(pkg)) throw new Error(`${pkg} is already being decompiled`)
    this.running.set(pkg, null)
    this.cancelled.delete(pkg)
    try {
      const dumpsys = await adb.shell(`dumpsys package ${pkg}`)
      if (!dumpsys.includes('versionCode=')) throw new Error(`${pkg} is not installed on the phone`)
      const version = packageVersion(dumpsys)
      const meta = this.readMeta(pkg)
      if (!force && meta?.key === version.key && existsSync(join(this.outDir(pkg), 'sources'))) {
        this.progress({ pkg, message: 'Already decompiled', percent: 100, done: true })
        return (await this.index(pkg, null))!
      }

      const dir = this.appDir(pkg)
      this.progress({ pkg, message: `Copying ${pkg} from the phone…` })
      const apks = await pullApp(adb, pkg, join(dir, 'apk'))
      this.checkCancelled(pkg)
      const jar = await this.jadx(pkg)
      this.checkCancelled(pkg)

      const work = join(dir, 'out.part')
      rmSync(work, { recursive: true, force: true })
      // Split APKs are mostly resources for one screen density, ABI or language. The code is in base.
      const base = apks.find((p) => /-base\.apk$/.test(p)) ?? apks[0]
      const errors = await this.runJadx(pkg, jar, base, work)
      if (!existsSync(join(work, 'sources'))) throw new Error('jadx wrote no source files')

      const out = this.outDir(pkg)
      rmSync(out, { recursive: true, force: true })
      renameSync(work, out)
      rmSync(join(dir, 'apk'), { recursive: true, force: true })
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({ key: version.key, version: version.label, decompiledAt: Date.now(), errors } satisfies Meta))
      this.indexes.delete(pkg)
      this.progress({ pkg, message: errors ? `Done. ${errors} classes could not be fully decompiled.` : 'Done', percent: 100, done: true })
      return (await this.index(pkg, null))!
    } catch (error) {
      const message = this.cancelled.has(pkg) ? 'Cancelled' : (error as Error).message
      this.progress({ pkg, message, done: true })
      throw new Error(message)
    } finally {
      this.running.delete(pkg)
      this.cancelled.delete(pkg)
    }
  }

  private checkCancelled(pkg: string): void {
    if (this.cancelled.has(pkg)) throw new Error('Cancelled')
  }

  private async jadx(pkg: string): Promise<string> {
    const dir = join(this.dataDir, 'jadx')
    const jar = join(dir, `jadx-${JADX_VERSION}-all.jar`)
    if (existsSync(jar)) return jar
    this.progress({ pkg, message: `Downloading jadx ${JADX_VERSION} (first time only, about 70 MB)…` })
    const response = await fetch(JADX_URL)
    if (!response.ok) throw new Error(`jadx download failed: HTTP ${response.status}`)
    const zip = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(zip).digest('hex') !== JADX_SHA256) throw new Error('jadx download did not match its checksum')
    const bytes = readEntry(zip, JADX_JAR)
    if (!bytes) throw new Error(`jadx download has no ${JADX_JAR}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${jar}.part`, bytes)
    renameSync(`${jar}.part`, jar)
    return jar
  }

  private runJadx(pkg: string, jar: string, apk: string, out: string): Promise<number> {
    // jadx keeps the whole app in memory. Give it half the computer, between 1 and 6 GB.
    const heapMb = Math.max(1024, Math.min(6144, Math.floor(totalmem() / 1024 / 1024 / 2)))
    const threads = Math.max(2, Math.min(8, cpus().length - 1))
    const args = [`-Xmx${heapMb}m`, '-cp', jar, 'jadx.cli.JadxCLI', '-d', out, '-j', String(threads), '--show-bad-code', '--log-level', 'progress', apk]
    this.progress({ pkg, message: 'Decompiling…', percent: 0 })
    return new Promise((resolvePromise, reject) => {
      const child = spawn(findJava(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
      this.running.set(pkg, child)
      let tail = ''
      let last = -1
      const onData = (chunk: Buffer) => {
        const text = chunk.toString()
        tail = (tail + text).slice(-4000)
        for (const line of text.split(/[\r\n]+/)) {
          const percent = parseJadxProgress(line)
          if (percent !== null && percent !== last) {
            last = percent
            this.progress({ pkg, message: 'Decompiling…', percent })
          }
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', (error) => {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
        reject(missing ? new Error('Java was not found. Install Android Studio or a JDK 11+ and set JAVA_HOME.') : error)
      })
      child.on('exit', (code, signal) => {
        if (this.cancelled.has(pkg) || signal) return reject(new Error('Cancelled'))
        const errors = parseJadxErrors(tail)
        // jadx exits 1 when some classes failed but still writes everything else.
        if (code === 0 || (existsSync(join(out, 'sources')) && errors > 0)) return resolvePromise(errors)
        const last = tail.trim().split('\n').filter(Boolean).pop() ?? ''
        reject(new Error(`jadx exited ${code}${last ? `: ${last}` : ''}`))
      })
    })
  }

  /** A folder name for an export, e.g. "org.tasks-14.2.1-decompiled". */
  exportName(pkg: string): string {
    const version = /^(\S+)/.exec(this.readMeta(pkg)?.version ?? '')?.[1]
    return `${pkg}${version && version !== '?' ? `-${version.replace(/[^\w.-]/g, '_')}` : ''}-decompiled`
  }

  /** Copy the decompiled sources and resources into [target], a folder that must not exist yet. */
  async export(pkg: string, target: string): Promise<number> {
    const out = this.outDir(pkg)
    if (!existsSync(join(out, 'sources'))) throw new Error(`${pkg} has not been decompiled yet`)
    if (existsSync(target)) throw new Error(`${target} already exists`)
    try {
      await cp(out, target, { recursive: true, errorOnExist: true })
    } catch (error) {
      rmSync(target, { recursive: true, force: true })
      throw error
    }
    return (await this.files(pkg)).length
  }

  async read(pkg: string, file: string): Promise<string> {
    const full = insideOutput(this.outDir(pkg), file)
    const info = await stat(full)
    if (info.size > MAX_FILE) return `// ${file} is ${(info.size / 1024 / 1024).toFixed(1)} MB, too large to show here.`
    const bytes = await readFile(full)
    if (bytes.subarray(0, 8000).includes(0)) return `// ${file} is a binary file (${info.size} bytes).`
    return bytes.toString('utf8')
  }

  async search(pkg: string, query: string, options: CodeSearchOptions = {}): Promise<CodeSearch> {
    const q = query.trim()
    if (q.length < 2) return { hits: [], truncated: false, scanned: 0 }
    const root = this.outDir(pkg)
    const wanted = (await this.files(pkg)).filter((f) => TEXT_FILE.test(f) && !(options.skipLibraries && isLibraryPath(f)))
    // Code first, then the manifest and other resources.
    const files = [...wanted.filter((f) => f.startsWith('sources/')), ...wanted.filter((f) => !f.startsWith('sources/'))]
    const hits: CodeHit[] = []
    let scanned = 0
    let truncated = false
    // Read a few files at a time; the order of hits still follows the file list.
    const BATCH = 64
    for (let i = 0; i < files.length && !truncated; i += BATCH) {
      const chunk = files.slice(i, i + BATCH)
      const texts = await Promise.all(chunk.map((f) => readFile(join(root, f), 'utf8').catch(() => '')))
      for (let j = 0; j < chunk.length; j++) {
        scanned++
        if (texts[j].length > MAX_FILE) continue
        const found = searchText(texts[j], q, Boolean(options.matchCase), chunk[j], MAX_HITS - hits.length + 1)
        hits.push(...found)
        if (hits.length > MAX_HITS) {
          truncated = true
          hits.length = MAX_HITS
          break
        }
      }
    }
    return { hits, truncated, scanned }
  }
}
