import { EventEmitter } from 'node:events'
import { generateSPKIFingerprint } from 'mockttp'
import { join } from 'node:path'
import { installSystemCa, loadOrCreateCa, type CaFiles } from './certificate'
import { ensureAvd, sdkVersion, startEmulator, stopEmulator, type RunningEmulator } from './emulator'
import { Logcat } from './logcat'
import { CaptureProxy } from './proxy'
import { Screen } from './screen'
import { findSdk, type Sdk } from './sdk'

export type StepId = 'sdk' | 'ca' | 'proxy' | 'avd' | 'boot' | 'root' | 'trust' | 'ready'
export interface Progress {
  step: StepId
  state: 'running' | 'done' | 'failed'
  message: string
}

/** Everything one capture session needs, set up in order with progress for the UI. */
export class Session extends EventEmitter {
  readonly proxy = new CaptureProxy()
  sdk: Sdk | null = null
  ca: CaFiles | null = null
  emulator: RunningEmulator | null = null
  screen: Screen | null = null
  logcat: Logcat | null = null

  constructor(private readonly dataDir: string) {
    super()
  }

  private progress(step: StepId, state: Progress['state'], message: string): void {
    this.emit('progress', { step, state, message } satisfies Progress)
  }

  private log = (line: string): void => {
    this.emit('setup-log', line)
  }

  private async step<T>(step: StepId, label: string, work: () => Promise<T>): Promise<T> {
    this.progress(step, 'running', label)
    try {
      const out = await work()
      this.progress(step, 'done', label)
      return out
    } catch (error) {
      this.progress(step, 'failed', `${label}: ${(error as Error).message}`)
      throw error
    }
  }

  async start(): Promise<void> {
    const sdk = await this.step('sdk', 'Finding Android SDK', async () => {
      const found = findSdk()
      if (!found) throw new Error('Android SDK not found. Install Android Studio or the command-line tools.')
      return found
    })
    this.sdk = sdk
    const ca = await this.step('ca', 'Preparing local certificate', () => loadOrCreateCa(join(this.dataDir, 'ca')))
    this.ca = ca
    const port = await this.step('proxy', 'Starting capture proxy', () => this.proxy.start(ca, 8890))
    this.log(`Proxy listening on 127.0.0.1:${port}`)
    await this.step('avd', 'Preparing virtual phone', () => ensureAvd(sdk, this.log))
    const emu = await this.step('boot', 'Booting virtual phone', () => startEmulator(sdk, port, this.log))
    this.emulator = emu
    await this.step('root', 'Getting root on the virtual phone', () => emu.adb.root())
    await this.step('trust', 'Installing certificate as a system CA', async () => {
      await installSystemCa(emu.adb, ca)
      this.log(`Android API ${await sdkVersion(emu.adb)}: CA ${ca.androidName} trusted`)
    })
    // Chrome uses its own root list, not the system store: tell it to accept our CA's key,
    // and skip its welcome and sign-in screens, which get in the way of a test phone.
    const spki = await generateSPKIFingerprint(ca.cert)
    const flags = `chrome --disable-fre --no-default-browser-check --no-first-run --ignore-certificate-errors-spki-list=${spki}`
    await emu.adb
      .shell(
        `echo '${flags}' > /data/local/tmp/chrome-command-line && chmod 644 /data/local/tmp/chrome-command-line` +
          ' && am set-debug-app --persistent com.android.chrome && am force-stop com.android.chrome',
      )
      .catch(() => undefined)
    this.screen = new Screen(emu.adb)
    this.screen.on('frame', (png: Buffer) => this.emit('frame', png))
    await this.screen.start()
    this.logcat = new Logcat(emu.adb)
    this.logcat.on('lines', (lines) => this.emit('logcat', lines))
    this.logcat.start()
    this.progress('ready', 'done', 'Ready')
  }

  async installApk(paths: string[]): Promise<string> {
    const adb = this.requireAdb()
    const args = paths.length > 1 ? ['install-multiple', '-r', '-g', ...paths] : ['install', '-r', '-g', paths[0]]
    return adb.exec(args, 300_000)
  }

  async packages(): Promise<string[]> {
    const out = await this.requireAdb().shell('pm list packages -3')
    return out
      .split('\n')
      .map((l) => l.replace('package:', '').trim())
      .filter(Boolean)
      .sort()
  }

  /** Restart an app so it starts in a process that sees our CA. */
  async launch(pkg: string): Promise<void> {
    const adb = this.requireAdb()
    await adb.shell(`am force-stop ${pkg}`)
    await adb.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`)
  }

  async pidOf(pkg: string): Promise<number | null> {
    const out = (await this.requireAdb().shell(`pidof ${pkg}`).catch(() => '')).trim()
    return out ? Number(out.split(/\s+/)[0]) : null
  }

  async sendSms(from: string, text: string): Promise<void> {
    await this.requireAdb().exec(['emu', 'sms', 'send', from, text])
  }

  private requireAdb() {
    if (!this.emulator) throw new Error('No device yet')
    return this.emulator.adb
  }

  async stop(): Promise<void> {
    this.screen?.stop()
    this.logcat?.stop()
    if (this.emulator) await stopEmulator(this.emulator)
    await this.proxy.stop()
  }
}
