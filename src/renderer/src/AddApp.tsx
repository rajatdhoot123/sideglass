import { useEffect, useState } from 'react'
import type { StoreApp, UsbPhone } from '../../shared'
import { DeviceScreen, NavKeys, TypeBar } from './DeviceScreen'

type Source = 'store' | 'play' | 'usb' | 'file'

/** Every way to get an app onto the capture phone. */
export function AddApp({ onClose, onInstalled }: { onClose: () => void; onInstalled: (pkg?: string, open?: boolean) => void }) {
  const [source, setSource] = useState<Source>('store')
  const [log, setLog] = useState<string[]>([])
  useEffect(() => window.api.on('store-log', (l) => setLog((prev) => [...prev.slice(-30), l])), [])
  const note = (l: string) => setLog((prev) => [...prev.slice(-30), l])

  return (
    <div className="modal-back" onClick={onClose}>
      <div className={`modal ${source === 'play' ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Add an app</b>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <nav className="subtabs">
          {(
            [
              ['store', 'App store (F-Droid)'],
              ['play', 'Play Store link'],
              ['usb', 'From my phone (USB)'],
              ['file', 'APK file'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={source === id ? 'on' : ''} onClick={() => setSource(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="modal-body">
          {source === 'store' && <Store note={note} onInstalled={onInstalled} />}
          {source === 'play' && <Play note={note} onInstalled={onInstalled} />}
          {source === 'usb' && <Usb note={note} onInstalled={onInstalled} />}
          {source === 'file' && (
            <p className="muted">
              Drag one or more <code>.apk</code> files onto the phone on the right. For an app split into several
              files, drop all of them together.
            </p>
          )}
        </div>
        <pre className="store-log">{log.slice(-6).join('\n') || ' '}</pre>
      </div>
    </div>
  )
}

type Props = { note: (l: string) => void; onInstalled: (pkg?: string, open?: boolean) => void }

function Store({ note, onInstalled }: Props) {
  const [query, setQuery] = useState('')
  const [apps, setApps] = useState<StoreApp[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => void window.api.featured().then(setApps), [])
  return (
    <div className="store">
      <form
        className="filterbar"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!query.trim()) return setApps(await window.api.featured())
          note(`Searching F-Droid for “${query}”…`)
          setApps(await window.api.searchStore(query).catch((err: Error) => (note(err.message), [])))
        }}
      >
        <input placeholder="Search free and open-source apps" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit">Search</button>
      </form>
      <div className="app-grid">
        {apps.map((a) => (
          <div key={a.packageName} className="app-card">
            {a.icon ? <img src={a.icon} alt="" /> : <div className="icon-blank">{a.name[0]}</div>}
            <div className="app-text">
              <b>{a.name}</b>
              <span className="muted">{a.summary}</span>
              <code>{a.packageName}</code>
            </div>
            <button
              disabled={busy !== null}
              onClick={async () => {
                setBusy(a.packageName)
                try {
                  note(`${a.name}: ${await window.api.installFromStore(a.packageName)}`)
                  onInstalled()
                } catch (err) {
                  note(`${a.name}: ${(err as Error).message}`)
                } finally {
                  setBusy(null)
                }
              }}
            >
              {busy === a.packageName ? 'Installing…' : 'Install'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function Play({ note, onInstalled }: Props) {
  const [link, setLink] = useState('')
  const [running, setRunning] = useState(false)
  const [started, setStarted] = useState(false)
  const [openWhenReady, setOpenWhenReady] = useState(true)
  const [stage, setStage] = useState<{ stage: string; message: string } | null>(null)
  useEffect(() => window.api.on('play-stage', setStage), [])
  return (
    <div className="play">
      <div className="play-left">
        {stage && (
          <div className={`banner ${stage.stage}`}>
            {stage.stage === 'needs-user' ? 'Your turn: ' : ''}
            {stage.message}
          </div>
        )}
        <p className="muted">
          Paste a Play Store link. Sideglass opens it on a second phone that has the Play Store. Sign in there once with
          your own Google account and tap <b>Install</b>; the app is then copied to the capture phone.
        </p>
        <form
          className="filterbar"
          onSubmit={async (e) => {
            e.preventDefault()
            setRunning(true)
            setStarted(true)
            setStage(null)
            try {
              const pkg = await window.api.installFromPlay(link)
              note(`${pkg} is on the capture phone.`)
              onInstalled(pkg, openWhenReady)
            } catch (err) {
              note((err as Error).message)
            } finally {
              setRunning(false)
            }
          }}
        >
          <input
            placeholder="https://play.google.com/store/apps/details?id=…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <button type="submit" disabled={running || !link.trim()}>
            {running ? 'Waiting…' : 'Get app'}
          </button>
          {running && (
            <button type="button" onClick={() => void window.api.cancelPlay()}>
              Cancel
            </button>
          )}
        </form>
        <label className="small">
          <input type="checkbox" checked={openWhenReady} onChange={(e) => setOpenWhenReady(e.target.checked)} /> Open
          the app when it is ready, on the phone that can run it
        </label>
        <ul className="muted small">
          <li>Sideglass taps Install for you and only stops when it needs you (sign-in, a prompt, a paid app).</li>
          <li>The Play phone keeps your sign-in between runs.</li>
          <li>Paid apps and apps not offered on this phone cannot be installed.</li>
          <li>The first start downloads the Play Store system image (about 1.5 GB).</li>
        </ul>
      </div>
      {started && (
        <div className="play-right">
          <DeviceScreen device="play" />
          <NavKeys device="play" />
          <TypeBar device="play" />
        </div>
      )}
    </div>
  )
}

function Usb({ note, onInstalled }: Props) {
  const [phones, setPhones] = useState<UsbPhone[]>([])
  const [serial, setSerial] = useState('')
  const [apps, setApps] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = async () => {
    const list = await window.api.usbPhones()
    setPhones(list)
    if (list.length && !list.some((p) => p.serial === serial)) setSerial(list[0].serial)
  }
  useEffect(() => void refresh(), [])
  useEffect(() => {
    if (serial) void window.api.usbApps(serial).then(setApps).catch((e: Error) => note(e.message))
  }, [serial])
  return (
    <div className="usb">
      {phones.length === 0 ? (
        <p className="muted">
          Connect your phone by USB with <b>USB debugging</b> on (Settings → Developer options), accept the prompt on
          the phone, then <button onClick={() => void refresh()}>check again</button>.
        </p>
      ) : (
        <>
          <div className="filterbar">
            <select value={serial} onChange={(e) => setSerial(e.target.value)}>
              {phones.map((p) => (
                <option key={p.serial} value={p.serial}>
                  {p.model} ({p.serial})
                </option>
              ))}
            </select>
            <input placeholder="Filter apps" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="usb-list">
            {apps
              .filter((a) => a.includes(filter))
              .map((a) => (
                <div key={a} className="usb-row">
                  <code>{a}</code>
                  <button
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(a)
                      try {
                        note(`${a}: ${await window.api.installFromUsb(serial, a)}`)
                        onInstalled()
                      } catch (err) {
                        note(`${a}: ${(err as Error).message}`)
                      } finally {
                        setBusy(null)
                      }
                    }}
                  >
                    {busy === a ? 'Copying…' : 'Copy to Sideglass'}
                  </button>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  )
}
