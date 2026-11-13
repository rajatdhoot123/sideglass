import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
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
  /** True only while frida-server is being pushed and started, not merely because it is not ready yet. */
  starting: boolean
  message: string
}

export interface HooksEvents {
  log: (line: string) => void
  state: (snapshot: HooksSnapshot) => void
}

const INJECT_TIMEOUT_MS = 20_000

/**
 * True when the phone pre-forks app processes. Those forks happen before the user
 * taps an icon, so a later tap never passes through Frida. `device_config get` prints
 * `null` when the flag has never been set.
 */
export function usapRestartNeeded(configValue: string, processNames: readonly string[]): boolean {
  if (configValue.trim() !== 'false') return true
  return processNames.some((name) => name === 'usap' || name === 'usap64')
}

/** `ps -A -o PID,NAME` rows. The header and blank lines are dropped. */
export function namesFromPs(table: string): string[] {
  const names: string[] = []
  for (const line of table.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && /^\d+$/.test(parts[0])) names.push(parts[1])
  }
  return names
}

export function pidOfName(table: string, name: string): string {
  for (const line of table.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && parts[1] === name && /^\d+$/.test(parts[0])) return parts[0]
  }
  return ''
}

/**
 * Turn off Android's pre-forked app pool and restart zygote when it is still on,
 * so the next icon tap is a fresh fork Frida can pause. Returns true when zygote
 * was restarted. The caller reinstalls the system CA afterwards: a new zygote does
 * not keep the previous one's certificate mount.
 */
export async function ensureDirectAppStarts(adb: Adb, log: (line: string) => void): Promise<boolean> {
  const config = (await adb.su('device_config get runtime_native usap_pool_enabled').catch(() => '')).trim()
  const before = await adb.su('ps -A -o PID,NAME').catch(() => '')
  if (!usapRestartNeeded(config, namesFromPs(before))) return false
  log('Restarting the phone runtime so an app opened from its icon can be hooked...')
  await adb.su('device_config put runtime_native usap_pool_enabled false')
  await adb.su('device_config put runtime_native usap_pool_size_max 0')
  const previous = pidOfName(before, 'zygote64') || pidOfName(before, 'zygote')
  await adb.su('setprop ctl.restart zygote')
  await waitForFreshZygote(adb, previous)
  return true
}

async function waitForFreshZygote(adb: Adb, previousPid: string): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    const table = await adb.su('ps -A -o PID,NAME').catch(() => '')
    const pid = pidOfName(table, 'zygote64') || pidOfName(table, 'zygote')
    const names = namesFromPs(table)
    const boot = (await adb.shell('getprop sys.boot_completed').catch(() => '')).trim()
    if (boot === '1' && pid && pid !== previousPid && !names.includes('usap64') && !names.includes('usap')) return
  }
  throw new Error('the phone runtime did not come back without its pre-started app pool')
}

/**
 * Runs frida-server on the capture phone and loads agent.ts into every new app
 * process. Icon taps fork zygote, so the agent is attached there, not only when
 * the launch list spawns one package. Every failure degrades to a normal launch.
 */
export class Hooks {
  enabled = true
  ready = false
  /** True once zygote is gated. A normal `am start` is then hooked too. */
  gating = false
  message = ''

  /** System Node. Electron cannot load the frida prebuild (different ABI). */
  private host: HookHost | null = null
  private arming: Promise<void> | null = null
  /** Last process each package was hooked in, from the agent's own report. */
  private readonly hooked = new Map<string, { pid: number; at: number }>()
  private starting = false
  private serverReady = false

  constructor(
    private readonly getAdb: () => Adb,
    private readonly abi: string,
    private readonly cacheDir: string,
    private readonly events: HooksEvents,
  ) {}

  snapshot(): HooksSnapshot {
    return { enabled: this.enabled, ready: this.ready, starting: this.starting, message: this.message }
  }

  private say(line: string): void {
    this.events.log(line)
  }

  private announce(): void {
    this.events.state(this.snapshot())
  }

  /**
   * Attach to zygote so the next app process, however it is opened, loads the agent.
   * Safe to call more than once.
   */
  arm(): Promise<void> {
    if (!this.enabled || this.gating) return Promise.resolve()
    // Overlapping calls would restart frida-server under each other.
    this.arming ??= this.doArm().finally(() => {
      this.arming = null
    })
    return this.arming
  }

