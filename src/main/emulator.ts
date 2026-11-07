import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, arch } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Adb } from './adb'
import type { Sdk } from './sdk'

const run = promisify(execFile)

export const API_LEVEL = 35
export const IMAGE_ABI = arch() === 'arm64' ? 'arm64-v8a' : 'x86_64'

export type Log = (line: string) => void

/** One virtual phone Sideglass manages. */
export interface PhoneSpec {
  avd: string
  /** google_apis (rootable) or google_apis_playstore (has Play, cannot be rooted). */
  tag: 'google_apis' | 'google_apis_playstore'
  port: number
}

/** The phone apps run on, with all traffic through the proxy. Google APIs images allow adb root. */
export const CAPTURE_PHONE: PhoneSpec = { avd: 'sideglass_api35', tag: 'google_apis', port: 5590 }
/** A normal phone with the Play Store, used only to download apps with the user's own account. */
export const PLAY_PHONE: PhoneSpec = { avd: 'sideglass_play_api35', tag: 'google_apis_playstore', port: 5592 }

export const imageOf = (spec: PhoneSpec) => `system-images;android-${API_LEVEL};${spec.tag};${IMAGE_ABI}`

function avdHome(): string {
  return process.env.ANDROID_AVD_HOME ?? join(homedir(), '.android', 'avd')
}

export function avdExists(name: string): boolean {
  return existsSync(join(avdHome(), `${name}.ini`))
}

export function imageInstalled(sdk: Sdk, spec: PhoneSpec): boolean {
  return existsSync(join(sdk.root, 'system-images', `android-${API_LEVEL}`, spec.tag, IMAGE_ABI))
}

function sdkEnv(sdk: Sdk): NodeJS.ProcessEnv {
  return { ...process.env, ANDROID_HOME: sdk.root, ANDROID_SDK_ROOT: sdk.root }
}

/** Download the system image if needed (accepting Google's SDK licenses) and create the AVD. */
export async function ensureAvd(sdk: Sdk, spec: PhoneSpec, log: Log): Promise<void> {
  const image = imageOf(spec)
  if (!imageInstalled(sdk, spec)) {
    if (!sdk.sdkmanager) throw new Error('Android cmdline-tools (sdkmanager) not found')
    log(`Downloading ${image} (about 1.5 GB, first time only)...`)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(sdk.sdkmanager, ['--install', image, 'platform-tools', 'emulator'], { env: sdkEnv(sdk) })
      child.stdin.write('y\n'.repeat(20))
      child.stdin.end()
      child.stdout.on('data', (d: Buffer) => log(d.toString().trim()))
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`sdkmanager exited ${code}`))))
    })
  }
  if (avdExists(spec.avd)) return
  if (!sdk.avdmanager) throw new Error('Android cmdline-tools (avdmanager) not found')
  log(`Creating virtual phone ${spec.avd}...`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      sdk.avdmanager,
      ['create', 'avd', '--name', spec.avd, '--package', image, '--device', 'pixel_7', '--force'],
      { env: sdkEnv(sdk) },
    )
    child.stdin.write('no\n')
    child.stdin.end()
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`avdmanager exited ${code}: ${err}`))))
  })
}

export interface RunningEmulator {
  serial: string
  process: ChildProcess | null
  adb: Adb
}

/**
 * Start a phone with no window (Sideglass draws the screen itself). With [proxyPort], all of
 * its TCP traffic goes through the capture proxy. Reuses it if already running.
 */
export async function startEmulator(sdk: Sdk, spec: PhoneSpec, log: Log, proxyPort?: number): Promise<RunningEmulator> {
  const serial = `emulator-${spec.port}`
  const running = await Adb.devices(sdk.adb)
  if (running.some((d) => d.serial === serial)) {
    log(`Using running emulator ${serial}`)
    const adb = new Adb(sdk.adb, serial)
    await adb.waitForBoot()
    return { serial, process: null, adb }
  }
  log(`Starting ${spec.avd} on ${serial}...`)
  const args = ['-avd', spec.avd, '-port', String(spec.port), '-no-window', '-no-boot-anim', '-no-audio', '-gpu', 'auto']
  // The capture phone always cold-boots into a clean state; the Play phone keeps its sign-in.
  // -writable-system keeps the Play Store that replaces the LicenseChecker stub (see playstore.ts).
  if (proxyPort) args.push('-no-snapshot-save', '-writable-system', '-http-proxy', `http://127.0.0.1:${proxyPort}`)
  const child = spawn(sdk.emulator, args, { env: sdkEnv(sdk), detached: false })
  child.stdout?.on('data', (d: Buffer) => {
    const line = d.toString().trim()
    if (/ERROR|FATAL|boot completed/i.test(line)) log(line)
  })
  const exited = new Promise<never>((_, reject) =>
    child.on('exit', (code) => reject(new Error(`emulator exited early (code ${code})`))),
  )
  const adb = new Adb(sdk.adb, serial)
  await Promise.race([adb.waitForBoot(), exited])
  log(`${serial} booted`)
  return { serial, process: child, adb }
}

export async function stopEmulator(emu: RunningEmulator): Promise<void> {
  await emu.adb.exec(['emu', 'kill']).catch(() => undefined)
  emu.process?.kill()
}

export async function sdkVersion(adb: Adb): Promise<number> {
  return Number((await adb.shell('getprop ro.build.version.sdk')).trim())
}

export { run as execFileAsync }
