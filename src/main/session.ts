import { EventEmitter } from 'node:events'
import { generateSPKIFingerprint } from 'mockttp'
import { join } from 'node:path'
import { installSystemCa, loadOrCreateCa, type CaFiles } from './certificate'
import { CAPTURE_PHONE, ensureAvd, IMAGE_ABI, sdkVersion, startEmulator, stopEmulator, type RunningEmulator } from './emulator'
import { installApks, pullApp } from './store/apk'
import { FEATURED, installFromFdroid, search as searchFdroid } from './store/fdroid'
import { packageFromPlayLink, PlayHelper } from './store/play'
import { usbPhones, userApps } from './store/usb'
import { Adb } from './adb'
import { Hooks, type HooksSnapshot } from './hooks'
import { Logcat, type LogLine } from './logcat'
import { CaptureProxy } from './proxy'
import { classifyRefusal, type Refusal } from './refusal'
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
  private hooks: Hooks | null = null
  private hooksEnabled = true
  /** Apps we launched, so logcat can be watched for them refusing to run. */
  private refusals = new Map<string, { pid: number | null; seen: Set<Refusal['kind']> }>()

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
    this.logcat.on('lines', (lines: LogLine[]) => {
      this.emit('logcat', lines)
      this.checkRefusals(lines)
    })
    this.logcat.start()
    this.progress('ready', 'done', 'Ready')
  }

  play: PlayHelper | null = null
  private playCancelled = false
  private playRunning: string | null = null

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
    if (this.playRunning) throw new Error(`Already getting ${this.playRunning}. Cancel it first.`)
    this.playRunning = pkg
    try {
      return await this.runPlay(pkg)
    } finally {
      this.playRunning = null
    }
  }

  private async runPlay(pkg: string): Promise<string> {
    if (!this.play) {
      this.play = new PlayHelper(this.sdk!)
      this.play.on('log', (l) => this.emit('store-log', l))
      this.play.on('frame', (png: Buffer) => this.emit('play-frame', png))
      this.play.on('stage', (st) => this.emit('play-stage', st))
    }
    this.playCancelled = false
    this.emit('store-log', 'Starting the Play Store phone (first time: sign in with your Google account)…')
    const installed = await this.play.open(pkg)
    this.emit('store-log', installed ? `${pkg} is already on the Play phone` : `Tap Install on the Play phone for ${pkg}`)
    const apks = await this.play.waitAndPull(pkg, join(this.downloads, 'play'), undefined, () => this.playCancelled)
    this.emit('store-log', `Copying ${apks.length} APK file(s) to the capture phone…`)
    const result = await installApks(this.requireAdb(), apks)
    this.emit('store-log', `${pkg}: ${result}`)
    this.emit('play-stage', { stage: 'done', message: `${pkg} is on the capture phone.` })
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

  /**
   * Start an app. With hooks enabled (the default), it starts suspended through
   * Frida and gets the agent before its first line runs; otherwise it starts
   * normally. Returns the pid, or null if the app never came up.
   */
  async launch(pkg: string): Promise<number | null> {
    const adb = this.requireAdb()
    this.refusals.delete(pkg)
    if (this.hooksEnabled) {
      try {
        const pid = await this.getHooks().launch(pkg)
        this.watch(pkg, pid)
        return pid
      } catch (error) {
        this.emit('hooks-log', `Hooks unavailable (${(error as Error).message}); launching normally`)
      }
    }
    await adb.shell(`am force-stop ${pkg}`)
    await adb.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`)
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const pid = await this.pidOf(pkg)
      if (pid) {
        this.watch(pkg, pid)
        return pid
      }
    }
    return null
  }

  /** Watch logcat from a launched app so the UI can say why it refused to run. */
  private watch(pkg: string, pid: number | null): void {
    this.refusals.set(pkg, { pid, seen: new Set() })
  }

  private checkRefusals(lines: LogLine[]): void {
    for (const [pkg, info] of this.refusals) {
      const hit = classifyRefusal(lines, pkg, info.pid)
      if (hit && !info.seen.has(hit.kind)) {
        info.seen.add(hit.kind)
        this.emit('app-refusal', hit)
      }
    }
  }

  private getHooks(): Hooks {
    if (!this.hooks) {
      this.hooks = new Hooks(() => this.requireAdb(), IMAGE_ABI, join(this.dataDir, 'frida'), {
        log: (line) => this.emit('hooks-log', line),
        state: (snapshot) => this.emit('hooks-state', snapshot),
      })
    }
    return this.hooks
  }

  setHooksEnabled(on: boolean): HooksSnapshot {
    this.hooksEnabled = on
    const snapshot = this.hooksState()
    if (this.hooks) this.hooks.enabled = on
    this.emit('hooks-state', snapshot)
    return snapshot
  }

  hooksState(): HooksSnapshot {
    return this.hooks?.snapshot() ?? { enabled: this.hooksEnabled, ready: false, message: '' }
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
    await this.hooks?.stop().catch(() => undefined)
    await this.play?.stop().catch(() => undefined)
    if (this.emulator) await stopEmulator(this.emulator)
    await this.proxy.stop()
  }
}
