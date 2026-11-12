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
 * Runs frida-server on the capture phone and starts apps through it, so the agent
 * in agent.ts is loaded before the app's first line of code runs. Set up lazily on
 * the first launch; every failure degrades to a normal app launch.
 */
export class Hooks {
  enabled = true
  ready = false
  message = ''

  /** System Node. Electron cannot load the frida prebuild (different ABI). */
  private host: HookHost | null = null
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

  /** Start `pkg` suspended, inject the agent, then let it run. Returns its pid. */
  async launch(pkg: string): Promise<number> {
    await this.ensureServer()
    const adb = this.getAdb()
    await adb.shell(`am force-stop ${pkg}`)
    const host = this.host ?? (this.host = new HookHost((line) => this.say(line)))
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
      this.host ??= new HookHost((line) => this.say(line))
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

  constructor(private readonly log: (line: string) => void) {}

  ping(): Promise<void> {
    return this.request({ cmd: 'ping' }, 30_000).then(() => undefined)
  }

  async spawn(pkg: string, source: string): Promise<number> {
    const reply = await this.request({ cmd: 'spawn', pkg, source, port: SERVER_PORT }, INJECT_TIMEOUT_MS)
    if (!reply.pid) throw new Error('Frida did not return a process id')
    return reply.pid
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
        const parsed = JSON.parse(text) as { sg?: string; pkg?: string; message?: { type?: string; payload?: { sg?: string; text?: string }; description?: string } }
        if (parsed.sg === 'script') {
          const msg = parsed.message
          if (msg?.type === 'send' && msg.payload?.sg === 'log') this.log(`${parsed.pkg}: ${msg.payload.text}`)
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
