import { useEffect, useRef, useState } from 'react'

/** The live phone: frames from the device; clicks and drags become taps and swipes. */
export function Phone({ onLaunched }: { onLaunched: (pid: number | null) => void }) {
  const [src, setSrc] = useState<string | null>(null)
  const [apps, setApps] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [typing, setTyping] = useState('')
  const [smsFrom, setSmsFrom] = useState('VM-HDFCBK')
  const [smsText, setSmsText] = useState('Rs.500.00 debited from A/c XX1234 on 07-11-26 to ZOMATO. UPI Ref 512345678901')
  const [dragging, setDragging] = useState(false)
  const down = useRef<{ x: number; y: number; t: number } | null>(null)
  const img = useRef<HTMLImageElement>(null)

  useEffect(() => {
    let last: string | null = null
    const off = window.api.on('frame', (png) => {
      const url = URL.createObjectURL(new Blob([png.slice()], { type: 'image/png' }))
      setSrc(url)
      if (last) URL.revokeObjectURL(last)
      last = url
    })
    void window.api.apps().then(setApps)
    return off
  }, [])

  const point = (e: React.MouseEvent) => {
    const r = img.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }

  const install = async (files: FileList) => {
    const paths = [...files].map((f) => window.api.pathForFile(f)).filter((p) => p.endsWith('.apk'))
    if (!paths.length) return setStatus('Drop .apk files (all split APKs of one app together).')
    setStatus(`Installing ${paths.length} APK file(s)…`)
    try {
      const out = await window.api.installApk(paths)
      setStatus(out.trim().split('\n').pop() ?? 'Installed')
      setApps(await window.api.apps())
    } catch (error) {
      setStatus(`Install failed: ${(error as Error).message}`)
    }
  }

  return (
    <section
      className={`right ${dragging ? 'drop' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void install(e.dataTransfer.files)
      }}
    >
      <div className="toolbar">
        <select
          defaultValue=""
          onChange={async (e) => {
            if (!e.target.value) return
            setStatus(`Starting ${e.target.value}…`)
            const pid = await window.api.launch(e.target.value)
            onLaunched(pid)
            setStatus(pid ? `${e.target.value} running (pid ${pid})` : `${e.target.value} did not start`)
          }}
        >
          <option value="">Launch app…</option>
          {apps.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <button onClick={() => void window.api.apps().then(setApps)}>↻</button>
      </div>
      <div className="screen">
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
              const moved = Math.hypot(end.x - start.x, end.y - start.y)
              if (moved < 0.01) void window.api.tap(end.x, end.y)
              else void window.api.swipe(start.x, start.y, end.x, end.y, Date.now() - start.t)
            }}
          />
        ) : (
          <div className="muted">Waiting for the screen…</div>
        )}
      </div>
      <div className="navkeys">
        <button onClick={() => void window.api.key('BACK')}>◀</button>
        <button onClick={() => void window.api.key('HOME')}>●</button>
        <button onClick={() => void window.api.key('APP_SWITCH')}>■</button>
      </div>
      <form
        className="typebar"
        onSubmit={(e) => {
          e.preventDefault()
          if (typing) void window.api.text(typing)
          setTyping('')
        }}
      >
        <input placeholder="Type into the phone, Enter to send" value={typing} onChange={(e) => setTyping(e.target.value)} />
      </form>
      <details className="sms">
        <summary>Send a test SMS</summary>
        <input value={smsFrom} onChange={(e) => setSmsFrom(e.target.value)} />
        <textarea value={smsText} onChange={(e) => setSmsText(e.target.value)} rows={3} />
        <button onClick={() => void window.api.sendSms(smsFrom, smsText).then(() => setStatus('SMS sent'))}>Send</button>
      </details>
      <div className="status">{status || 'Drop an APK here to install it.'}</div>
    </section>
  )
}
