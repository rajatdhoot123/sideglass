import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { AdbServerClient, type Adb as TangoAdb } from '@yume-chan/adb'
import { AdbScrcpyClient, AdbScrcpyExitedError, AdbScrcpyOptions3_3_3 } from '@yume-chan/adb-scrcpy'
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp'
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  DefaultServerPath,
  ScrcpyInstanceId,
  ScrcpyPointerId,
  type AndroidKeyEventMeta,
} from '@yume-chan/scrcpy'
import { PushReadableStream } from '@yume-chan/stream-extra'
import type { KeyEvent, ScreenMode, VideoPacket } from '../shared'
import type { Adb } from './adb'
import { androidKeyCode, isTypingKey, metaState } from './keys'
import { Screen } from './screen'

/**
 * scrcpy server 3.3.3 matches `AdbScrcpyOptions3_3_3` from `@yume-chan/scrcpy` 2.3.0.
 * The binary is Apache-2.0 and is downloaded on first use, not bundled.
 */
const SERVER_VERSION = '3.3.3'
const SERVER_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SERVER_VERSION}/scrcpy-server-v${SERVER_VERSION}`

type VideoClient = AdbScrcpyClient<AdbScrcpyOptions3_3_3<true>>

/**
 * Live phone: an H.264 scrcpy stream when it can start, otherwise `screencap` frames.
 * Touch coordinates are fractions of the picture, the same as `Screen`.
 */
export class Mirror extends EventEmitter {
  readonly frames: Screen
  mode: ScreenMode = 'frames'
  private videoSize = { width: 0, height: 0 }
  private ticket = 0
  private closed = false
  private allowVideo = true
  private shotsPaused = false
  private video: { client: VideoClient; adb: TangoAdb } | null = null
  private controller: VideoClient['controller'] = undefined
  private readonly pointers = new Set<number>()
  private clip = 0

  constructor(
    private readonly adb: Adb,
    private readonly cacheDir: string,
    private readonly scid: number,
  ) {
    super()
    this.frames = new Screen(adb)
  }

  async start(): Promise<void> {
    this.frames.on('frame', (png: Buffer) => {
      if (this.mode === 'frames') this.emit('frame', png)
    })
    await this.frames.start()
    this.emit('mode', this.mode)
    const ticket = this.ticket
    void this.tryVideo(ticket)
  }

  stop(): void {
    this.closed = true
    this.ticket++
    this.frames.stop()
    this.dropVideo()
  }

  /** The renderer could not decode the stream, or the stream ended. Go back to screenshots. */
  useFrames(): void {
    this.allowVideo = false
    if (this.closed) return
    this.ticket++
    const idle = this.mode === 'frames' && !this.video && !this.shotsPaused
    if (idle) return
    this.mode = 'frames'
    this.dropVideo()
    this.emit('mode', 'frames')
    this.shotsPaused = false
    void this.frames.start()
  }

  /** Ask the server for a new configuration and keyframe. */
  refresh(): Promise<void> {
    return this.controller?.resetVideo() ?? Promise.resolve()
  }

  async tap(x: number, y: number): Promise<void> {
    if (!this.controller || this.mode !== 'video') {
      await this.frames.tap(x, y)
      return
    }
    await this.touch('down', -1, x, y)
    await this.touch('up', -1, x, y)
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void> {
    if (!this.controller || this.mode !== 'video') {
      await this.frames.swipe(x1, y1, x2, y2, ms)
      return
    }
    await this.touch('down', -1, x1, y1)
    await this.touch('move', -1, x2, y2)
    await new Promise((r) => setTimeout(r, Math.max(1, ms)))
    await this.touch('up', -1, x2, y2)
  }

  async key(code: 'BACK' | 'HOME' | 'APP_SWITCH' | 'POWER'): Promise<void> {
    const controller = this.mode === 'video' ? this.controller : undefined
    if (!controller) {
      await this.frames.key(code)
      return
    }
    try {
      if (code === 'BACK') {
        await controller.backOrScreenOn(AndroidKeyEventAction.Down)
        await controller.backOrScreenOn(AndroidKeyEventAction.Up)
        return
      }
      const keyCode =
        code === 'HOME' ? AndroidKeyCode.AndroidHome : code === 'APP_SWITCH' ? AndroidKeyCode.AndroidAppSwitch : AndroidKeyCode.Power
      await controller.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode, repeat: 0, metaState: 0 })
      await controller.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode, repeat: 0, metaState: 0 })
    } catch {
      await this.frames.key(code)
    }
  }

  async text(value: string): Promise<void> {
    if (!value) return
    const controller = this.mode === 'video' ? this.controller : undefined
    if (!controller) {
      await this.frames.text(value)
      return
    }
    // injectText only covers printable ASCII. Anything else is pasted from the clipboard.
    if (/^[\x20-\x7e]+$/.test(value)) {
      await controller.injectText(value)
      return
    }
    await controller.setClipboard({ sequence: BigInt(++this.clip), paste: true, content: value })
  }

  /** `pointerId` is -1 for the mouse and 0, 1, 2… for extra fingers. */
  async touch(action: 'down' | 'move' | 'up' | 'cancel', pointerId: number, x: number, y: number): Promise<void> {
    const controller = this.controller
    const { width, height } = this.videoSize
    if (!controller || this.mode !== 'video' || width < 2 || height < 2) return
    let motion: AndroidMotionEventAction
    if (action === 'down') {
      motion = this.pointers.size === 0 ? AndroidMotionEventAction.Down : AndroidMotionEventAction.PointerDown
      this.pointers.add(pointerId)
    } else if (action === 'up') {
      const last = this.pointers.size <= 1
      this.pointers.delete(pointerId)
      motion = last ? AndroidMotionEventAction.Up : AndroidMotionEventAction.PointerUp
    } else if (action === 'cancel') {
      this.pointers.delete(pointerId)
      motion = AndroidMotionEventAction.Cancel
    } else {
      motion = AndroidMotionEventAction.Move
    }
    const pressed = action === 'down' || action === 'move'
    await controller.injectTouch({
      action: motion,
      pointerId: pointerId < 0 ? ScrcpyPointerId.Mouse : BigInt(pointerId),
      pointerX: clamp(Math.round(x * width), 0, width - 1),
      pointerY: clamp(Math.round(y * height), 0, height - 1),
      videoWidth: width,
      videoHeight: height,
      pressure: pressed ? 1 : 0,
      actionButton: action === 'move' ? AndroidMotionEventButton.None : AndroidMotionEventButton.Primary,
      buttons: pressed ? AndroidMotionEventButton.Primary : AndroidMotionEventButton.None,
    })
  }

  /**
   * `dx` and `dy` are browser wheel deltas in pixels (already scaled so 100px is one tick).
   * Negative `dy` on the device scrolls the content downward.
   */
  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    const controller = this.controller
    const { width, height } = this.videoSize
    if (!controller || this.mode !== 'video' || width < 2 || height < 2) return
    const scrollX = -dx / 100
    const scrollY = -dy / 100
    if (scrollX === 0 && scrollY === 0) return
    await controller.injectScroll({
      pointerX: clamp(Math.round(x * width), 0, width - 1),
      pointerY: clamp(Math.round(y * height), 0, height - 1),
      videoWidth: width,
      videoHeight: height,
      scrollX,
      scrollY,
      buttons: 0,
    })
  }

  async keyEvent(event: KeyEvent): Promise<void> {
    const controller = this.mode === 'video' ? this.controller : undefined
    if (!controller) return
    if (event.action === 'down' && isTypingKey(event.code, event.key, event)) {
      await controller.injectText(event.key)
      return
    }
    const keyCode = androidKeyCode(event.code)
    if (keyCode == null) return
    await controller.injectKeyCode({
      action: event.action === 'down' ? AndroidKeyEventAction.Down : AndroidKeyEventAction.Up,
      keyCode,
      repeat: event.repeat ? 1 : 0,
      metaState: metaState(event) as AndroidKeyEventMeta,
    })
  }

  private async tryVideo(ticket: number): Promise<void> {
    const held: { client?: VideoClient; adb?: TangoAdb } = {}
    let timer: ReturnType<typeof setTimeout> | undefined
    // Always attach a catch. A timeout settles the race while connect is still in flight.
    const pending = this.connect(ticket, held)
    pending.catch(() => undefined)
    try {
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), 25_000)
        }),
      ])
    } catch (error) {
      if (ticket === this.ticket) this.ticket++
      await held.client?.close().catch(() => undefined)
      await held.adb?.close().catch(() => undefined)
      if (this.video?.client === held.client) this.video = null
      this.controller = undefined
      if (!this.closed && this.allowVideo) {
        this.emit('log', `Video stream unavailable (${describe(error)}). Using screenshots.`)
        this.resumeShots()
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Resolves when the first picture is on its way. The read loop keeps running after that. */
  private async connect(ticket: number, held: { client?: VideoClient; adb?: TangoAdb }): Promise<void> {
    const bytes = await serverBytes(this.cacheDir)
    if (await this.abandoned(ticket, held)) return
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT || 5037)
    const server = new AdbServerClient(new AdbServerNodeTcpConnector({ host: '127.0.0.1', port }))
    const devices = await server.getDevices()
    const found = devices.find((device) => device.serial === this.adb.serial && device.state === 'device')
    if (!found) throw new Error(`adb has no device ${this.adb.serial}`)
    const adb = await server.createAdb({ serial: found.serial })
    held.adb = adb
    if (await this.abandoned(ticket, held)) return
    const file = new PushReadableStream<Uint8Array>(async (controller) => {
      await controller.enqueue(bytes)
    })
    await AdbScrcpyClient.pushServer(adb, file)
    if (await this.abandoned(ticket, held)) return
    const options = new AdbScrcpyOptions3_3_3({
      video: true,
      audio: false,
      control: true,
      maxSize: 1280,
      maxFps: 60,
      videoBitRate: 8_000_000,
      videoCodec: 'h264',
      tunnelForward: true,
      stayAwake: true,
      powerOn: true,
      clipboardAutosync: false,
      logLevel: 'warn',
      scid: new ScrcpyInstanceId(this.scid),
    })
    // screencap fights the encoder for the framebuffer. The last picture stays up until
    // the first video packet. resumeShots() brings screenshots back if the server fails.
    this.frames.stop()
    this.shotsPaused = true
    const client = await AdbScrcpyClient.start(adb, DefaultServerPath, options)
    held.client = client
    if (await this.abandoned(ticket, held)) return
    this.video = { client, adb }
    this.controller = client.controller
    void this.drain(client, ticket)
    const video = await client.videoStream
    if (!video) throw new Error('scrcpy returned no video stream')
    void client.exited.then(() => {
      if (!this.closed && ticket === this.ticket && this.mode === 'video') this.useFrames()
    })
    await this.readVideo(video, ticket)
  }

  /** Resolves on the first packet. Keeps reading until the stream ends or the mirror stops. */
  private readVideo(video: Awaited<NonNullable<VideoClient['videoStream']>>, ticket: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false
      const reader = video.stream.getReader()
      const finish = (error?: unknown) => {
        if (!opened) {
          opened = true
          if (error) reject(error)
          else resolve()
        } else if (error && ticket === this.ticket && this.mode === 'video') {
          this.emit('log', `Video stream ended (${describe(error)}). Using screenshots.`)
          this.useFrames()
        }
      }
      void (async () => {
        try {
          while (ticket === this.ticket) {
            const { done, value } = await reader.read()
            if (done) break
            const width = video.width || video.metadata.width || this.videoSize.width
            const height = video.height || video.metadata.height || this.videoSize.height
            if (width > 0 && height > 0) this.videoSize = { width, height }
            const data = new Uint8Array(value.data.byteLength)
            data.set(value.data)
            const packet: VideoPacket =
              value.type === 'configuration'
                ? { type: 'configuration', data, width, height }
                : {
                    type: 'data',
                    data,
                    keyframe: value.keyframe,
                    pts: value.pts == null ? undefined : Number(value.pts),
                    width,
                    height,
                  }
            this.emit('video', packet)
            if (this.mode !== 'video' && width > 0) {
              this.mode = 'video'
              this.frames.stop()
              this.emit('mode', 'video')
              this.emit('log', `Video stream ${width}×${height}`)
            }
            if (!opened) {
              opened = true
              resolve()
            }
          }
          if (!opened) finish(new Error('video stream ended before the first frame'))
          else if (ticket === this.ticket && !this.closed) finish(new Error('closed'))
        } catch (error) {
          finish(error)
        } finally {
          reader.releaseLock()
        }
      })()
    })
  }

  private async drain(client: VideoClient, ticket: number): Promise<void> {
    const reader = client.output.getReader()
    try {
      while (ticket === this.ticket) {
        const { done, value } = await reader.read()
        if (done) break
        const line = value.trim()
        if (line && /warn|error|exception|fatal/i.test(line)) this.emit('log', `scrcpy: ${line}`)
      }
    } catch {
      // The server log closes when the stream stops.
    }
  }

  private async abandoned(ticket: number, held: { client?: VideoClient; adb?: TangoAdb }): Promise<boolean> {
    if (ticket === this.ticket && !this.closed && this.allowVideo) return false
    await held.client?.close().catch(() => undefined)
    await held.adb?.close().catch(() => undefined)
    if (this.video?.client === held.client) this.video = null
    return true
  }

  private resumeShots(): void {
    if (!this.shotsPaused || this.closed) return
    this.shotsPaused = false
    void this.frames.start()
  }

  private dropVideo(): void {
    this.controller = undefined
    this.pointers.clear()
    const current = this.video
    this.video = null
    if (!current) return
    void current.client.close().catch(() => undefined)
    void current.adb.close().catch(() => undefined)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function describe(error: unknown): string {
  if (error instanceof AdbScrcpyExitedError) {
    const tail = error.output.map((line) => line.trim()).filter(Boolean).slice(-6).join('; ')
    return tail ? `${error.message}: ${tail}` : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

async function serverBytes(cacheDir: string): Promise<Uint8Array> {
  await mkdir(cacheDir, { recursive: true })
  const path = join(cacheDir, `scrcpy-server-v${SERVER_VERSION}`)
  try {
    const existing = await readFile(path)
    if (isJar(existing)) return new Uint8Array(existing)
  } catch {
    // Download it.
  }
  const response = await fetch(SERVER_URL, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`could not download scrcpy server (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!isJar(bytes)) throw new Error('downloaded scrcpy server is not a jar')
  await writeFile(path, bytes)
  return bytes
}

function isJar(bytes: Uint8Array): boolean {
  return bytes.length > 1024 && bytes[0] === 0x50 && bytes[1] === 0x4b
}
