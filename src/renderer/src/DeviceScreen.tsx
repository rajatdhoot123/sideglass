import { useEffect, useRef, useState } from 'react'
import { ScrcpyVideoCodecId, type ScrcpyMediaStreamPacket } from '@yume-chan/scrcpy'
import { BitmapVideoFrameRenderer, WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs'
import type { Device, KeyEvent, VideoPacket } from '../../shared'

/** A live phone. Video when scrcpy is up; screenshots if it is not. */
export function DeviceScreen({ device, className }: { device: Device; className?: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const liveRef = useRef(false)
  const fingers = useRef(new Map<number, number>())
  const nextFinger = useRef(0)
  const down = useRef<{ x: number; y: number; t: number } | null>(null)
  const pendingMove = useRef<{ id: number; x: number; y: number } | null>(null)
  const moving = useRef(false)

  useEffect(() => {
    // Drop the previous phone's picture immediately. Taps already go to [device].
    setSrc(null)
    setLive(false)
    liveRef.current = false
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false
    let configured = false
    let controller: ReadableStreamDefaultController<ScrcpyMediaStreamPacket> | null = null
    const stream = new ReadableStream<ScrcpyMediaStreamPacket>({
      start(control) {
        controller = control
      },
    })

    let decoder: WebCodecsVideoDecoder | null = null
    let canDecode = false
    if (!WebCodecsVideoDecoder.isSupported) {
      void window.api.useFrames(device)
    } else {
      try {
        const renderer = webGlRenderer(canvas)
        decoder = new WebCodecsVideoDecoder({ codec: ScrcpyVideoCodecId.H264, renderer })
        canDecode = true
        void stream.pipeTo(decoder.writable).catch(() => {
          if (!disposed) void window.api.useFrames(device)
        })
      } catch {
        void window.api.useFrames(device)
      }
    }

    const enqueue = (packet: VideoPacket) => {
      if (!canDecode || !controller || disposed) return
      const data = new Uint8Array(packet.data)
      if (packet.type === 'configuration') configured = true
      else if (!configured) return
      const message: ScrcpyMediaStreamPacket =
        packet.type === 'configuration'
          ? { type: 'configuration', data }
          : {
              type: 'data',
              data,
              keyframe: packet.keyframe,
              pts: packet.pts == null ? undefined : BigInt(Math.trunc(packet.pts)),
            }
      try {
        controller.enqueue(message)
        liveRef.current = true
        setLive(true)
      } catch {
        // The decoder stream is already closed.
      }
    }

    const offVideo = window.api.on('video', (from, packet) => {
      if (from === device) enqueue(packet)
    })
    const offMode = window.api.on('screen-mode', (from, mode) => {
      if (from !== device || mode !== 'frames') return
      liveRef.current = false
      setLive(false)
      configured = false
    })
    let last: string | null = null
    const offFrame = window.api.on('frame', (from, png) => {
      if (from !== device || liveRef.current) return
      const url = URL.createObjectURL(new Blob([png.slice()], { type: 'image/png' }))
      setSrc(url)
      if (last) URL.revokeObjectURL(last)
      last = url
    })

    // If the stream was already running when this view mounted, ask for a fresh keyframe.
    void window.api.screenState().then((state) => {
      if (!disposed && state[device] === 'video') void window.api.refreshVideo(device)
    })

    const onWheel = (event: WheelEvent) => {
      if (!liveRef.current) return
      event.preventDefault()
      const point = fraction(canvas, event.clientX, event.clientY)
      const scale = event.deltaMode === 1 ? 100 : event.deltaMode === 2 ? 800 : 1
      void window.api.scroll(device, point.x, point.y, event.deltaX * scale, event.deltaY * scale)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      disposed = true
      offVideo()
      offMode()
      offFrame()
      canvas.removeEventListener('wheel', onWheel)
      if (last) URL.revokeObjectURL(last)
      try {
        controller?.close()
      } catch {
        // Already closed.
      }
      decoder?.dispose()
    }
  }, [device])

  const token = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return -1
    let id = fingers.current.get(e.pointerId)
    if (id == null) {
      id = nextFinger.current++ % 10
      fingers.current.set(e.pointerId, id)
    }
    return id
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    const point = fraction(e.currentTarget, e.clientX, e.clientY)
    void window.api.touch(device, 'down', token(e), point.x, point.y)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const point = fraction(e.currentTarget, e.clientX, e.clientY)
    pendingMove.current = { id: token(e), ...point }
    if (moving.current) return
    moving.current = true
    requestAnimationFrame(() => {
      moving.current = false
      const pending = pendingMove.current
      if (pending) void window.api.touch(device, 'move', pending.id, pending.x, pending.y)
    })
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const id = token(e)
    fingers.current.delete(e.pointerId)
    const point = fraction(e.currentTarget, e.clientX, e.clientY)
    void window.api.touch(device, e.type === 'pointercancel' ? 'cancel' : 'up', id, point.x, point.y)
  }

  const onKey = (e: React.KeyboardEvent, action: 'down' | 'up') => {
    e.preventDefault()
    const event: KeyEvent = {
      action,
      code: e.code,
      key: e.key,
      repeat: e.repeat,
      alt: e.altKey,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
    }
    void window.api.keyEvent(device, event)
  }

  const pointOf = (e: React.MouseEvent) => fraction(imgRef.current!, e.clientX, e.clientY)

  return (
    <div className={`screen ${className ?? ''}`}>
      <canvas
        ref={canvasRef}
        className={live ? undefined : 'pending'}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => onKey(e, 'down')}
        onKeyUp={(e) => onKey(e, 'up')}
        onContextMenu={(e) => e.preventDefault()}
      />
      {!live &&
        (src ? (
          <img
            ref={imgRef}
            src={src}
            draggable={false}
            alt=""
            onMouseDown={(e) => (down.current = { ...pointOf(e), t: Date.now() })}
            onMouseUp={(e) => {
              const start = down.current
              down.current = null
              if (!start) return
              const end = pointOf(e)
              if (Math.hypot(end.x - start.x, end.y - start.y) < 0.01) void window.api.tap(device, end.x, end.y)
              else void window.api.swipe(device, start.x, start.y, end.x, end.y, Date.now() - start.t)
            }}
          />
        ) : (
          <div className="muted">Waiting for the screen…</div>
        ))}
    </div>
  )
}

