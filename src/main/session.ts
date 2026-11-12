import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { generateSPKIFingerprint } from 'mockttp'
import { join } from 'node:path'
import { installSystemCa, loadOrCreateCa, type CaFiles } from './certificate'
import { CAPTURE_PHONE, ensureAvd, IMAGE_ABI, sdkVersion, startEmulator, stopEmulator, type RunningEmulator } from './emulator'
import { installApks, isPackageName, pullApp } from './store/apk'
import { cloneApp, type CloneOptions, type CloneResult } from './clone'
import { hasPlayStore, installPlayStore, needsPlayLicense, pullPlayStore } from './playstore'
import { FEATURED, installFromFdroid, search as searchFdroid } from './store/fdroid'
import { packageFromPlayLink, PlayHelper } from './store/play'
import { usbPhones, userApps } from './store/usb'
import { Adb } from './adb'
import { Attributor } from './attrib'
import { Hooks, type HooksSnapshot } from './hooks'
import { Timeline } from './timeline'
import { Logcat, type LogLine } from './logcat'
import { classifyRefusal, type Refusal } from './refusal'
import { CaptureProxy } from './proxy'
import { Mirror } from './mirror'
import { findSdk, type Sdk } from './sdk'
import type { Device, LaunchResult, PhoneMode, Settings } from '../shared'

export type StepId = 'sdk' | 'ca' | 'proxy' | 'avd' | 'boot' | 'root' | 'device' | 'route' | 'trust' | 'ready'
export interface Progress {
  step: StepId
  state: 'running' | 'done' | 'failed'
  message: string
}

/** Everything one capture session needs, set up in order with progress for the UI. */
export class Session extends EventEmitter {
  readonly proxy = new CaptureProxy()
  readonly timeline = new Timeline()
  private attrib: Attributor | null = null
  sdk: Sdk | null = null
  ca: CaFiles | null = null
  emulator: RunningEmulator | null = null
  /** The phone being captured: the emulator, or the user's phone over USB. */
  device: Adb | null = null
  screen: Mirror | null = null
  logcat: Logcat | null = null
  /** USB mode: the phone whose proxy setting we changed, and the port, to undo on stop. */
  private routed: { adb: Adb; port: number } | null = null
  private hooks: Hooks | null = null
  private hooksEnabled = true
  /** Apps we launched, so logcat can be watched for them refusing to run. */
  private refusals = new Map<string, { pid: number | null; seen: Set<Refusal['kind']> }>()

  constructor(
    private readonly dataDir: string,
    private readonly settings: Settings,
  ) {
    super()
  }

  get mode(): PhoneMode {
    return this.settings.phone ?? 'virtual'
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
    this.proxy.inputFor = (at) => this.timeline.match(at)
    this.log(`Proxy listening on 127.0.0.1:${port}`)
    const adb = this.mode === 'usb' ? await this.startUsb(sdk, ca, port) : await this.startVirtual(sdk, ca, port)
    this.device = adb
    if (this.mode === 'virtual') {
      this.attrib = new Attributor(adb)
      this.proxy.lookupApp = (host, port) => this.attrib!.lookup(host, port)
      this.attrib.start()
      this.log('Requests are tagged with the app that opened the socket.')
    }
    await this.attachScreen(adb)
    this.logcat = new Logcat(adb)
    this.logcat.on('lines', (lines: LogLine[]) => {
      this.checkRefusals(lines)
      this.emit('logcat', lines)
    })
    this.logcat.start()
    this.progress('ready', 'done', 'Ready')
  }

  private async startVirtual(sdk: Sdk, ca: CaFiles, port: number): Promise<Adb> {
    await this.step('avd', 'Preparing virtual phone', () => ensureAvd(sdk, CAPTURE_PHONE, this.log))
    const emu = await this.step('boot', 'Booting virtual phone', () => startEmulator(sdk, CAPTURE_PHONE, this.log, port))
    this.emulator = emu
    await this.step('root', 'Getting root on the virtual phone', () => emu.adb.root())
    await this.step('trust', 'Installing certificate as a system CA', async () => {
      await this.trust(emu.adb, ca)
      this.log(`Android API ${await sdkVersion(emu.adb)}: CA ${ca.androidName} trusted`)
    })
    return emu.adb
  }

