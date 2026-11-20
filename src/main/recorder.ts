import type { ChildProcess } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Adb } from './adb'

/** The emulator records up to 4 hours; 30 minutes keeps a forgotten recording from filling the disk. */
export const EMULATOR_LIMIT_S = 30 * 60
/** `screenrecord` on a phone stops itself at 3 minutes on most Android versions. */
export const DEVICE_LIMIT_S = 180
const DEVICE_FILE = '/sdcard/sideglass-recording.mp4'

export interface RecordingState {
  recording: boolean
  /** When the current recording started (ms since epoch), or null. */
  startedAt: number | null
  /** The recording stops by itself after this many seconds. */
  limitS: number
  extension: 'webm' | 'mp4'
}

/**
 * The emulator console answers `KO: reason` on failure and still exits 0, so the reply has
 * to be read. Returns the reason, or null when the command worked.
 */
export function consoleError(reply: string): string | null {
  const line = reply
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('KO'))
  if (!line) return null
  return line.replace(/^KO:?\s*/, '') || 'the emulator refused the command'
}

/** A file name for a saved recording, local time, safe on every OS. */
export function recordingName(at: Date, extension: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`
  return `Sideglass ${stamp}.${extension}`
}

/**
 * Records the phone's screen to a video file.
 *
 * On an emulator the emulator itself records (`adb emu screenrecord`), straight to a .webm on
 * this computer. Like the emulator screenshot fallback it records the composed display, so
 * FLAG_SECURE screens (PIN pads, banking apps) are not blanked. On a USB phone Android's own
 * `screenrecord` writes an .mp4 on the phone, which is pulled when the recording stops.
 */
export class Recorder {
  private startedAt: number | null = null
  private file = ''
  private child: ChildProcess | null = null
  private childExit: Promise<void> | null = null
  private busy: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly adb: Adb,
    private readonly workDir = join(tmpdir(), `sideglass-recording-${process.pid}`),
  ) {}

  get emulator(): boolean {
    return this.adb.serial.startsWith('emulator-')
  }

  get state(): RecordingState {
    return {
      recording: this.startedAt !== null,
      startedAt: this.startedAt,
      limitS: this.emulator ? EMULATOR_LIMIT_S : DEVICE_LIMIT_S,
      extension: this.emulator ? 'webm' : 'mp4',
    }
  }

  /** One start or stop at a time, so a double click cannot start two recordings. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.busy.then(work, work)
    this.busy = next.catch(() => undefined)
    return next
  }

  start(): Promise<RecordingState> {
    return this.serial(async () => {
      if (this.startedAt !== null) return this.state
      await mkdir(this.workDir, { recursive: true })
      if (this.emulator) await this.startEmulator()
      else await this.startDevice()
      this.startedAt = Date.now()
      return this.state
    })
  }

  /** Stop and return the path of the finished video on this computer. The caller owns the file. */
  stop(): Promise<string> {
    return this.serial(async () => {
      if (this.startedAt === null) throw new Error('Nothing is being recorded')
      this.startedAt = null
      const file = this.file
      this.file = ''
      if (this.emulator) await this.stopEmulator(file)
      else await this.stopDevice(file)
      return file
    })
  }

  /** Stop without keeping anything (the session is closing). */
  async discard(): Promise<void> {
    if (this.startedAt === null) return
    const file = await this.stop().catch(() => '')
    if (file) await rm(file, { force: true }).catch(() => undefined)
  }

  private async startEmulator(): Promise<void> {
    // The console splits its arguments on spaces, and a relative name lands in the emulator's own folder.
    if (/\s/.test(this.workDir)) throw new Error('the recording folder must not contain spaces')
    const file = join(this.workDir, `recording-${Date.now()}.webm`)
    let reply = await this.adb.exec(['emu', 'screenrecord', 'start', '--time-limit', String(EMULATOR_LIMIT_S), file], 15_000)
    // A recording left running (an earlier crash, or another tool) blocks a new one. Take it over.
    if (/already started/i.test(consoleError(reply) ?? '')) {
      await this.adb.exec(['emu', 'screenrecord', 'stop'], 15_000).catch(() => '')
      reply = await this.adb.exec(['emu', 'screenrecord', 'start', '--time-limit', String(EMULATOR_LIMIT_S), file], 15_000)
    }
    const error = consoleError(reply)
    if (error) throw new Error(`The emulator did not start recording: ${error}`)
    this.file = file
  }

  private async stopEmulator(file: string): Promise<void> {
    // "already stopped" (the time limit passed) is not an error: the file is still there.
    const reply = await this.adb.exec(['emu', 'screenrecord', 'stop'], 30_000)
    const error = consoleError(reply)
    if (error) throw new Error(`The emulator did not stop recording: ${error}`)
    await settled(file)
  }

  private async startDevice(): Promise<void> {
    await this.adb.shell(`rm -f ${DEVICE_FILE}`).catch(() => undefined)
    const child = this.adb.spawn(['shell', 'screenrecord', '--time-limit', String(DEVICE_LIMIT_S), DEVICE_FILE])
    let output = ''
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()))
    const exit = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    })
    // screenrecord fails at once when it cannot start (no permission, encoder busy).
    const early = await Promise.race([exit.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 800))])
    if (early) throw new Error(`The phone did not start recording${output.trim() ? `: ${output.trim()}` : ''}`)
    this.child = child
    this.childExit = exit
    this.file = join(this.workDir, `recording-${Date.now()}.mp4`)
  }

  private async stopDevice(file: string): Promise<void> {
    const exit = this.childExit
    this.child = null
    this.childExit = null
    // SIGINT makes screenrecord finish the file; killing adb on this side would leave it unplayable.
    await this.adb.shell('pkill -INT screenrecord || killall -INT screenrecord', 10_000).catch(() => undefined)
    await Promise.race([exit, new Promise((r) => setTimeout(r, 10_000))])
    await this.adb.exec(['pull', DEVICE_FILE, file], 120_000)
    await this.adb.shell(`rm -f ${DEVICE_FILE}`).catch(() => undefined)
    await settled(file)
  }
}

/** Wait until the file exists, is not empty, and has stopped growing. */
async function settled(file: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = -1
  while (Date.now() < deadline) {
    const size = await stat(file).then(
      (s) => s.size,
      () => -1,
    )
    if (size > 0 && size === last) return
    last = size
    await new Promise((r) => setTimeout(r, 300))
  }
  if (last <= 0) throw new Error('The recording came out empty')
}
