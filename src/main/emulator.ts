import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

/**
 * The only virtual phone: a Play Store image booted with a Magisk-patched ramdisk, so it has
 * both the Play Store and root. Reuses the signed-in Play phone from the earlier two-phone flow.
 */
export const CAPTURE_PHONE: PhoneSpec = { avd: 'sideglass_play_api35', tag: 'google_apis_playstore', port: 5590 }

/** Path of the phone's stock ramdisk inside the SDK system image. */
export function ramdiskOf(sdk: Sdk, spec: PhoneSpec): string {
  return join(sdk.root, 'system-images', `android-${API_LEVEL}`, spec.tag, IMAGE_ABI, 'ramdisk.img')
}

export const imageOf = (spec: PhoneSpec) => `system-images;android-${API_LEVEL};${spec.tag};${IMAGE_ABI}`

function avdHome(): string {
  return process.env.ANDROID_AVD_HOME ?? join(homedir(), '.android', 'avd')
}

export function avdExists(name: string): boolean {
  return existsSync(join(avdHome(), `${name}.ini`))
}

/**
 * avdmanager writes `PlayStore.enabled=no` (or `= false`) even for a Play system image.
 * Returns whether config.ini changed.
 */
function enablePlayStore(spec: PhoneSpec): boolean {
  if (spec.tag !== 'google_apis_playstore') return false
  const config = join(avdHome(), `${spec.avd}.avd`, 'config.ini')
  if (!existsSync(config)) return false
  const contents = readFileSync(config, 'utf8')
  const updated = /^PlayStore\.enabled\s*=.*$/m.test(contents)
    ? contents.replace(/^PlayStore\.enabled\s*=.*$/gm, 'PlayStore.enabled=yes')
    : `${contents.trimEnd()}\nPlayStore.enabled=yes\n`
  if (updated === contents) return false
  writeFileSync(config, updated)
  return true
}

/** A lock whose pid is still running. Stale locks left by a crash do not count. */
function avdLocked(spec: PhoneSpec): boolean {
  const dir = join(avdHome(), `${spec.avd}.avd`)
  try {
    return readdirSync(dir).some((name) => name.endsWith('.lock') && lockHeld(join(dir, name)))
  } catch {
    return false
  }
}

