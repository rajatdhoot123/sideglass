import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { Adb } from './adb'

/** Host library and device server must be the same release. */
export const FRIDA_VERSION = '17.26.2'

const SERVER_PATH = '/data/local/tmp/frida-server'

export function fridaArch(abi: string): string | null {
  switch (abi.trim()) {
    case 'arm64-v8a':
      return 'android-arm64'
    case 'armeabi-v7a':
      return 'android-arm'
    case 'x86_64':
      return 'android-x86_64'
    case 'x86':
      return 'android-x86'
    default:
      return null
  }
}

export function serverAsset(arch: string): string {
  return `frida-server-${FRIDA_VERSION}-${arch}`
}

export function serverUrl(arch: string): string {
  return `https://github.com/frida/frida/releases/download/${FRIDA_VERSION}/${serverAsset(arch)}.xz`
}

export function isElf(bytes: Uint8Array): boolean {
  return bytes.length > 1024 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
}

export function isXz(bytes: Uint8Array): boolean {
  return bytes.length > 6 && bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a && bytes[3] === 0x58 && bytes[4] === 0x5a && bytes[5] === 0x00
}

/** xz via Python. macOS and Linux have python3; the Frida release files are xz-compressed. */
export function decompressXz(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', 'import lzma,sys; sys.stdout.buffer.write(lzma.decompress(sys.stdin.buffer.read()))'])
    const chunks: Buffer[] = []
    let error = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error.trim() || `xz decode failed (${code})`))))
    child.stdin.write(bytes)
    child.stdin.end()
  })
}

export function projectRoot(): string {
  const candidates = [process.env.SIDEGLASS_ROOT, process.cwd(), join(__dirname, '../..')]
  if (process.resourcesPath) candidates.push(process.resourcesPath, join(process.resourcesPath, 'sideglass'))
  for (const root of candidates) {
    if (root && existsSync(join(root, 'scripts', 'frida-host.mjs'))) return root
  }
  return process.cwd()
}

async function serverBinary(cacheDir: string, arch: string): Promise<string> {
  await mkdir(cacheDir, { recursive: true })
  const path = join(cacheDir, serverAsset(arch))
  try {
    const existing = await readFile(path)
    if (isElf(existing)) return path
  } catch {
    // Download it.
  }
  const response = await fetch(serverUrl(arch), { signal: AbortSignal.timeout(120_000), headers: { 'user-agent': 'sideglass' } })
  if (!response.ok) throw new Error(`could not download frida-server (${response.status})`)
  const compressed = Buffer.from(await response.arrayBuffer())
  if (!isXz(compressed)) throw new Error('downloaded frida-server is not an xz file')
  const binary = await decompressXz(compressed)
  if (!isElf(binary)) throw new Error('downloaded frida-server is not an ELF binary')
  await writeFile(path, binary, { mode: 0o755 })
  return path
}

interface HostReply {
  id: number
  ok: boolean
  error?: string
  pid?: number
  nativeHooks?: number
  notes?: string[]
}