function webGlRenderer(canvas: HTMLCanvasElement): WebGLVideoFrameRenderer | BitmapVideoFrameRenderer {
  if (!WebGLVideoFrameRenderer.isSupported) return new BitmapVideoFrameRenderer(canvas)
  try {
    return new WebGLVideoFrameRenderer(canvas)
  } catch {
    return new BitmapVideoFrameRenderer(canvas)
  }
}

function fraction(el: Element, clientX: number, clientY: number): { x: number; y: number } {
  const rect = el.getBoundingClientRect()
  return {
    x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
  }
}

export function NavKeys({ device }: { device: Device }) {
  return (
    <div className="navkeys">
      <button title="Back" onClick={() => void window.api.key(device, 'BACK')}>◀</button>
      <button title="Home" onClick={() => void window.api.key(device, 'HOME')}>●</button>
      <button title="Recent apps" onClick={() => void window.api.key(device, 'APP_SWITCH')}>■</button>
    </div>
  )
}

export function TypeBar({ device }: { device: Device }) {
  const [typing, setTyping] = useState('')
  return (
    <form
      className="typebar"
      onSubmit={(e) => {
        e.preventDefault()
        if (typing) void window.api.text(device, typing)
        setTyping('')
      }}
    >
      <input
        placeholder="Type here and press Enter, or click the phone and use the keyboard"
        value={typing}
        onChange={(e) => setTyping(e.target.value)}
      />
    </form>
  )
}