  /**
   * The user's own phone, no root needed. Its traffic goes over the USB cable to the proxy
   * (adb reverse + the global HTTP proxy setting). Without root our CA can only be a user CA,
   * so HTTPS contents show only for apps that trust user CAs (Chrome, debug builds that opt in);
   * the rest appear under Refused TLS with their host names.
   */
  private async startUsb(sdk: Sdk, ca: CaFiles, port: number): Promise<Adb> {
    const adb = await this.step('device', 'Finding your phone', async () => {
      const phones = await usbPhones(sdk.adb)
      if (!phones.length) {
        throw new Error(
          'No phone found. Connect it with a USB cable, turn on USB debugging (Settings → Developer options) and allow this computer on the phone, or start another emulator.',
        )
      }
      const wanted = this.settings.usbSerial
      const phone = phones.find((p) => p.serial === wanted) ?? phones[0]
      if (wanted && phone.serial !== wanted) this.log(`${wanted} is not connected; using ${phone.model} instead`)
      this.log(`Using ${phone.model} (${phone.serial}${phone.emulator ? ', emulator' : ''})`)
      return new Adb(sdk.adb, phone.serial)
    })
    await this.step('route', "Routing the phone's traffic through Sideglass", async () => {
      await adb.exec(['reverse', `tcp:${port}`, `tcp:${port}`])
      // Record the route before the proxy setting, so a failure here is still undone on stop.
      this.routed = { adb, port }
      await adb.shell(`settings put global http_proxy 127.0.0.1:${port}`)
      this.log("The phone's internet goes through Sideglass while it runs; quitting Sideglass puts it back.")
    })
    await this.step('trust', 'Copying the certificate to the phone', async () => {
      const local = join(this.dataDir, 'ca', 'sideglass-ca.crt')
      writeFileSync(local, ca.cert)
      await adb.shell('mkdir -p /sdcard/Download').catch(() => undefined)
      await adb.exec(['push', local, '/sdcard/Download/sideglass-ca.crt'])
      this.log(
        'To see HTTPS contents for apps that allow it, install Download/sideglass-ca.crt on the phone: ' +
          'Settings → Security → Encryption & credentials → Install a certificate → CA certificate.',
      )
    })
    return adb
  }

  /** USB mode: open the phone's security settings, where the user installs our CA. */
  async openCertificateSettings(): Promise<void> {
    await this.requireAdb().shell('am start -a android.settings.SECURITY_SETTINGS')
  }

  /** Trust our CA in the system store and in Chrome. Needed after every boot (the CA mount is tmpfs). */
  private async trust(adb: Adb, ca: CaFiles): Promise<void> {
    await installSystemCa(adb, ca)
    // Chrome uses its own root list, not the system store: tell it to accept our CA's key,
    // and skip its welcome and sign-in screens, which get in the way of a test phone.
    const spki = await generateSPKIFingerprint(ca.cert)
    const flags = `chrome --disable-fre --no-default-browser-check --no-first-run --ignore-certificate-errors-spki-list=${spki}`
    await adb
      .shell(
        `echo '${flags}' > /data/local/tmp/chrome-command-line && chmod 644 /data/local/tmp/chrome-command-line` +
          ' && am set-debug-app --persistent com.android.chrome && am force-stop com.android.chrome',
      )
      .catch(() => undefined)
  }

  private playStoreSetup: Promise<void> | null = null