/** One system-Node process that owns the frida device sessions. */
class FridaHost {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (reply: HostReply) => void; reject: (error: Error) => void }>()
  private stderrTail = ''
  private buffer = ''

  constructor(
    private readonly root: string,
    private readonly log: (line: string) => void,
    private readonly adbDir?: string,
  ) {}

  async ping(): Promise<void> {
    await this.request({ cmd: 'ping' }, 60_000)
  }

  async spawn(serial: string, pkg: string): Promise<{ pid: number; nativeHooks: number }> {
    const reply = await this.request({ cmd: 'spawn', serial, pkg }, 60_000)
    if (!reply.pid) throw new Error('Frida did not return a process id')
    if (reply.notes?.length) this.log(reply.notes.slice(-4).join('\n'))
    return { pid: reply.pid, nativeHooks: reply.nativeHooks ?? 0 }
  }

  async stop(): Promise<void> {
    if (!this.child) return
    await this.request({ cmd: 'stop' }, 5_000).catch(() => undefined)
    this.child.kill()
    this.child = null
    for (const waiter of this.pending.values()) waiter.reject(new Error('Frida host stopped'))
    this.pending.clear()
  }

  private request(body: Record<string, unknown>, timeoutMs: number): Promise<HostReply> {
    const child = this.ensure()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Frida host did not answer ${body.cmd} in ${timeoutMs / 1000}s. ${this.stderrTail}`.trim()))
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
    const node = process.env.SIDEGLASS_NODE || 'node'
    const script = join(this.root, 'scripts', 'frida-host.mjs')
    const nodePath = [join(this.root, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(delimiter)
    const path = [this.adbDir, process.env.PATH].filter(Boolean).join(delimiter)
    const child = spawn(node, [script], {
      cwd: this.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_PATH: nodePath, PATH: path },
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (!text) return
      this.stderrTail = `${this.stderrTail}\n${text}`.slice(-2000)
      this.log(text)
    })
    child.on('error', (error) => this.failAll(error))
    child.on('exit', (code) => {
      this.child = null
      this.failAll(new Error(`Frida host exited ${code ?? 'unknown'}. ${this.stderrTail}`.trim()))
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
      else waiter.reject(new Error(reply.error || 'Frida host failed'))
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }
}

/**
 * frida-server on the rooted phone, plus a host process that spawns an app
 * with the unpinning script already loaded.
 */
export class DeviceFrida {
  private host: FridaHost | null = null
  private serverReady = false
  private root: ((command: string, timeoutMs?: number) => Promise<string>) | null = null

  constructor(
    private readonly adb: Adb,
    private readonly cacheDir: string,
    private readonly log: (line: string) => void,
  ) {}

  async start(): Promise<void> {
    const root = await this.adb.asRoot()
    if (!root) throw new Error('Frida needs root on the phone')
    this.root = root
    const abi = (await this.adb.shell('getprop ro.product.cpu.abi')).trim()
    const arch = fridaArch(abi)
    if (!arch) throw new Error(`No frida-server build for CPU ${abi || 'unknown'}`)
    const binary = await serverBinary(this.cacheDir, arch)
    await this.adb.exec(['push', binary, SERVER_PATH], 120_000)
    await root(`chmod 755 ${SERVER_PATH}`)
    const running = (await root('pidof frida-server').catch(() => '')).trim()
    if (running) {
      // The process keeps the old binary after the file is replaced. Start the one just pushed.
      await root(`kill ${running.split(/\s+/).filter((pid) => /^\d+$/.test(pid)).join(' ')}`).catch(() => undefined)
    }
    await this.launchServer()
    const version = (await this.adb.shell(`${SERVER_PATH} --version`).catch(() => '')).trim()
    this.serverReady = true
    this.host ??= new FridaHost(projectRoot(), this.log, dirname(this.adb.adbPath))
    await this.host.ping()
    this.log(`Frida ${version || FRIDA_VERSION} is running on ${this.adb.serial}.`)
  }

  /** Spawn the app suspended, load the unpinning script, then resume it. */
  async spawn(pkg: string): Promise<{ pid: number; nativeHooks: number }> {
    if (!this.serverReady || !this.host) await this.start()
    return this.host!.spawn(this.adb.serial, pkg)
  }

  async stop(): Promise<void> {
    await this.host?.stop()
    this.host = null
    this.serverReady = false
    const root = this.root ?? (await this.adb.asRoot().catch(() => null))
    if (!root) return
    const pids = (await root('pidof frida-server').catch(() => '')).trim()
    if (pids) await root(`kill ${pids.split(/\s+/).filter((pid) => /^\d+$/.test(pid)).join(' ')}`).catch(() => undefined)
  }

  /** `-D` daemonizes. If adb still holds the shell, the pid check is what matters. */
  private async launchServer(): Promise<void> {
    const root = this.root!
    if ((await this.adb.shell('id -u').catch(() => '')).trim() !== '0') {
      // Magisk phone: only su is root, so start the server through it.
      await root(`nohup ${SERVER_PATH} -D >/dev/null 2>&1 &`, 15_000).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 2_000))
      if (!(await root('pidof frida-server').catch(() => '')).trim()) throw new Error('frida-server did not stay running')
      return
    }
    const child = this.adb.spawn(['shell', SERVER_PATH, '-D'])
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 4_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    child.kill()
    const pid = (await this.adb.shell('pidof frida-server').catch(() => '')).trim()
    if (!pid) throw new Error('frida-server did not stay running')
  }
}