function lockHeld(lockPath: string): boolean {
  let text = ''
  try {
    const pidFile = join(lockPath, 'pid')
    if (existsSync(pidFile)) text = readFileSync(pidFile, 'utf8')
    else if (statSync(lockPath).isFile()) text = readFileSync(lockPath, 'utf8')
    else return true
  } catch {
    return true
  }
  // An empty file carries no pid. multiinstance.lock is always empty (qemu holds it with an
  // OS file lock), and stays behind after `emu kill`. A running emulator also writes its pid to
  // hardware-qemu.ini.lock, so treating an empty file as free never misses a live one.
  if (!text.trim()) return false
  const pid = Number(text.trim())
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** `adb devices` drops the serial before qemu releases the AVD lock and console port. */
async function waitForAvdRelease(sdk: Sdk, spec: PhoneSpec, serial: string): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const listed = (await Adb.devices(sdk.adb)).some((device) => device.serial === serial)
    if (!listed && !avdLocked(spec)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(
    `Could not restart ${serial} to enable Google Play. The previous emulator is still shutting down.`,
  )
}

function playStoreRuntimeEnabled(spec: PhoneSpec): boolean {
  const hardware = join(avdHome(), `${spec.avd}.avd`, 'hardware-qemu.ini')
  if (!existsSync(hardware)) return false
  return /^PlayStore\.enabled\s*=\s*(?:yes|true)\s*$/mi.test(readFileSync(hardware, 'utf8'))
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
  if (avdExists(spec.avd)) {
    enablePlayStore(spec)
    return
  }
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
  enablePlayStore(spec)
}

export interface RunningEmulator {
  serial: string
  process: ChildProcess | null
  adb: Adb
  /** True when this start skipped the quick-boot snapshot. */
  coldBoot: boolean
}

/**
 * Start a phone with no window (Sideglass draws the screen itself). With [proxyPort], all of
 * its TCP traffic goes through the capture proxy. Reuses it if already running.
 * The fifth argument is `true` to skip the quick-boot snapshot once, or a Magisk ramdisk
 * path. A ramdisk is never reused from a process that is already up: that process booted
 * without it. Userdata is kept.
 */
export async function startEmulator(
  sdk: Sdk,
  spec: PhoneSpec,
  log: Log,
  proxyPort?: number,
  boot?: boolean | string,
): Promise<RunningEmulator> {
  const ramdisk = typeof boot === 'string' ? boot : undefined
  const forceColdBoot = boot === true || Boolean(ramdisk)
  const serial = `emulator-${spec.port}`
  const running = await Adb.devices(sdk.adb)
  const existing = running.find((d) => d.serial === serial)
  if (existing && existing.state !== 'device') {
    log(`Waiting for ${serial} to finish booting…`)
    await new Adb(sdk.adb, serial).waitForBoot()
  }
  const play = spec.tag === 'google_apis_playstore'
  if (existing && !forceColdBoot && (!play || playStoreRuntimeEnabled(spec))) {
    log(`Using running emulator ${serial}`)
    const adb = new Adb(sdk.adb, serial)
    await adb.waitForBoot()
    return { serial, process: null, adb, coldBoot: false }
  }
  if (existing) {
    log(
      ramdisk
        ? `Restarting ${serial} so it boots the Magisk ramdisk…`
        : `Restarting ${serial} to apply the Play Store configuration…`,
    )
    await new Adb(sdk.adb, serial).exec(['emu', 'kill']).catch(() => undefined)
  }
  if ((await Adb.devices(sdk.adb)).some((device) => device.serial === serial) || avdLocked(spec)) {
    await waitForAvdRelease(sdk, spec, serial)
  }
  // The exiting emulator writes its old config back. Repair the flag only after it is gone.
  const configChanged = enablePlayStore(spec)
  const coldBoot = forceColdBoot || configChanged || (play && !playStoreRuntimeEnabled(spec))
  log(`Starting ${spec.avd} on ${serial}...`)
  const args = ['-avd', spec.avd, '-port', String(spec.port), '-no-window', '-no-boot-anim', '-no-audio', '-gpu', 'auto']
  if (ramdisk) args.push('-ramdisk', ramdisk, '-no-snapshot')
  else if (coldBoot) args.push('-no-snapshot-load')
  // The capture phone always cold-boots into a clean state; the Play phone keeps its sign-in.
  // -writable-system keeps the Play Store that replaces the LicenseChecker stub.
  if (proxyPort) args.push('-no-snapshot-save', '-writable-system', '-http-proxy', `http://127.0.0.1:${proxyPort}`)
  const child = await bootEmulator(sdk, spec, log, args)
  log(`${serial} booted`)
  return { serial, process: child, adb: new Adb(sdk.adb, serial), coldBoot }
}

/** Retry when the previous qemu still holds the console port after adb has dropped it. */
async function bootEmulator(sdk: Sdk, spec: PhoneSpec, log: Log, args: string[]): Promise<ChildProcess> {
  const serial = `emulator-${spec.port}`
  let lastError = 'emulator exited early'
  for (let attempt = 1; attempt <= 3; attempt++) {
    const output: string[] = []
    const child = spawn(sdk.emulator, args, { env: sdkEnv(sdk), detached: false })
    const take = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').map((item) => item.trim()).filter(Boolean)) {
        output.push(line)
        if (output.length > 30) output.shift()
        if (/ERROR|FATAL|boot completed/i.test(line)) log(line)
      }
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    // `close` fires after stdout ends, so a port-conflict message is not lost.
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    let code: 'booted' | number | null
    try {
      code = await Promise.race([
        new Adb(sdk.adb, serial).waitForBoot().then(() => 'booted' as const),
        exited,
      ])
    } catch (error) {
      child.kill()
      throw error
    }
    if (code === 'booted') return child
    const text = output.join('\n')
    lastError = text
      ? `emulator exited early (code ${code}): ${output.slice(-4).join('; ')}`
      : `emulator exited early (code ${code})`
    const held =
      output.length === 0 ||
      /another emulator instance|Address already in use|port .* already|already running/i.test(text)
    if (!held || attempt === 3) throw new Error(lastError)
    log(`Emulator port is still held. Waiting to try again (${attempt}/3)…`)
    await waitForAvdRelease(sdk, spec, serial).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(lastError)
}

export async function stopEmulator(emu: RunningEmulator): Promise<void> {
  await emu.adb.exec(['emu', 'kill']).catch(() => undefined)
  emu.process?.kill()
}

export async function sdkVersion(adb: Adb): Promise<number> {
  return Number((await adb.shell('getprop ro.build.version.sdk')).trim())
}

export { run as execFileAsync }
