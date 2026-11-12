import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import frida, { type Device, type Script, type Session } from 'frida'
import type { Adb } from './adb'
import { AGENT_SOURCE } from './agent'

/** Pinned to the exact `frida` npm version in package.json: client and server must match. */
export const FRIDA_VERSION = '17.26.2'

/** Non-standard port, so apps that scan for Frida's default port 27042 find nothing. */
const SERVER_PORT = 27091
const DEVICE_BIN = '/data/local/tmp/.sgsys'

const FRIDA_ABI: Record<string, string> = { 'arm64-v8a': 'arm64', x86_64: 'x86_64' }

export interface HooksSnapshot {
  enabled: boolean
  ready: boolean
  message: string
}

export interface HooksEvents {
  log: (line: string) => void
  state: (snapshot: HooksSnapshot) => void
}

/**
 * Runs frida-server on the capture phone and starts apps through it, so the agent
 * in agent.ts is loaded before the app's first line of code runs. Set up lazily on
 * the first launch; every failure degrades to a normal app launch.
 */
export class Hooks {
  enabled = true
  ready = false
  message = ''

  private device: Device | null = null
  private active = new Map<string, { session: Session; script: Script }>()

  constructor(
    private readonly getAdb: () => Adb,
    private readonly abi: string,
    private readonly cacheDir: string,
    private readonly events: HooksEvents,
  ) {}

  snapshot(): HooksSnapshot {
    return { enabled: this.enabled, ready: this.ready, message: this.message }
  }

  private say(line: string): void {
    this.events.log(line)
  }

  private announce(): void {
    this.events.state(this.snapshot())
  }

  /** Start `pkg` suspended, inject the agent, then let it run. Returns its pid. */
  async launch(pkg: string): Promise<number> {
    const device = await this.ensureDevice()
    const adb = this.getAdb()
    await adb.shell(`am force-stop ${pkg}`)
    await this.unload(pkg)
    const pid = await device.spawn(pkg)
    const session = await device.attach(pid)
    const script = await session.createScript(AGENT_SOURCE)
    const scriptMessages = (script as unknown as { message?: { connect(cb: (raw: unknown) => void): void } }).message
    scriptMessages?.connect((raw) => {
      const msg = raw as { type?: string; payload?: { sg?: string; text?: string }; description?: string }
      if (msg?.type === 'send' && msg.payload?.sg === 'log') this.say(`${pkg}: ${msg.payload.text}`)
      else if (msg?.type === 'error') this.say(`${pkg}: hook error: ${msg.description ?? 'unknown'}`)
    })
    await script.load()
    await device.resume(pid)
    this.active.set(pkg, { session, script })
    return pid
  }

  async stop(): Promise<void> {
    for (const pkg of [...this.active.keys()]) await this.unload(pkg)
    this.device = null
    this.ready = false
    this.message = ''
    this.announce()
  }

  private async unload(pkg: string): Promise<void> {
    const prior = this.active.get(pkg)
    if (!prior) return
    this.active.delete(pkg)
    try { await prior.script.unload() } catch { /* app may already be gone */ }
    try { await prior.session.detach() } catch { /* ditto */ }
  }

  /** Push frida-server if needed, start it, and connect through an adb forward. */
  private async ensureDevice(): Promise<Device> {
    if (this.device) return this.device
    const adb = this.getAdb()
    const local = await this.ensureLocalBinary()
    this.say('Starting launch hooks (frida-server)...')

    // Restarting is idempotent: a stale server would refuse the port.
    await adb.shell('kill $(pidof .sgsys) 2>/dev/null; true')
    await adb.execBuffer(['push', local, DEVICE_BIN], 120_000)
    await adb.shell(`chmod 700 ${DEVICE_BIN}`)
    // nohup + & detaches: the adb shell call returns while the server keeps running.
    await adb
      .exec(['shell', `nohup ${DEVICE_BIN} -l 127.0.0.1:${SERVER_PORT} >/dev/null 2>&1 &`], 10_000)
      .catch(() => undefined)
    await adb.exec(['forward', `tcp:${SERVER_PORT}`, `tcp:${SERVER_PORT}`])
    await this.waitPort()
    const manager = await frida.getDeviceManager()
    this.device = await manager.addRemoteDevice(`127.0.0.1:${SERVER_PORT}`)
    this.ready = true
    this.message = ''
    this.announce()
    this.say('Launch hooks ready')
    return this.device
  }

  private waitPort(timeoutMs = 20_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const attempt = () => {
        const socket = net.connect(SERVER_PORT, '127.0.0.1')
        socket.setTimeout(1500)
        socket.once('connect', () => {
          socket.destroy()
          resolve()
        })
        const retry = () => {
          socket.destroy()
          if (Date.now() - started > timeoutMs) reject(new Error('frida-server did not start on the phone'))
          else setTimeout(attempt, 400)
        }
        socket.once('error', retry)
        socket.once('timeout', retry)
      }
      attempt()
    })
  }

  /** Local frida-server binary for this machine's emulator ABI, downloading once. */
  private async ensureLocalBinary(): Promise<string> {
    const override = process.env.SIDEGLASS_FRIDA_SERVER
    if (override && existsSync(override)) return override
    mkdirSync(this.cacheDir, { recursive: true })
    const target = join(this.cacheDir, `frida-server-${FRIDA_VERSION}-${this.abi}`)
    if (existsSync(target) && statSync(target).size > 5_000_000) return target

    const fridaAbi = FRIDA_ABI[this.abi] ?? 'arm64'
    const url = `https://github.com/frida/frida/releases/download/${FRIDA_VERSION}/frida-server-${FRIDA_VERSION}-android-${fridaAbi}.xz`
    this.say(`Downloading frida-server ${FRIDA_VERSION} (${fridaAbi}), about 40 MB...`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`frida-server download failed: HTTP ${response.status}`)
    const compressed = Buffer.from(await response.arrayBuffer())

    const packed = `${target}.xz`
    writeFileSync(packed, compressed)
    const raw = decompressXz(packed)
    if (raw.length < 1_000_000) throw new Error('frida-server decompression produced a suspiciously small file')
    writeFileSync(target, raw)
    return target
  }
}

/** .xz without a dependency: try the decompressors that ship with dev machines. */
function decompressXz(path: string): Buffer {
  const candidates: Array<[string, string[]]> = [
    ['xz', ['-dc', path]],
    ['7zz', ['e', '-so', path]],
    ['7z', ['e', '-so', path]],
    ['python3', ['-c', 'import lzma,sys;sys.stdout.buffer.write(lzma.decompress(open(sys.argv[1],"rb").read()))', path]],
  ]
  for (const [cmd, args] of candidates) {
    try {
      const result = spawnSync(cmd, args, { timeout: 120_000, maxBuffer: 512 * 1024 * 1024 })
      if (result.status === 0 && result.stdout && result.stdout.length > 1_000_000) return result.stdout
    } catch { /* try the next one */ }
  }
  throw new Error(
    'Could not decompress frida-server (.xz). Install xz (brew install xz) or set SIDEGLASS_FRIDA_SERVER to a frida-server binary.',
  )
}
