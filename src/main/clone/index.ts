import { execFile, spawn } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { platform } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { X509CertificateGenerator } from '@peculiar/x509'
import type { Adb } from '../adb'
import type { Sdk } from '../sdk'
import { installApks, isPackageName, pullApp } from '../store/apk'
import { patchManifest } from './axml'
import { renameResourcePackage, renameResourceStrings } from './arsc'
import { checkClone, explainInstallError } from './explain'
import { renameInCode } from './code'
import { readEntry, repack } from './zip'

const run = promisify(execFile)
const BUILD_TOOLS = 'build-tools;35.0.0'

function commandText(error: unknown): string {
  const err = error as Error & { stderr?: string | Buffer }
  const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString() : (err.stderr ?? '')
  return `${stderr}\n${err.message ?? ''}`
}

/** -P is 16 KB pages. Only an old zipalign that does not know the flag may fall back to 4 KB. */
export function zipalignLacksPageFlag(text: string): boolean {
  return /unknown flag|illegal option|unrecognized option|invalid option/i.test(text)
}

async function alignApk(tools: BuildTools, unsigned: string, aligned: string): Promise<void> {
  try {
    await run(tools.zipalign, ['-f', '-P', '16', '4', unsigned, aligned])
  } catch (error) {
    const text = commandText(error)
    if (!zipalignLacksPageFlag(text)) throw new Error(`Aligning the clone failed: ${text.trim().split('\n').filter(Boolean).pop()}`)
    await run(tools.zipalign, ['-f', '-p', '4', unsigned, aligned])
  }
}

interface BuildTools {
  aapt2: string
  zipalign: string
  apksigner: string
}

function findBuildTools(sdk: Sdk): BuildTools | null {
  const dir = join(sdk.root, 'build-tools')
  if (!existsSync(dir)) return null
  const exe = (n: string) => (platform() === 'win32' ? `${n}.exe` : n)
  const versions = readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const v of versions) {
    const tools = {
      aapt2: join(dir, v, exe('aapt2')),
      zipalign: join(dir, v, exe('zipalign')),
      apksigner: join(dir, v, platform() === 'win32' ? 'apksigner.bat' : 'apksigner'),
    }
    if (Object.values(tools).every((p) => existsSync(p))) return tools
  }
  return null
}

/** zipalign and apksigner come with the SDK build-tools; download them once if missing. */
async function buildTools(sdk: Sdk, log: (l: string) => void): Promise<BuildTools> {
  const found = findBuildTools(sdk)
  if (found) return found
  if (!sdk.sdkmanager) throw new Error('Android build-tools are missing and sdkmanager was not found to install them')
  log(`Downloading Android ${BUILD_TOOLS} (first clone only)…`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(sdk.sdkmanager, ['--install', BUILD_TOOLS], {
      env: { ...process.env, ANDROID_HOME: sdk.root, ANDROID_SDK_ROOT: sdk.root },
    })
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    // sdkmanager writes license text and progress until the pipe fills. Leaving stdout
    // unread deadlocks the child, and the UI stays on "Cloning…".
    timer = setTimeout(() => {
      child.kill()
      finish(new Error(`Installing ${BUILD_TOOLS} timed out`))
    }, 5 * 60 * 1000)
    const logChunk = (d: Buffer) => {
      const line = d.toString().trim()
      if (line) log(line)
    }
    child.stdout.on('data', logChunk)
    child.stderr.on('data', logChunk)
    child.stdin.write('y\n'.repeat(10))
    child.stdin.end()
    child.on('error', (error) => finish(error))
    child.on('exit', (code) => finish(code === 0 ? undefined : new Error(`sdkmanager exited ${code}`)))
  })
  const installed = findBuildTools(sdk)
  if (!installed) throw new Error(`${BUILD_TOOLS} did not install`)
  return installed
}

interface SigningKey {
  key: string
  cert: string
}

/** One key signs every clone, so cloning the same app again updates the earlier clone. */
async function signingKey(dir: string): Promise<SigningKey> {
  const key = join(dir, 'clone-key.pk8')
  const cert = join(dir, 'clone-cert.pem')
  if (existsSync(key) && existsSync(cert)) return { key, cert }
  mkdirSync(dir, { recursive: true })
  const crypto = webcrypto as unknown as Crypto
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 }
  const keys = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: Date.now().toString(16),
      name: 'CN=Sideglass clone signer, O=sideglass',
      notBefore: new Date(),
      notAfter: new Date(Date.now() + 30 * 365 * 86_400_000),
      signingAlgorithm: algorithm,
      keys,
    },
    crypto,
  )
  writeFileSync(key, Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)), { mode: 0o600 })
  writeFileSync(cert, certificate.toString('pem'))
  return { key, cert }
}

/** The name the launcher shows, read with aapt2. */
async function appLabel(tools: BuildTools, apk: string): Promise<string | null> {
  const { stdout } = await run(tools.aapt2, ['dump', 'badging', apk], { maxBuffer: 32 * 1024 * 1024 }).catch(() => ({ stdout: '' }))
  return /^application-label:'(.*)'$/m.exec(stdout)?.[1] ?? null
}

/** Default string values by resource id (`aapt2 dump resources`), for manifest values given as references. */
async function resourceStrings(tools: BuildTools, apk: string): Promise<Map<number, string>> {
  const { stdout } = await run(tools.aapt2, ['dump', 'resources', apk], { maxBuffer: 1024 * 1024 * 1024 }).catch(() => ({ stdout: '' }))
  const values = new Map<number, string>()
  let id: number | null = null
  for (const line of stdout.split('\n')) {
    const resource = /^\s*resource (0x[0-9a-f]{8}) string\//.exec(line)
    if (resource) {
      id = Number(resource[1])
      continue
    }
    const value = id !== null && /^\s*\(([^)]*)\) "(.*)"$/.exec(line)
    if (value && (value[1] === '' || !values.has(id!))) values.set(id!, value[2])
    if (/^\s*resource /.test(line)) id = null
  }
  return values
}

