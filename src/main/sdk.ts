import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { arch, homedir, platform, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Paths to the Android SDK tools this app drives. */
export interface Sdk {
  root: string
  adb: string
  emulator: string
  avdmanager: string
  sdkmanager: string
}

const exe = (name: string) => (platform() === 'win32' ? `${name}.exe` : name)
const bat = (name: string) => (platform() === 'win32' ? `${name}.bat` : name)

/** Command-line tools build published by Google for a machine that has no Android Studio SDK yet. */
export const COMMAND_LINE_TOOLS_BUILD = '15859902'

export function commandLineToolsZip(platformName = platform(), cpu = arch()): string {
  if (platformName === 'darwin' && cpu === 'arm64') return `commandlinetools-mac_arm64-${COMMAND_LINE_TOOLS_BUILD}_latest.zip`
  if (platformName === 'darwin') return `commandlinetools-mac_x86_64-${COMMAND_LINE_TOOLS_BUILD}_latest.zip`
  if (platformName === 'win32') return `commandlinetools-win-${COMMAND_LINE_TOOLS_BUILD}_latest.zip`
  return `commandlinetools-linux-${COMMAND_LINE_TOOLS_BUILD}_latest.zip`
}

export function commandLineToolsUrl(platformName = platform(), cpu = arch()): string {
  return `https://dl.google.com/android/repository/${commandLineToolsZip(platformName, cpu)}`
}

/** Android Studio's bundled runtime, for a launch from Finder or the Dock where JAVA_HOME is unset. */
export function javaCandidates(platformName = platform(), home = homedir()): string[] {
  if (platformName === 'darwin') {
    return ['/Applications/Android Studio.app/Contents/jbr/Contents/Home', join(home, 'android-studio', 'jbr')]
  }
  if (platformName === 'win32') {
    return [join(home, 'AppData', 'Local', 'Programs', 'Android', 'Android Studio', 'jbr'), 'C:\\Program Files\\Android\\Android Studio\\jbr']
  }
  return [join(home, 'android-studio', 'jbr'), '/opt/android-studio/jbr', '/usr/local/android-studio/jbr']
}

export function javaHome(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platformName = platform(),
  home = homedir(),
): string | undefined {
  const fromEnv = env.JAVA_HOME
  if (fromEnv && exists(join(fromEnv, 'bin', exe('java')))) return fromEnv
  return javaCandidates(platformName, home).find((candidate) => exists(join(candidate, 'bin', exe('java'))))
}

/** Where Android Studio, Homebrew and our own installer put the SDK. */
export function candidateRoots(): string[] {
  const home = homedir()
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(home, '.sideglass', 'android-sdk'),
    join(home, 'Library', 'Android', 'sdk'),
    '/opt/homebrew/share/android-commandlinetools',
    '/usr/local/share/android-commandlinetools',
    join(home, 'Android', 'Sdk'),
    join(home, 'AppData', 'Local', 'Android', 'Sdk'),
  ].filter((p): p is string => Boolean(p))
}

export function sdkEnv(sdk: Sdk, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const java = javaHome(env)
  const path = java ? `${join(java, 'bin')}${delimiter}${env.PATH ?? ''}` : env.PATH
  return { ...env, ANDROID_HOME: sdk.root, ANDROID_SDK_ROOT: sdk.root, ...(java ? { JAVA_HOME: java } : {}), PATH: path }
}

/** The directory that directly contains bin/sdkmanager, after a command-line tools zip is unpacked. */
export function findToolsRoot(extracted: string): string | null {
  const stack = [extracted]
  while (stack.length) {
    const dir = stack.pop()
    if (!dir) break
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    if (names.includes('bin') && (existsSync(join(dir, 'bin', 'sdkmanager')) || existsSync(join(dir, 'bin', 'sdkmanager.bat')))) return dir
    for (const name of names) {
      const child = join(dir, name)
      try {
        if (statSync(child).isDirectory()) stack.push(child)
      } catch {
        // Skip unreadable entries.
      }
    }
  }
  return null
}