  /** The pid `pkg` was hooked in at or after `since` (ms), or null. */
  hookedSince(pkg: string, since: number): number | null {
    const hit = this.hooked.get(pkg)
    return hit && hit.at >= since ? hit.pid : null
  }

  private newHost(): HookHost {
    return new HookHost(
      (line) => this.say(line),
      (pkg, pid) => this.hooked.set(pkg, { pid, at: Date.now() }),
    )
  }

  private async doArm(): Promise<void> {
    await this.ensureServer()
    // Turned off while frida-server was still starting.
    if (!this.enabled || this.gating) return
    const host = this.host
    if (!host) throw new Error('Hook host did not start')
    await host.gate(AGENT_SOURCE)
    if (!this.enabled) {
      await host.ungate().catch(() => undefined)
      return
    }
    this.gating = true
    this.message = 'Hooks are on for every app. Tap its icon on the phone. If it is already open, close it once so it starts fresh.'
    this.say(this.message)
    this.announce()
  }

  /** Stop intercepting new processes. Apps already hooked stay hooked until they restart. */
  async disarm(): Promise<void> {
    this.gating = false
    await this.host?.ungate().catch(() => undefined)
    this.message = 'Hooks are off. Apps open normally.'
    this.say(this.message)
    this.announce()
  }

  /** Start `pkg` suspended, inject the agent, then let it run. Returns its pid. */
  async launch(pkg: string): Promise<number> {
    // Gating already injects on the way out of zygote. A second spawn would load the agent twice
    // and, on failure, tear down the host that is watching zygote.
    if (this.gating) throw new Error('App starts are already hooked from the phone')
    await this.ensureServer()
    const adb = this.getAdb()
    await adb.shell(`am force-stop ${pkg}`)
    const host = this.host ?? (this.host = this.newHost())
    try {
      const pid = await withTimeout(host.spawn(pkg, AGENT_SOURCE), INJECT_TIMEOUT_MS, 'Hook injection')
      return pid
    } catch (error) {
      // A host that accepted the port and then stalled keeps a dead frida handle.
      await host.stop().catch(() => undefined)
      this.host = null
      this.serverReady = false
      this.ready = false
      this.announce()
      await adb.shell(`am force-stop ${pkg}`).catch(() => undefined)
      throw error
    }
  }

  async stop(): Promise<void> {
    this.gating = false
    await this.host?.stop().catch(() => undefined)
    this.host = null
    this.serverReady = false
    this.ready = false
    this.starting = false
    this.message = ''
    this.announce()
  }

