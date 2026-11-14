import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Adb } from './adb'
import { AGENT_SOURCE } from './agent'
import { fridaArch, fridaServerBinary } from './frida'

/** Non-standard port, so apps that scan for Frida's default port 27042 find nothing. */
const SERVER_PORT = 27091
const DEVICE_BIN = '/data/local/tmp/.sgsys'

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
 * `null` when the flag has never been set, which on current Android means the pool is
 * off. Only an explicit `true` or a live usap process needs the zygote restart: the
 * restart takes system_server down with it.
 */
export function usapRestartNeeded(configValue: string, processNames: readonly string[]): boolean {
  if (configValue.trim() === 'true') return true
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
  // Play services syncs device_config from the server and would turn the pool back on.
  await adb.su('device_config set_sync_disabled_for_tests persistent').catch(() => '')
  await adb.su('device_config put runtime_native usap_pool_enabled false')
  await adb.su('device_config put runtime_native usap_pool_size_max 0')
  const previous = pidOfName(before, 'zygote64') || pidOfName(before, 'zygote')
  await adb.su('setprop ctl.restart zygote')
  await waitForFreshZygote(adb, previous)
  return true
}

/**
 * True once the restarted runtime is usable: user 0 unlocked and System UI running.
 * `sys.boot_completed` is no use here: a zygote restart never resets it, so it reads 1
 * while system_server is still starting. Attaching Frida to zygote in that window left
 * zygote stopped and the phone on a black screen.
 */
export function runtimeSettled(userDump: string, table: string): boolean {
  const state = /State:\s*(\S+)/.exec(userDump)?.[1] ?? ''
  return state === 'RUNNING_UNLOCKED' && namesFromPs(table).includes('com.android.systemui')
}

/** Kernel run state from `/proc/<pid>/status`: `T`/`t` mean stopped or held by a tracer. */
export function processStopped(status: string): boolean {
  const state = /^State:\s*(\S)/m.exec(status)?.[1] ?? ''
  return state === 'T' || state === 't'
}

async function waitForFreshZygote(adb: Adb, previousPid: string): Promise<void> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    const table = await adb.su('ps -A -o PID,NAME').catch(() => '')
    const pid = pidOfName(table, 'zygote64') || pidOfName(table, 'zygote')
    const names = namesFromPs(table)
    if (!pid || pid === previousPid || names.includes('usap64') || names.includes('usap')) continue
    const users = await adb.shell('dumpsys user 2>/dev/null | grep -m1 "State:"').catch(() => '')
    if (runtimeSettled(users, table)) return
  }
  throw new Error('the phone runtime did not come back without its pre-started app pool')
}

/** Resolve once the phone runtime is usable again after system_server restarted on its own. */
export async function waitForSettledRuntime(adb: Adb, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const table = await adb.su('ps -A -o PID,NAME').catch(() => '')
    const users = await adb.shell('dumpsys user 2>/dev/null | grep -m1 "State:"').catch(() => '')
    if (runtimeSettled(users, table)) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('the phone runtime did not come back')
}

/** Read zygote's run state a few times. A healthy zygote sleeps; a stuck injection leaves it stopped. */
async function zygoteStuck(adb: Adb): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const status = await adb
      .su('cat /proc/$(pidof zygote64 || pidof zygote)/status 2>/dev/null')
      .catch(() => '')
    if (!processStopped(status)) return false
  }
  return true
}

