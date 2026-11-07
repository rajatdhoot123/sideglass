import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

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

/** Where Android Studio, Homebrew and our own installer put the SDK. */
export function candidateRoots(): string[] {
  const home = homedir()
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(home, '.build-with-me', 'android-sdk'),
    join(home, 'Library', 'Android', 'sdk'),
    '/opt/homebrew/share/android-commandlinetools',
    '/usr/local/share/android-commandlinetools',
    join(home, 'Android', 'Sdk'),
    join(home, 'AppData', 'Local', 'Android', 'Sdk'),
  ].filter((p): p is string => Boolean(p))
}

export function findSdk(): Sdk | null {
  for (const root of candidateRoots()) {
    const adb = join(root, 'platform-tools', exe('adb'))
    const emulator = join(root, 'emulator', exe('emulator'))
    if (!existsSync(adb) || !existsSync(emulator)) continue
    const tools = ['cmdline-tools/latest/bin', 'cmdline-tools/bin', 'tools/bin']
      .map((dir) => join(root, dir))
      .find((dir) => existsSync(join(dir, bat('avdmanager'))))
    return {
      root,
      adb,
      emulator,
      avdmanager: tools ? join(tools, bat('avdmanager')) : '',
      sdkmanager: tools ? join(tools, bat('sdkmanager')) : '',
    }
  }
  return null
}
