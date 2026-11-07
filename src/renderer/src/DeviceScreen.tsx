import { useEffect, useRef, useState } from 'react'
import type { Device } from '../../shared'

/** A live phone screen: frames from the device; click = tap, drag = swipe. */
export function DeviceScreen({ device, className }: { device: Device; className?: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const down = useRef<{ x: number; y: number; t: number } | null>(null)
  const img = useRef<HTMLImageElement>(null)

  useEffect(() => {
    // Drop the previous phone's picture immediately. Taps already go to [device].
    setSrc(null)
    let last: string | null = null
    const off = window.api.on('frame', (from, png) => {
      if (from !== device) return
      const url = URL.createObjectURL(new Blob([png.slice()], { type: 'image/png' }))
      setSrc(url)
      if (last) URL.revokeObjectURL(last)
      last = url
    })
    return () => {
      off()
      if (last) URL.revokeObjectURL(last)
    }
  }, [device])

  const point = (e: React.MouseEvent) => {
    const r = img.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }

  return (
    <div className={`screen ${className ?? ''}`}>
      {src ? (
        <img
          ref={img}
          src={src}
          draggable={false}
          onMouseDown={(e) => (down.current = { ...point(e), t: Date.now() })}
          onMouseUp={(e) => {
            const start = down.current
            down.current = null
            if (!start) return
            const end = point(e)
            if (Math.hypot(end.x - start.x, end.y - start.y) < 0.01) void window.api.tap(device, end.x, end.y)
            else void window.api.swipe(device, start.x, start.y, end.x, end.y, Date.now() - start.t)
          }}
        />
      ) : (
        <div className="muted">Waiting for the screen…</div>
      )}
    </div>
  )
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
      <input placeholder="Type into the phone, Enter to send" value={typing} onChange={(e) => setTyping(e.target.value)} />
    </form>
  )
}