export interface CloneOptions {
  /** The installed app to copy. */
  pkg: string
  /** The copy's package name. */
  newPkg: string
  /** The copy's name in the launcher; empty means "<name> (clone)". */
  label?: string
  /** Leave the clone in front after the start check. Defaults to true. */
  open?: boolean
}

export interface CloneResult {
  pkg: string
  label: string
  install: string
  /** Set when the clone installed but does not run: the limitation, in plain words. */
  warning?: string
}

/**
 * Copy an installed app under a new package name and launcher name, re-signed with
 * Sideglass's own key, and install it next to the original on the same phone.
 */
export async function cloneApp(adb: Adb, sdk: Sdk, dataDir: string, options: CloneOptions, log: (l: string) => void): Promise<CloneResult> {
  const { pkg, newPkg } = options
  if (!isPackageName(pkg)) throw new Error(`Invalid package name: ${pkg}`)
  if (!isPackageName(newPkg)) throw new Error(`“${newPkg}” is not a valid package name (like com.example.app2)`)
  if (newPkg === pkg) throw new Error('The clone needs a package name different from the original')

  const tools = await buildTools(sdk, log)
  const key = await signingKey(join(dataDir, 'signing'))
  const work = join(dataDir, 'clones')
  log(`Copying ${pkg} off the phone…`)
  const pulled = await pullApp(adb, pkg, join(work, 'original'))
  const base = pulled.find((p) => p.endsWith('base.apk')) ?? pulled[0]
  const label = options.label?.trim() || `${(await appLabel(tools, base)) ?? pkg} (clone)`
  const strings = await resourceStrings(tools, base)

  const out = join(work, newPkg)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const signed: string[] = []
  // Authorities, permissions and shared user ids renamed in the manifest. The dex pass matches
  // them as whole string literals, so a short name cannot change part of a longer one.
  const renames = new Map<string, string>()
  // The base APK declares the providers, so it goes first; splits with code then use its names.
  for (const apk of [base, ...pulled.filter((p) => p !== base)]) {
    const name = basename(apk)
    log(`Rewriting ${name}…`)
    const zip = readFileSync(apk)
    const manifest = readEntry(zip, 'AndroidManifest.xml')
    if (!manifest) throw new Error(`${name} has no AndroidManifest.xml`)
    const patched = patchManifest(manifest, { pkg: newPkg, label: apk === base ? label : undefined, resolve: (id) => strings.get(id) ?? null })
    if (patched.oldPkg !== pkg) throw new Error(`${name} belongs to ${patched.oldPkg}, not ${pkg}`)
    for (const [from, to] of patched.renames) renames.set(from, to)
    const replace = new Map([['AndroidManifest.xml', patched.manifest]])
    const arsc = readEntry(zip, 'resources.arsc')
    let table = arsc ? renameResourcePackage(arsc, pkg, newPkg) : null
    // Resource ids belong to this APK's table. A split does not share the base APK's pool.
    if (arsc && patched.resources.size) {
      const rewritten = renameResourceStrings(table ?? arsc, patched.resources)
      if (rewritten) table = rewritten
    }
    if (table) replace.set('resources.arsc', table)
    try {
      const code = await renameInCode(apk, renames, out, join(dataDir, 'tools'), log)
      if (code) {
        for (const [entry, dex] of code.dex) replace.set(entry, dex)
        log(`Renamed ${code.changed} name(s) in the code of ${name}.`)
      }
    } catch (error) {
      // The clone still installs; only code that checks those names may fail.
      const message = (error as Error).message
      const reason = /ENOENT|Unable to locate a Java|java: command not found/i.test(message)
        ? 'Java is not installed (install Android Studio or a JDK)'
        : message.split('\n')[0]
      log(`Could not rename names in the code of ${name}, cloning without it. Apps whose code checks its own package name may not start. Reason: ${reason}`)
    }
    const unsigned = join(out, `unsigned-${name}`)
    const aligned = join(out, `aligned-${name}`)
    const final = join(out, name)
    writeFileSync(unsigned, repack(zip, replace))
    await alignApk(tools, unsigned, aligned)
    await run(tools.apksigner, ['sign', '--key', key.key, '--cert', key.cert, '--out', final, aligned], { timeout: 300_000 }).catch(
      (error: Error & { stderr?: string }) => {
        const text = `${error.stderr ?? ''} ${error.message}`
        throw new Error(
          /Java|ENOENT/i.test(text)
            ? 'Signing the clone needs Java, which was not found. Install Android Studio or a JDK, then try again.'
            : `Signing the clone failed: ${text.trim().split('\n').pop()}`,
        )
      },
    )
    rmSync(unsigned, { force: true })
    rmSync(aligned, { force: true })
    signed.push(final)
  }

  log(`Installing ${newPkg} (“${label}”)…`)
  // Never uninstall whatever already uses this package name: it may be a real app.
  const install = await installApks(adb, signed, undefined, false).catch((error: Error) => {
    throw new Error(explainInstallError(error.message, newPkg))
  })
  log(`${newPkg}: ${install}`)
  log('Starting the clone once to check it runs…')
  const warning = (await checkClone(adb, newPkg, options.open !== false)) ?? undefined
  log(warning ? `${newPkg} is installed but does not run: ${warning.split('\n')[0]}` : `${newPkg} runs.`)
  return { pkg: newPkg, label, install, warning }
}
