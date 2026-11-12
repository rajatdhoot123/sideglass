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
import { renameResourcePackage } from './arsc'
import { renameInCode } from './code'
import { readEntry, repack } from './zip'

const run = promisify(execFile)
const BUILD_TOOLS = 'build-tools;35.0.0'

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
    child.stdin.write('y\n'.repeat(10))
    child.stdin.end()
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`sdkmanager exited ${code}`))))
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
}

export interface CloneResult {
  pkg: string
  label: string
  install: string
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
  // Names renamed in the manifest, to rename in the code as well. Only names that contain the
  // package: a short generic one (say "downloads") could match unrelated strings in the code.
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
    for (const [from, to] of patched.renames) if (from.includes(pkg)) renames.set(from, to)
    const replace = new Map([['AndroidManifest.xml', patched.manifest]])
    const arsc = readEntry(zip, 'resources.arsc')
    const table = arsc && renameResourcePackage(arsc, pkg, newPkg)
    if (table) replace.set('resources.arsc', table)
    try {
      const code = await renameInCode(apk, renames, out, join(dataDir, 'tools'), log)
      if (code) {
        for (const [entry, dex] of code.dex) replace.set(entry, dex)
        log(`Renamed ${code.changed} name(s) in the code of ${name}.`)
      }
    } catch (error) {
      // The clone still installs; only code that checks those names may fail.
      log(`Could not rename names in the code of ${name}, cloning without it: ${(error as Error).message.split('\n')[0]}`)
    }
    const unsigned = join(out, `unsigned-${name}`)
    const aligned = join(out, `aligned-${name}`)
    const final = join(out, name)
    writeFileSync(unsigned, repack(zip, replace))
    // -P 16: 16 KB alignment for uncompressed native libraries, which also satisfies 4 KB pages.
    await run(tools.zipalign, ['-f', '-P', '16', '4', unsigned, aligned]).catch(() => run(tools.zipalign, ['-f', '-p', '4', unsigned, aligned]))
    await run(tools.apksigner, ['sign', '--key', key.key, '--cert', key.cert, '--out', final, aligned], { timeout: 300_000 })
    rmSync(unsigned, { force: true })
    rmSync(aligned, { force: true })
    signed.push(final)
  }

  log(`Installing ${newPkg} (“${label}”)…`)
  // Never uninstall whatever already uses this package name: it may be a real app.
  const install = await installApks(adb, signed, undefined, false)
  log(`${newPkg}: ${install}`)
  return { pkg: newPkg, label, install }
}