/** pid of the hooks frida-server on the phone, or '' when it is not running. */
async function serverPid(adb: Adb): Promise<string> {
  return (await adb.su('pidof .sgsys').catch(() => '')).trim()
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 300))
  }
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
    // Every app on the phone forks from zygote. If the attach left it stopped, nothing can
    // open and the screen stays black, so back out rather than report hooks as on.
    const adb = this.getAdb()
    if (await zygoteStuck(adb)) {
      await host.ungate().catch(() => undefined)
      if (await zygoteStuck(adb)) {
        // Killing frida-server releases its hold on zygote.
        await this.stop()
        await adb.su('kill $(pidof .sgsys) 2>/dev/null; true').catch(() => undefined)
      }
      throw new Error('attaching to the phone runtime froze it, so hooks were switched back off. Try turning them on again')
    }
    this.gating = true
    this.message = 'Hooks are on for every app. Tap its icon on the phone. If it is already open, close it once so it starts fresh.'
    this.say(this.message)
    this.announce()
  }

  /**
   * The phone runtime restarted (system_server and zygote died), so the zygote sessions are
   * gone. Forget them so the next arm attaches to the new zygote instead of returning early.
   */
  async runtimeRestarted(): Promise<void> {
    if (!this.gating) return
    this.gating = false
    await this.host?.ungate().catch(() => undefined)
    this.message = 'The phone runtime restarted; turning hooks on again...'
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
    if (this.serverReady) {
      // Leave nothing behind on the phone: the server runs as root, and the forward holds a port.
      try {
        const adb = this.getAdb()
        await adb.su('kill $(pidof .sgsys) 2>/dev/null; true').catch(() => undefined)
        await adb.exec(['forward', '--remove', `tcp:${SERVER_PORT}`]).catch(() => undefined)
      } catch {
        // No phone any more.
      }
    }
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

      // Restarting is idempotent, but only once the old server has let go of the port.
      // Play images have no adb root. Magisk su starts the server so it can inject other apps.
      await adb.su('kill $(pidof .sgsys) 2>/dev/null; true').catch(() => undefined)
      if (!(await waitFor(async () => !(await serverPid(adb)), 5_000))) throw new Error('the previous frida-server would not stop')
      await adb.execBuffer(['push', local, DEVICE_BIN], 120_000)
      await adb.shell(`chmod 700 ${DEVICE_BIN}`)
      await adb
        .su(`nohup ${DEVICE_BIN} -l 127.0.0.1:${SERVER_PORT} >/dev/null 2>&1 &`, 15_000)
        .catch(() => undefined)
      if (!(await waitFor(async () => Boolean(await serverPid(adb)), 10_000))) throw new Error('frida-server did not start on the phone')
      await adb.exec(['forward', `tcp:${SERVER_PORT}`, `tcp:${SERVER_PORT}`])
      this.host ??= this.newHost()
      // A real round trip: the adb forward accepts connections even with nothing behind it.
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


  /** Local frida-server binary for this machine's emulator ABI, downloaded once and checked. */
  private async ensureLocalBinary(): Promise<string> {
    const override = process.env.SIDEGLASS_FRIDA_SERVER
    if (override && existsSync(override)) return override
    const arch = fridaArch(this.abi)
    if (!arch) throw new Error(`No frida-server build for CPU ${this.abi}`)
    return fridaServerBinary(this.cacheDir, arch, (line) => this.say(line))
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

  /** Connects to frida-server on the phone and lists its processes. */
  ping(): Promise<void> {
    return this.request({ cmd: 'ping', port: SERVER_PORT }, 30_000).then(() => undefined)
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
    const child = this.child
    child.kill()
    // A host stuck inside a native frida call can outlive SIGTERM; never leave one behind.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 3_000).unref()
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
          message?: { type?: string; payload?: { sg?: string; level?: string; text?: string; pkg?: string; pid?: number }; description?: string }
        }
        if (parsed.sg === 'script') {
          const msg = parsed.message
          if (msg?.type === 'send' && msg.payload?.sg === 'hooked' && msg.payload.pkg && msg.payload.pid) {
            this.onHooked(msg.payload.pkg, msg.payload.pid)
          } else if (msg?.type === 'send' && msg.payload?.sg === 'log') {
            // One debug line per hook per app ("… ok"). Shown in the window they replaced the
            // status line many times a second and made the phone view flicker.
            if (msg.payload.level !== 'debug') this.log(`${parsed.pkg}: ${msg.payload.text}`)
          } else if (msg?.type === 'error') this.log(`${parsed.pkg}: hook error: ${msg.description ?? 'unknown'}`)
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

