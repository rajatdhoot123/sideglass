import { EventEmitter } from 'node:events'
import { generateSPKIFingerprint } from 'mockttp'
import { join } from 'node:path'
import { installSystemCa, loadOrCreateCa, type CaFiles } from './certificate'
import { CAPTURE_PHONE, ensureAvd, sdkVersion, startEmulator, stopEmulator, type RunningEmulator } from './emulator'
import { installApks, pullApp } from './store/apk'
import { FEATURED, installFromFdroid, search as searchFdroid } from './store/fdroid'
import { packageFromPlayLink, PlayHelper } from './store/play'
import { usbPhones, userApps } from './store/usb'
import { Adb } from './adb'
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
    await this.step('avd', 'Preparing virtual phone', () => ensureAvd(sdk, CAPTURE_PHONE, this.log))
    const emu = await this.step('boot', 'Booting virtual phone', () => startEmulator(sdk, CAPTURE_PHONE, this.log, port))
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

  play: PlayHelper | null = null
  private playCancelled = false

  private get downloads(): string {
    return join(this.dataDir, 'apks')
  }

  installApk(paths: string[]): Promise<string> {
    return installApks(this.requireAdb(), paths)
  }

  featuredApps() {
    return FEATURED
  }

  searchStore(query: string) {
    return searchFdroid(query)
  }

  installFromStore(pkg: string): Promise<string> {
    return installFromFdroid(this.requireAdb(), pkg, join(this.downloads, 'fdroid'), (l) => this.emit('store-log', l))
  }

  /**
   * Play Store link: open it on the Play phone, wait for the user to tap Install there,
   * copy the APK files and install them on the capture phone.
   */
  async installFromPlay(link: string): Promise<string> {
    const pkg = packageFromPlayLink(link)
    if (!pkg) throw new Error('Paste a Play Store link (…details?id=com.example) or a package name')
    if (!this.play) {
      this.play = new PlayHelper(this.sdk!)
      this.play.on('log', (l) => this.emit('store-log', l))
      this.play.on('frame', (png: Buffer) => this.emit('play-frame', png))
    }
    this.playCancelled = false
    this.emit('store-log', 'Starting the Play Store phone (first time: sign in with your Google account)…')
    const installed = await this.play.open(pkg)
    this.emit('store-log', installed ? `${pkg} is already on the Play phone` : `Tap Install on the Play phone for ${pkg}`)
    const apks = await this.play.waitAndPull(pkg, join(this.downloads, 'play'), undefined, () => this.playCancelled)
    this.emit('store-log', `Copying ${apks.length} APK file(s) to the capture phone…`)
    const result = await installApks(this.requireAdb(), apks)
    this.emit('store-log', `${pkg}: ${result}`)
    return pkg
  }

  cancelPlay(): void {
    this.playCancelled = true
  }

  usbPhones() {
    return usbPhones(this.sdk!.adb)
  }

  usbApps(serial: string) {
    return userApps(new Adb(this.sdk!.adb, serial))
  }

  async installFromUsb(serial: string, pkg: string): Promise<string> {
    this.emit('store-log', `Copying ${pkg} from ${serial}…`)
    const apks = await pullApp(new Adb(this.sdk!.adb, serial), pkg, join(this.downloads, 'usb'))
    const result = await installApks(this.requireAdb(), apks)
    this.emit('store-log', `${pkg}: ${result}`)
    return result
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
    await this.play?.stop().catch(() => undefined)
    if (this.emulator) await stopEmulator(this.emulator)
    await this.proxy.stop()
  }
}
