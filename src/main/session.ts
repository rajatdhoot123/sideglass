import { EventEmitter } from 'node:events'
import { existsSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { generateSPKIFingerprint } from 'mockttp'
import { join } from 'node:path'
import { installSystemCa, loadOrCreateCa, type CaFiles } from './certificate'
import { CAPTURE_PIN, LockKeeper } from './lock'
import { CAPTURE_PHONE, ensureAvd, IMAGE_ABI, ramdiskOf, sdkVersion, startEmulator, stopEmulator, type RunningEmulator } from './emulator'
import { fromHar } from './har'
import { History } from './history'
import { sendReplay, type ReplayEdit } from './replay'
import { ProtoSchema } from './schema'
import { ensureSdk } from './sdk'
import { readAppStorage, type StorageEntry } from './storage'
import { Decompiler, type CodeIndex, type CodeSearch, type CodeSearchOptions } from './decompile'
import { installApks, isPackageName, pullApp } from './store/apk'
import { cloneApp, type CloneOptions, type CloneResult } from './clone'
import { hasPlayStore, needsPlayLicense } from './playstore'
import {
  cachedRamdiskPath,
  disableBluetoothStack,
  disablePlayProtectScans,
  ensureArtifacts,
  grantSu,
  magiskAppInstalled,
  patchedRamdisk,
  ramdiskUsable,
  suGranted,
} from './magisk'
import { FEATURED, installFromFdroid, search as searchFdroid } from './store/fdroid'
import { packageFromPlayLink, PlayHelper } from './store/play'
import { usbPhones, userApps } from './store/usb'
import { Adb } from './adb'
import { Attributor } from './attrib'
import { ensureDirectAppStarts, Hooks, waitForSettledRuntime, type HooksSnapshot } from './hooks'
import { Timeline } from './timeline'
import { Logcat, type LogLine } from './logcat'
import { classifyRefusal, type Refusal } from './refusal'
import { CaptureProxy, summarize, type Exchange, type ExchangeSummary } from './proxy'
import { Mirror } from './mirror'
import type { Sdk } from './sdk'
import type { Device, LaunchOptions, LaunchResult, PhoneMode, Settings } from '../shared'
import type { ProxyRule } from './rules'

export type StepId = 'sdk' | 'ca' | 'proxy' | 'avd' | 'boot' | 'magisk' | 'device' | 'route' | 'trust' | 'ready'
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
  private lock: LockKeeper | null = null
  private runtimeTimer: NodeJS.Timeout | null = null
  /** system_server's pid when last seen. A new pid means the phone runtime restarted. */
  private systemPid = ''
  private recovering = false
  sdk: Sdk | null = null
  ca: CaFiles | null = null
  emulator: RunningEmulator | null = null
  /** The phone being captured: the emulator, or the user's phone over USB. */
  device: Adb | null = null
  screen: Mirror | null = null
  logcat: Logcat | null = null
  readonly schema = new ProtoSchema()
  private history: History | null = null
  /** HAR files opened in this session, so their rows can be inspected like a live exchange. */
  private opened = new Map<string, Exchange>()
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
    const sdk = await this.step('sdk', 'Finding Android SDK', () => ensureSdk(this.log))
    this.sdk = sdk
    const ca = await this.step('ca', 'Preparing local certificate', () => loadOrCreateCa(join(this.dataDir, 'ca')))
    this.ca = ca
    const port = await this.step('proxy', 'Starting capture proxy', () => this.proxy.start(ca, 8890))
    this.proxy.inputFor = (at) => this.timeline.match(at)
    try {
      this.history = new History(join(this.dataDir, 'history.sqlite'))
      this.history.open()
      this.proxy.persist = (exchange) => {
        try {
          this.history?.save(exchange)
        } catch (error) {
          this.log(`Could not save the request: ${(error as Error).message}`)
        }
      }
    } catch (error) {
      this.log(`Saved sessions are unavailable: ${(error as Error).message}`)
    }
    this.log(`Proxy listening on 127.0.0.1:${port}`)
    const adb = this.mode === 'usb' ? await this.startUsb(sdk, ca, port) : await this.startVirtual(sdk, ca, port)
    this.device = adb
    if (this.mode === 'virtual') {
      this.attrib = new Attributor(adb)
      this.proxy.lookupApp = (host, port) => this.attrib!.lookup(host, port)
      this.attrib.start()
      this.log('Requests are tagged with the app that opened the socket.')
      this.lock = new LockKeeper(adb, CAPTURE_PIN, this.log)
      await this.lock.start()
      this.watchRuntime(adb)
    }
    if (this.mode === 'virtual' && this.hooksEnabled) await this.armIconHooks(adb)
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
    const stock = ramdiskOf(sdk, CAPTURE_PHONE)
    const cachedFile = existsSync(stock) ? cachedRamdiskPath(this.dataDir, stock) : ''
    const cached = cachedFile && ramdiskUsable(cachedFile) ? cachedFile : ''
    let bootedWithRamdisk = false
    let emu = await this.step('boot', 'Booting virtual phone', async () => {
      // Only adopt a phone this app booted (see emulator.json): one started by hand or left
      // by another tool has no capture proxy, and its traffic would never reach us.
      const recordPath = join(this.dataDir, 'emulator.json')
      const serial = `emulator-${CAPTURE_PHONE.port}`
      const record = existsSync(recordPath)
        ? (JSON.parse(await readFile(recordPath, 'utf8').catch(() => 'null')) as { proxyPort?: number } | null)
        : null
      const running = (await Adb.devices(sdk.adb)).some((d) => d.serial === serial && d.state === 'device')
      if (running && record?.proxyPort !== port) {
        this.log('The running phone was not started for this session — restarting it with capture routing...')
        const stale = new Adb(sdk.adb, serial)
        await stale.exec(['emu', 'kill']).catch(() => undefined)
        await stale.untilGone().catch(() => undefined)
      }
      const started = await startEmulator(sdk, CAPTURE_PHONE, this.log, port, cached || undefined)
      bootedWithRamdisk = Boolean(cached)
      await writeFile(recordPath, JSON.stringify({ proxyPort: port, ramdisk: bootedWithRamdisk, at: Date.now() })).catch(() => undefined)
      return started
    })
    this.emulator = emu
    await this.step('magisk', 'Setting up Magisk root', async () => {
      await disablePlayProtectScans(emu.adb)
      await disableBluetoothStack(emu.adb)
      if (await suGranted(emu.adb)) {
        this.log('Root is available through Magisk su')
        return
      }
      const artifacts = await ensureArtifacts(this.dataDir, this.log, IMAGE_ABI)
      if (!(await magiskAppInstalled(emu.adb))) {
        this.log('Installing the Magisk manager app...')
        await emu.adb.exec(['install', '-r', artifacts.apk], 300_000)
      }
      if (!bootedWithRamdisk) {
        const patched = await patchedRamdisk(emu.adb, this.dataDir, stock, this.log, IMAGE_ABI)
        this.log('Restarting the phone with the Magisk ramdisk...')
        await stopEmulator(emu)
        emu = await startEmulator(sdk, CAPTURE_PHONE, this.log, port, patched)
        this.emulator = emu
      }
      await grantSu(emu.adb, artifacts.apk, this.log)
    })
    await this.step('trust', 'Installing certificate as a system CA', async () => {
      await this.trust(emu.adb, ca)
      this.log(`Android API ${await sdkVersion(emu.adb)}: CA ${ca.androidName} trusted`)
    })
    // The emulator's Wi-Fi goes out through netsimd straight to the internet, around
    // `-http-proxy`; only mobile data passes the capture proxy. With Wi-Fi on, apps
    // prefer it and none of their calls show. The setting persists across boots.
    await emu.adb.shell('svc wifi disable').catch(() => undefined)
    this.log('Wi-Fi is off on the capture phone so all traffic goes through Sideglass (mobile data).')
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
    throw new Error('This virtual phone has no Play Store. The capture phone is a Play image; check the system image.')
  }

  private playHelper(): PlayHelper {
    const adb = this.requireAdb()
    if (!this.play) {
      this.play = new PlayHelper(adb)
      this.play.on('log', (l) => this.emit('store-log', l))
      this.play.on('stage', (st) => this.emit('play-stage', st))
    } else {
      this.play.adopt(adb)
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
    this.requirePackage(pkg)
    return installFromFdroid(this.requireAdb(), pkg, join(this.downloads, 'fdroid'), (l) => this.emit('store-log', l))
  }

  /**
   * Play Store link: open it on the capture phone's own Play Store, wait for the app to
   * install there. Sideglass taps Install itself and only stops for the user (sign-in,
   * prompts, paid apps).
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
    this.emit('store-log', `Opening ${pkg} in the Play Store on the capture phone…`)
    const installed = await play.open(pkg)
    this.emit('store-log', installed ? `${pkg} is already installed` : 'Sideglass taps Install for you — sign in if the store asks')
    await play.waitAndInstall(pkg, () => this.playCancelled)
    this.emit('store-log', `${pkg} is on the capture phone.`)
    this.emit('play-stage', { stage: 'done', message: `${pkg} is installed.` })
    return pkg
  }

  cancelPlay(): void {
    this.playCancelled = true
  }

  usbApps(serial: string) {
    return userApps(new Adb(this.sdk!.adb, serial))
  }

  async installFromUsb(serial: string, pkg: string): Promise<string> {
    this.requirePackage(pkg)
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

  /**
   * Restart an app so it starts in a process that sees our CA. With Hooks on, or with unpin,
   * the hooks agent (which includes certificate unpinning) is loaded into it.
   */
  async launch(pkg: string, options?: LaunchOptions): Promise<LaunchResult> {
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
    const unpin = Boolean(options?.unpin)
    if (unpin && this.mode !== 'virtual') throw new Error('Certificate unpinning needs the rooted virtual phone.')
    if ((this.hooksEnabled || unpin) && this.mode === 'virtual') {
      try {
        const hooks = this.getHooks()
        // The same path as the Hooks switch: one arm at a time, and the app pool is cleared first.
        if (this.hooksEnabled && !hooks.gating && (await this.armIconHooks(adb))) await this.attachScreen(adb)
        if (hooks.gating) {
          // Zygote loads the agent into the new process. Spawning again would inject it twice.
          await adb.shell(`am force-stop ${pkg}`)
          const since = Date.now()
          await adb.shell(`am start -n '${component}'`)
          const deadline = since + 10_000
          let hookedPid: number | null = null
          while (Date.now() < deadline) {
            hookedPid = hooks.hookedSince(pkg, since)
            if (hookedPid) break
            await new Promise((r) => setTimeout(r, 250))
          }
          const pid = hookedPid ?? (await this.pidOf(pkg))
          if (pid) this.watch(pkg, pid)
          if (!hookedPid) {
            const note = `${pkg} started, but its hooks did not load.`
            this.emit('hooks-log', note)
            message = message ? `${message} ${note}` : note
          }
          return { device: 'capture', pid, hooked: Boolean(hookedPid), message }
        }
        const pid = await hooks.launch(pkg)
        this.watch(pkg, pid)
        return { device: 'capture', pid, hooked: true, message }
      } catch (error) {
        // Unpinning was asked for: a normal start would just show the same refused TLS again.
        if (unpin) throw new Error(`${pkg} could not start with certificate unpinning: ${(error as Error).message}`)
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
    if (this.mode === 'virtual') {
      const hooks = this.getHooks()
      hooks.enabled = on
      if (on && this.device) {
        void this.armIconHooks(this.device).then((restarted) => {
          if (restarted && this.device) {
            void this.attachScreen(this.device).catch((error) => this.log(`Screen did not reopen: ${(error as Error).message}`))
          }
        })
      } else {
        void hooks.disarm()
      }
    } else if (this.hooks) {
      this.hooks.enabled = on
    }
    const snapshot = this.hooksState()
    this.emit('hooks-state', snapshot)
    return snapshot
  }

  private hooksArm: Promise<boolean> | null = null

  /**
   * Make an icon tap fork a new process, then arm zygote gating. A restarted
   * zygote loses the CA mount, so trust is installed again. Returns whether
   * the runtime was restarted (the screen mirror has to be opened again).
   */
  private armIconHooks(adb: Adb): Promise<boolean> {
    this.hooksArm ??= this.doArmIconHooks(adb).finally(() => {
      this.hooksArm = null
    })
    return this.hooksArm
  }

  private async doArmIconHooks(adb: Adb): Promise<boolean> {
    let restarted = false
    try {
      restarted = await ensureDirectAppStarts(adb, (line) => {
        // Set before the restart finishes, so a failure halfway still reinstalls the CA.
        restarted = true
        this.log(line)
      })
      if (restarted && this.ca) await this.trust(adb, this.ca)
      await this.getHooks().arm()
      return restarted
    } catch (error) {
      if (restarted && this.ca) await this.trust(adb, this.ca).catch(() => undefined)
      this.log(`Opening an app from its icon will not inject hooks (${(error as Error).message}). The launch list still tries.`)
      return restarted
    } finally {
      // This restart was ours: the next check takes the new system_server as its baseline.
      if (restarted) this.systemPid = ''
    }
  }

  /**
   * Notice the phone runtime restarting on its own (system_server crashed, or zygote was
   * restarted by something else). Everything tied to the old runtime is then gone: the CA
   * mount, the zygote hooks, the scrcpy server.
   */
  private watchRuntime(adb: Adb): void {
    const check = async () => {
      if (this.hooksArm || this.recovering) return
      const pid = (await adb.shell('pidof system_server', 5_000).catch(() => '')).trim()
      if (!pid) return
      const before = this.systemPid
      this.systemPid = pid
      if (before && pid !== before) await this.recoverRuntime(adb)
    }
    void check()
    this.runtimeTimer = setInterval(() => void check(), 5_000)
  }

  private async recoverRuntime(adb: Adb): Promise<void> {
    this.recovering = true
    try {
      this.log('The phone runtime restarted. Setting the certificate, screen and hooks up again...')
      await waitForSettledRuntime(adb)
      if (this.ca) await this.trust(adb, this.ca)
      await this.hooks?.runtimeRestarted()
      await this.attachScreen(adb).catch((error) => this.log(`Screen did not reopen: ${(error as Error).message}`))
      if (this.hooksEnabled) await this.armIconHooks(adb)
    } catch (error) {
      this.log(`Could not recover from the runtime restart: ${(error as Error).message}`)
    } finally {
      this.recovering = false
      this.systemPid = ''
    }
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
    await this.requireAdb().exec(['emu', 'sms', 'send', from, text])
  }

  private requireAdb() {
    if (!this.device) throw new Error('No device yet')
    return this.device
  }

  getExchange(id: string): Exchange | null {
    const live = this.proxy.exchanges.get(id)
    if (live) return live
    return this.opened.get(id) ?? this.history?.find(id) ?? null
  }

  listRules(): ProxyRule[] {
    return this.proxy.listRules()
  }

  addRule(input: Omit<ProxyRule, 'id'>): ProxyRule[] {
    return this.proxy.addRule(input)
  }

  removeRule(id: string): ProxyRule[] {
    return this.proxy.removeRule(id)
  }

  async replay(id: string, edit?: ReplayEdit): Promise<void> {
    const exchange = this.getExchange(id)
    if (!exchange) throw new Error('That request is gone')
    const replayed = await sendReplay(exchange, edit)
    this.proxy.record(replayed)
  }

  loadProto(file: string): string[] {
    return this.schema.loadFile(file)
  }

  decodeSchema(id: string, side: 'request' | 'response', typeName: string): string {
    const exchange = this.getExchange(id)
    const bytes = side === 'request' ? exchange?.requestBytes : exchange?.responseBytes
    if (!bytes) throw new Error('That body was not kept as protobuf bytes. Load the .proto and capture the call again.')
    const type = side === 'response' ? (exchange?.contentType ?? '') : String(exchange?.requestHeaders['content-type'] ?? exchange?.contentType ?? '')
    return this.schema.decode(bytes, type, typeName)
  }

  sessions() {
    return this.history?.list() ?? []
  }

  searchSessions(query: string): ExchangeSummary[] {
    return this.history?.search(query.trim()) ?? []
  }

  loadSession(id: string): ExchangeSummary[] {
    return this.history?.load(id) ?? []
  }

  openHarText(text: string): ExchangeSummary[] {
    const exchanges = fromHar(text)
    for (const exchange of exchanges) this.opened.set(exchange.id, exchange)
    return exchanges.map(summarize)
  }

  private decompilerInstance: Decompiler | null = null
  private get decompiler(): Decompiler {
    this.decompilerInstance ??= new Decompiler(this.dataDir, (p) => this.emit('code-progress', p))
    return this.decompilerInstance
  }

  private requirePackage(pkg: string): string {
    if (!isPackageName(pkg)) throw new Error(`Invalid package name: ${pkg}`)
    return pkg
  }

  /** Decompile an installed app with jadx. A copy of the same version is reused unless [force]. */
  decompile(pkg: string, force?: boolean): Promise<CodeIndex> {
    return this.decompiler.decompile(this.requireAdb(), this.requirePackage(pkg), Boolean(force))
  }

  cancelDecompile(pkg: string): void {
    this.decompiler.cancel(this.requirePackage(pkg))
  }

  codeIndex(pkg: string): Promise<CodeIndex | null> {
    return this.decompiler.index(this.requirePackage(pkg), this.device)
  }

  codeExportName(pkg: string): string {
    return this.decompiler.exportName(this.requirePackage(pkg))
  }

  exportCode(pkg: string, target: string): Promise<number> {
    return this.decompiler.export(this.requirePackage(pkg), target)
  }

  codeFile(pkg: string, file: string): Promise<string> {
    return this.decompiler.read(this.requirePackage(pkg), file)
  }

  searchCode(pkg: string, query: string, options?: CodeSearchOptions): Promise<CodeSearch> {
    return this.decompiler.search(this.requirePackage(pkg), query, options)
  }

  storage(pkg: string): Promise<StorageEntry[]> {
    return readAppStorage(this.requireAdb(), pkg)
  }

  async stop(): Promise<void> {
    const decompiler = this.decompilerInstance
    this.decompilerInstance = null
    await decompiler?.dispose().catch(() => undefined)
    this.history?.close()
    this.history = null
    this.attrib?.stop()
    this.attrib = null
    this.lock?.stop()
    this.lock = null
    if (this.runtimeTimer) clearInterval(this.runtimeTimer)
    this.runtimeTimer = null
    this.screen?.stop()
    this.logcat?.stop()
    await this.hooks?.stop().catch(() => undefined)
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