  /**
   * Give the capture phone the real Play Store so apps that check their Google Play licence
   * (PairIP and LVL) can run there, with their traffic captured. Takes a few minutes once.
   */
  private ensurePlayStore(): Promise<void> {
    this.playStoreSetup ??= this.setUpPlayStore().finally(() => {
      this.playStoreSetup = null
    })
    return this.playStoreSetup
  }

  private async setUpPlayStore(): Promise<void> {
    const adb = this.requireAdb()
    if (await hasPlayStore(adb)) return
    const say = (line: string) => this.emit('store-log', line)
    say('This app checks its Google Play licence. Copying Google Play from the Play phone (first time only)…')
    const files = await pullPlayStore(await this.playHelper().start(), join(this.dataDir, 'playstore'))
    this.logcat?.stop()
    this.screen?.stop()
    try {
      await installPlayStore(adb, files, say)
      await adb.root()
      await this.trust(adb, this.ca!)
    } finally {
      // Installing Play reboots the phone, so a frida-server from an earlier launch is gone.
      await this.hooks?.stop().catch(() => undefined)
      this.logcat = new Logcat(adb)
      this.logcat.on('lines', (lines: LogLine[]) => {
        this.checkRefusals(lines)
        this.emit('logcat', lines)
      })
      this.logcat.start()
      await this.attachScreen(adb)
    }
    say('Google Play is on the capture phone.')
  }

  private playHelper(): PlayHelper {
    if (!this.play) {
      this.play = new PlayHelper(this.sdk!, join(this.dataDir, 'scrcpy'))
      this.play.on('log', (l) => this.emit('store-log', l))
      this.play.on('frame', (png: Buffer) => this.emit('play-frame', png))
      this.play.on('video', (packet) => this.emit('play-video', packet))
      this.play.on('screen-mode', (mode) => this.emit('play-screen-mode', mode))
      this.play.on('stage', (st) => this.emit('play-stage', st))
    }
    return this.play
  }

  /** The scrcpy server dies across a reboot, so the picture has to be opened again. */
  private async attachScreen(adb: Adb): Promise<void> {
    this.screen?.stop()
    const screen = new Mirror(adb, join(this.dataDir, 'scrcpy'), 1)
    screen.on('frame', (png: Buffer) => this.emit('frame', png))
    screen.on('video', (packet) => this.emit('video', packet))
    screen.on('mode', (mode) => this.emit('screen-mode', mode))
    screen.on('log', (line: string) => this.log(line))
    this.screen = screen
    await screen.start()
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
    const play = this.playHelper()
    this.playCancelled = false
    this.emit('store-log', 'Starting the Play Store phone (first time: sign in with your Google account)…')
    const installed = await play.open(pkg)
    this.emit('store-log', installed ? `${pkg} is already on the Play phone` : `Tap Install on the Play phone for ${pkg}`)
    const apks = await play.waitAndPull(pkg, join(this.downloads, 'play'), undefined, () => this.playCancelled)
    this.emit('store-log', `Copying ${apks.length} APK file(s) to the capture phone…`)
    // Record Google Play as the installer, as on a real phone; licence checks look at it.
    const result = await installApks(this.requireAdb(), apks, 'com.android.vending')
    this.emit('store-log', `${pkg}: ${result}`)
    this.emit('play-stage', { stage: 'done', message: `${pkg} is on the capture phone.` })
    return pkg
  }