  /** Push frida-server if needed and forward its port. The frida client runs in HookHost. */
  private async ensureServer(): Promise<void> {
    if (this.serverReady && this.host) return
    this.starting = true
    this.message = ''
    this.announce()
    try {
      const adb = this.getAdb()
      const local = await this.ensureLocalBinary()
      this.say('Starting launch hooks (frida-server)...')

      // Restarting is idempotent: a stale server would refuse the port.
      // Play images have no adb root. Magisk su starts the server so it can inject other apps.
      await adb.su('kill $(pidof .sgsys) 2>/dev/null; true').catch(() => undefined)
      await adb.execBuffer(['push', local, DEVICE_BIN], 120_000)
      await adb.shell(`chmod 700 ${DEVICE_BIN}`)
      await adb
        .su(`nohup ${DEVICE_BIN} -l 127.0.0.1:${SERVER_PORT} >/dev/null 2>&1 &`, 15_000)
        .catch(() => undefined)
      await adb.exec(['forward', `tcp:${SERVER_PORT}`, `tcp:${SERVER_PORT}`])
      await this.waitPort()
      this.host ??= this.newHost()
      await this.host.ping()
      this.serverReady = true
      this.ready = true
      this.message = ''
      this.say('Launch hooks ready')
    } catch (error) {
      await this.host?.stop().catch(() => undefined)
      this.host = null
      this.serverReady = false
      this.ready = false
      this.message = (error as Error).message
      throw error
    } finally {
      this.starting = false
      this.announce()
    }
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

interface HostReply {
  id: number
  ok: boolean
  error?: string
  pid?: number
}

/** One system-Node process. It owns the frida device session so Electron never loads the native module. */
class HookHost {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (reply: HostReply) => void; reject: (error: Error) => void }>()
  private buffer = ''
  private stderrTail = ''

  constructor(
    private readonly log: (line: string) => void,
    private readonly onHooked: (pkg: string, pid: number) => void,
  ) {}

  ping(): Promise<void> {
    return this.request({ cmd: 'ping' }, 30_000).then(() => undefined)
  }

  async spawn(pkg: string, source: string): Promise<number> {
    const reply = await this.request({ cmd: 'spawn', pkg, source, port: SERVER_PORT }, INJECT_TIMEOUT_MS)
    if (!reply.pid) throw new Error('Frida did not return a process id')
    return reply.pid
  }

  gate(source: string): Promise<void> {
    return this.request({ cmd: 'gate', source, port: SERVER_PORT }, 60_000).then(() => undefined)
  }

  ungate(): Promise<void> {
    return this.request({ cmd: 'ungate' }, 15_000).then(() => undefined)
  }

  async stop(): Promise<void> {
    if (!this.child) return
    await this.request({ cmd: 'stop' }, 5_000).catch(() => undefined)
    this.child.kill()
    this.child = null
    for (const waiter of this.pending.values()) waiter.reject(new Error('Hook host stopped'))
    this.pending.clear()
  }

  private request(body: Record<string, unknown>, timeoutMs: number): Promise<HostReply> {
    const child = this.ensure()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Hook host did not answer ${String(body.cmd)} in ${timeoutMs / 1000}s. ${this.stderrTail}`.trim()))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer)
          resolve(reply)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      child.stdin?.write(`${JSON.stringify({ id, ...body })}\n`)
    })
  }

  private ensure(): ChildProcess {
    if (this.child) return this.child
    const script = hostScript()
    const node = process.env.SIDEGLASS_NODE || 'node'
    const child = spawn(node, [script], {
      cwd: join(dirname(script), '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => this.onStderr(chunk))
    child.on('error', (error) => this.failAll(error))
    child.on('exit', (code) => {
      this.child = null
      this.failAll(new Error(`Hook host exited ${code ?? 'unknown'}. ${this.stderrTail}`.trim()))
    })
    return child
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end < 0) return
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      let reply: HostReply
      try {
        reply = JSON.parse(line) as HostReply
      } catch {
        this.log(line)
        continue
      }
      const waiter = this.pending.get(reply.id)
      if (!waiter) continue
      this.pending.delete(reply.id)
      if (reply.ok) waiter.resolve(reply)
      else waiter.reject(new Error(reply.error || 'Hook host failed'))
    }
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split('\n')) {
      const text = line.trim()
      if (!text) continue
      this.stderrTail = `${this.stderrTail}\n${text}`.slice(-2000)
      try {
        const parsed = JSON.parse(text) as {
          sg?: string
          pkg?: string
          message?: { type?: string; payload?: { sg?: string; text?: string; pkg?: string; pid?: number }; description?: string }
        }
        if (parsed.sg === 'script') {
          const msg = parsed.message
          if (msg?.type === 'send' && msg.payload?.sg === 'hooked' && msg.payload.pkg && msg.payload.pid) {
            this.onHooked(msg.payload.pkg, msg.payload.pid)
          } else if (msg?.type === 'send' && msg.payload?.sg === 'log') this.log(`${parsed.pkg}: ${msg.payload.text}`)
          else if (msg?.type === 'error') this.log(`${parsed.pkg}: hook error: ${msg.description ?? 'unknown'}`)
          continue
        }
      } catch {
        // Ordinary stderr from the host.
      }
      this.log(text)
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }
}

/** scripts/hooks-host.mjs, next to the app when running from a checkout. */
function hostScript(): string {
  const candidates = [join(process.cwd(), 'scripts', 'hooks-host.mjs'), join(__dirname, '../../scripts/hooks-host.mjs')]
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'sideglass', 'hooks-host.mjs'))
    candidates.push(join(process.resourcesPath, 'scripts', 'hooks-host.mjs'))
  }
  const found = candidates.find((path) => existsSync(path))
  if (!found) throw new Error('Launch hooks host is missing (scripts/hooks-host.mjs)')
  return found
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    timer.unref()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
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
