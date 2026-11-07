import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, arch } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Adb } from './adb'
import type { Sdk } from './sdk'

const run = promisify(execFile)

export const AVD_NAME = 'build_with_me_api35'
export const API_LEVEL = 35
/** Google APIs images are userdebug builds: adb root works. Google Play images cannot be rooted. */
export const IMAGE_ABI = arch() === 'arm64' ? 'arm64-v8a' : 'x86_64'
export const IMAGE = `system-images;android-${API_LEVEL};google_apis;${IMAGE_ABI}`

export type Log = (line: string) => void

function avdHome(): string {
  return process.env.ANDROID_AVD_HOME ?? join(homedir(), '.android', 'avd')
}

export function avdExists(name = AVD_NAME): boolean {
  return existsSync(join(avdHome(), `${name}.ini`))
}

export function imageInstalled(sdk: Sdk): boolean {
  return existsSync(join(sdk.root, 'system-images', `android-${API_LEVEL}`, 'google_apis', IMAGE_ABI))
}

/** Download the system image if needed (accepting Google's SDK licenses) and create our AVD. */
export async function ensureAvd(sdk: Sdk, log: Log): Promise<void> {
  if (!imageInstalled(sdk)) {
    if (!sdk.sdkmanager) throw new Error('Android cmdline-tools (sdkmanager) not found')
    log(`Downloading ${IMAGE} (about 1.5 GB, first run only)...`)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(sdk.sdkmanager, ['--install', IMAGE, 'platform-tools', 'emulator'], { env: sdkEnv(sdk) })
      child.stdin.write('y\n'.repeat(20))
      child.stdin.end()
      child.stdout.on('data', (d: Buffer) => log(d.toString().trim()))
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`sdkmanager exited ${code}`))))
    })
  }
  if (avdExists()) return
  if (!sdk.avdmanager) throw new Error('Android cmdline-tools (avdmanager) not found')
  log(`Creating virtual phone ${AVD_NAME}...`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      sdk.avdmanager,
      ['create', 'avd', '--name', AVD_NAME, '--package', IMAGE, '--device', 'pixel_7', '--force'],
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

function sdkEnv(sdk: Sdk): NodeJS.ProcessEnv {
  return { ...process.env, ANDROID_HOME: sdk.root, ANDROID_SDK_ROOT: sdk.root }
}

export interface RunningEmulator {
  serial: string
  process: ChildProcess | null
  adb: Adb
}

/**
 * Start our AVD with no window (the app draws the screen itself) and all of its TCP
 * traffic sent through our proxy. Reuses it if already running on [port].
 */
export async function startEmulator(sdk: Sdk, proxyPort: number, log: Log, port = 5590): Promise<RunningEmulator> {
  const serial = `emulator-${port}`
  const running = await Adb.devices(sdk.adb)
  if (running.some((d) => d.serial === serial)) {
    log(`Using running emulator ${serial}`)
    const adb = new Adb(sdk.adb, serial)
    await adb.waitForBoot()
    return { serial, process: null, adb }
  }
  log(`Starting ${AVD_NAME} on ${serial}...`)
  const child = spawn(
    sdk.emulator,
    [
      '-avd', AVD_NAME,
      '-port', String(port),
      '-no-window',
      '-no-boot-anim',
      '-no-snapshot-save',
      '-no-audio',
      '-gpu', 'auto',
      '-http-proxy', `http://127.0.0.1:${proxyPort}`,
    ],
    { env: sdkEnv(sdk), detached: false },
  )
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