  cancelPlay(): void {
    this.playCancelled = true
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

  private cloning: string | null = null

  /** Install a copy of an installed app under a new package and name, next to the original. */
  async cloneApp(options: CloneOptions): Promise<CloneResult> {
    if (this.cloning) throw new Error(`Already cloning ${this.cloning}. Wait for it to finish.`)
    this.cloning = options.pkg
    try {
      return await cloneApp(this.requireAdb(), this.sdk!, this.dataDir, options, (l) => this.emit('store-log', l))
    } finally {
      this.cloning = null
    }
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
  async launch(pkg: string): Promise<LaunchResult> {
    if (!isPackageName(pkg)) throw new Error(`Invalid package name: ${pkg}`)
    const adb = this.requireAdb()
    let message: string | undefined
    // A real phone has Google Play already; only the virtual phone needs it put in.
    if (this.mode === 'virtual' && needsPlayLicense(await adb.shell(`dumpsys package ${pkg}`).catch(() => ''))) {
      await this.ensurePlayStore()
      const account = /Account \{name=[^,]+, type=com\.google\}/.test(await adb.shell('dumpsys account').catch(() => ''))
      if (!account) {
        message = `${pkg} checks its Google Play licence: sign in to Google Play on this phone with the account that has the app.`
      }
    }
    // `monkey` aborts when any other process crashes, which the emulator's Bluetooth stack does after a reboot.
    const resolved = await adb.shell(
      `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`,
    )
    const component = resolved.trim().split('\n').pop()?.trim() ?? ''
    if (!component.startsWith(`${pkg}/`)) throw new Error(`${pkg} has no launcher activity`)
    if (this.attrib) this.attrib.preferPkg = pkg
    this.refusals.delete(pkg)
    // Hooks need root. A USB phone, and any other emulator treated as one, stays on a normal launch.
    if (this.hooksEnabled && this.mode === 'virtual') {
      try {
        const pid = await this.getHooks().launch(pkg)
        this.watch(pkg, pid)
        return { device: 'capture', pid, hooked: true, message }
      } catch (error) {
        const fallback = `Hooks unavailable (${(error as Error).message}); launching normally`
        this.emit('hooks-log', fallback)
        message = message ? `${message} ${fallback}` : fallback
      }
    }
    await adb.shell(`am force-stop ${pkg}`)
    await adb.shell(`am start -n '${component}'`)
    await new Promise((r) => setTimeout(r, 1500))
    const pid = await this.pidOf(pkg)
    if (pid) this.watch(pkg, pid)
    return { device: 'capture', pid, hooked: false, message }
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
    // Snapshot reads Hooks.enabled. Update it first, or the switch sticks on the old value.
    if (this.hooks) this.hooks.enabled = on
    const snapshot = this.hooksState()
    this.emit('hooks-state', snapshot)
    return snapshot
  }

  hooksState(): HooksSnapshot {
    const live = this.hooks?.snapshot()
    if (!live) return { enabled: this.hooksEnabled, ready: false, starting: false, message: '' }
    return { ...live, enabled: this.hooksEnabled }
  }

  async pidOf(pkg: string): Promise<number | null> {
    const out = (await this.requireAdb().shell(`pidof ${pkg}`).catch(() => '')).trim()
    return out ? Number(out.split(/\s+/)[0]) : null
  }

  async sendSms(device: Device, from: string, text: string): Promise<void> {
    if (this.mode !== 'virtual') throw new Error('Test SMS only works on the virtual phone')
    const adb = device === 'play' ? this.play?.emulator?.adb : this.requireAdb()
    if (!adb) throw new Error(device === 'play' ? 'The Play phone is not running' : 'No device yet')
    await adb.exec(['emu', 'sms', 'send', from, text])
  }

  private requireAdb() {
    if (!this.device) throw new Error('No device yet')
    return this.device
  }

  async stop(): Promise<void> {
    this.attrib?.stop()
    this.attrib = null
    this.screen?.stop()
    this.logcat?.stop()
    await this.hooks?.stop().catch(() => undefined)
    await this.play?.stop().catch(() => undefined)
    if (this.routed) {
      // Give the phone its own internet back; otherwise it keeps pointing at a closed proxy.
      const { adb, port } = this.routed
      this.routed = null
      await adb.shell('settings put global http_proxy :0').catch(() => undefined)
      await adb.shell('settings delete global http_proxy').catch(() => undefined)
      await adb.exec(['reverse', '--remove', `tcp:${port}`]).catch(() => undefined)
    }
    if (this.emulator) await stopEmulator(this.emulator)
    await this.proxy.stop()
  }
}
