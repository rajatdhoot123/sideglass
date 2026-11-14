import { useEffect, useState } from 'react'
import type { Exchange, IntervalUnit, WatchCreated, WatcherStatus } from '../../shared'

const UNITS: { id: IntervalUnit; label: string }[] = [
  { id: 'sec', label: 'seconds' },
  { id: 'min', label: 'minutes' },
  { id: 'hr', label: 'hours' },
  { id: 'day', label: 'days' },
]

function defaultName(detail: Exchange): string {
  const path = detail.path.split('?')[0] ?? detail.path
  return `${detail.method} ${detail.host}${path}`
}

/** URL and token of the watcher worker. The saved token is never shown again; leave it empty to keep it. */
export function WatcherSetup({ status, onSaved }: { status: WatcherStatus; onSaved: (status: WatcherStatus) => void }) {
  const [url, setUrl] = useState(status.url)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      onSaved(await window.api.configureWatcher(url, token))
      setToken('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="watch-setup">
      <p className="muted small">
        The API Watcher is a separate service (the <code>thecurio-watcher</code> Cloudflare Worker). It re-sends a request on a schedule and
        keeps a diff each time the response changes, even while Sideglass is closed.
      </p>
      <label>
        <span>Watcher URL</span>
        <input value={url} placeholder="https://thecurio-watcher.….workers.dev" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        <span>Token</span>
        <input
          type="password"
          value={token}
          placeholder={status.hasToken ? 'Saved for the saved URL. Leave empty to keep it.' : 'WATCHER_TOKEN'}
          autoComplete="off"
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
      </label>
      {error && <p className="save-error">{error}</p>}
      <div className="save-actions">
        <button type="button" className="primary" disabled={busy || !url.trim()} onClick={() => void save()}>
          {busy ? 'Checking…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

/** Hand the selected request to the watcher: how often, and which JSON keys to ignore. */
export function WatchPanel({ detail, onClose }: { detail: Exchange; onClose: () => void }) {
  const [status, setStatus] = useState<WatcherStatus | null>(null)
  const [setup, setSetup] = useState(false)
  const [name, setName] = useState(defaultName(detail))
  const [value, setValue] = useState('5')
  const [unit, setUnit] = useState<IntervalUnit>('min')
  const [ignore, setIgnore] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<WatchCreated | null>(null)

  useEffect(() => {
    void window.api.watcherStatus().then(setStatus)
  }, [])
  useEffect(() => {
    setName(defaultName(detail))
    setCreated(null)
    setError('')
  }, [detail.id])

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const ignoreKeys = ignore
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
      setCreated(await window.api.watch(detail.id, { name, every: { value: Number(value), unit }, ignoreKeys }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null
  const configured = Boolean(status.url && status.hasToken)
  return (
    <div className="watch-panel">
      <div className="watch-head">
        <b>Watch this request</b>
        {configured && (
          <button type="button" className="link" onClick={() => setSetup((open) => !open)}>
            Watcher settings
          </button>
        )}
        <button type="button" className="close" onClick={onClose}>
          ×
        </button>
      </div>
      {(!configured || setup) && (
        <WatcherSetup
          status={status}
          onSaved={(next) => {
            setStatus(next)
            setSetup(false)
          }}
        />
      )}
      {configured && !setup && created && (
        <div className="watch-done">
          <span>
            Watching <b>{created.name}</b>. The first response is the baseline.
          </span>
          <button type="button" className="primary" onClick={() => void window.api.openWatcher(created.id)}>
            Open dashboard
          </button>
          <button type="button" onClick={() => setCreated(null)}>
            Watch again
          </button>
        </div>
      )}
      {configured && !setup && !created && (
        <div className="watch-form">
          <label>
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>Check every</span>
            <span className="watch-every">
              <input type="number" min={1} value={value} aria-label="Interval" onChange={(e) => setValue(e.target.value)} />
              <select value={unit} aria-label="Unit" onChange={(e) => setUnit(e.target.value as IntervalUnit)}>
                {UNITS.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label title="JSON keys left out of the comparison anywhere in the response, such as timestamps or request ids">
            <span>Ignore keys</span>
            <input value={ignore} placeholder="timestamp, requestId" spellCheck={false} onChange={(e) => setIgnore(e.target.value)} />
          </label>
          <p className="muted small">
            The watcher sends this request with its captured headers, including any login token or cookie, and stores them on the watcher.
            Shortest interval is 10 seconds.
          </p>
          {error && <p className="save-error">{error}</p>}
          <div className="save-actions">
            <button type="button" className="primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
              {busy ? 'Starting…' : 'Start watching'}
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Top-bar button: opens the dashboard window, or asks for the watcher's URL and token first. */
export function WatchersButton() {
  const [dialog, setDialog] = useState<WatcherStatus | null>(null)
  const [error, setError] = useState('')
  const open = async () => {
    const status = await window.api.watcherStatus()
    if (!status.url || !status.hasToken) return setDialog(status)
    await window.api.openWatcher().catch((e: Error) => setError(e.message))
  }
  return (
    <>
      <button title={error || 'Open the API Watcher dashboard. Right-click for its settings.'} onClick={() => void open()} onContextMenu={(e) => {
        e.preventDefault()
        void window.api.watcherStatus().then(setDialog)
      }}>
        Watchers
      </button>
      {dialog && (
        <div className="modal-back" onClick={() => setDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b>API Watcher</b>
              <button className="close" onClick={() => setDialog(null)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <WatcherSetup
                status={dialog}
                onSaved={() => {
                  setDialog(null)
                  void window.api.openWatcher()
                }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