/** sdkmanager looks in cmdline-tools/latest. Copy the unpacked tools there. */
export function installToolsTree(found: string, sdkRoot: string): string {
  const dest = join(sdkRoot, 'cmdline-tools', 'latest')
  if (found === dest) return dest
  mkdirSync(join(sdkRoot, 'cmdline-tools'), { recursive: true })
  rmSync(dest, { recursive: true, force: true })
  cpSync(found, dest, { recursive: true })
  return dest
}

export function sdkAt(root: string): Sdk | null {
  const tools = ['cmdline-tools/latest/bin', 'cmdline-tools/bin', 'tools/bin']
    .map((dir) => join(root, dir))
    .find((dir) => existsSync(join(dir, bat('sdkmanager'))))
  if (!tools) return null
  return {
    root,
    adb: join(root, 'platform-tools', exe('adb')),
    emulator: join(root, 'emulator', exe('emulator')),
    avdmanager: join(tools, bat('avdmanager')),
    sdkmanager: join(tools, bat('sdkmanager')),
  }
}

export function findSdk(): Sdk | null {
  for (const root of candidateRoots()) {
    const sdk = sdkAt(root)
    if (sdk && existsSync(sdk.adb) && existsSync(sdk.emulator)) return sdk
  }
  return null
}

export function runSdkManager(sdk: Sdk, args: string[]): Promise<void> {
  if (!sdk.sdkmanager) throw new Error('Android cmdline-tools (sdkmanager) not found')
  if (!javaHome()) {
    throw new Error('Java not found. Install Android Studio, or set JAVA_HOME. A launch from Finder does not load your shell profile.')
  }
  return new Promise((resolve, reject) => {
    const child = spawn(sdk.sdkmanager, args, { env: sdkEnv(sdk) })
    child.stdin?.write('y\n'.repeat(40))
    child.stdin?.end()
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`sdkmanager exited ${code}`))))
  })
}

async function downloadCommandLineTools(sdkRoot: string, log: (line: string) => void): Promise<void> {
  const url = commandLineToolsUrl()
  log(`Downloading Android command-line tools (${url}). Google's SDK license applies.`)
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000), headers: { 'user-agent': 'sideglass' } })
  if (!response.ok) throw new Error(`could not download Android command-line tools (${response.status})`)
  const zip = join(tmpdir(), commandLineToolsZip())
  await writeFile(zip, Buffer.from(await response.arrayBuffer()))
  const extracted = join(tmpdir(), `sideglass-cmdline-${COMMAND_LINE_TOOLS_BUILD}`)
  rmSync(extracted, { recursive: true, force: true })
  await mkdir(extracted, { recursive: true })
  await extractZip(zip, extracted)
  const found = findToolsRoot(extracted)
  if (!found) throw new Error('The command-line tools download did not contain sdkmanager')
  installToolsTree(found, sdkRoot)
  rmSync(extracted, { recursive: true, force: true })
}

function extractZip(zip: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', zip, '-C', dest])
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`could not unpack command-line tools (${code})`))))
  })
}

/**
 * Use an installed SDK, or download Google's command-line tools into ~/.sideglass/android-sdk
 * and install platform-tools. The emulator package is installed later, with the system image.
 */
export async function ensureSdk(log: (line: string) => void): Promise<Sdk> {
  const ready = findSdk()
  if (ready) return ready
  const root = join(homedir(), '.sideglass', 'android-sdk')
  mkdirSync(root, { recursive: true })
  let sdk = sdkAt(root)
  if (!sdk) {
    await downloadCommandLineTools(root, log)
    sdk = sdkAt(root)
  }
  if (!sdk?.sdkmanager) throw new Error('Android SDK not found, and the command-line tools did not install.')
  if (!existsSync(sdk.adb)) {
    log('Installing platform-tools…')
    await runSdkManager(sdk, ['--install', 'platform-tools'])
  }
  return sdk
}
