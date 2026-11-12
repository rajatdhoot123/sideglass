import { useEffect, useState } from 'react'

/** Install a second copy of an installed app, under a new package name and launcher name. */
export function CloneApp({
  apps,
  initial,
  onClose,
  onCloned,
}: {
  apps: string[]
  initial?: string
  onClose: () => void
  onCloned: (pkg: string, open: boolean) => void
}) {
  const [pkg, setPkg] = useState(initial && apps.includes(initial) ? initial : (apps[0] ?? ''))
  const [newPkg, setNewPkg] = useState('')
  const [label, setLabel] = useState('')
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string[]>([])
  useEffect(() => window.api.on('store-log', (l) => setLog((prev) => [...prev.slice(-30), l])), [])
  const target = newPkg.trim() || (pkg ? `${pkg}.clone` : '')

  const clone = async () => {
    setBusy(true)
    setLog([])
    try {
      const result = await window.api.cloneApp({ pkg, newPkg: target, label: label.trim() || undefined })
      setLog((prev) => [...prev, `Done: “${result.label}” is installed as ${result.pkg}, next to ${pkg}.`])
      onCloned(result.pkg, open)
    } catch (error) {
      setLog((prev) => [...prev, `Clone failed: ${(error as Error).message}`])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-back" onClick={busy ? undefined : onClose}>
      <div className="modal settings clone" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Clone an app</b>
          <button className="close" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="muted">
            Installs a second copy of an app on this phone with its own package name and name, so the original and the
            clone run side by side with separate data. The copy is signed with Sideglass's own key.
          </p>
          <label>
            App on the phone
            <select value={pkg} onChange={(e) => setPkg(e.target.value)} disabled={busy}>
              {apps.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          <label>
            New package name
            <input value={newPkg} placeholder={pkg ? `${pkg}.clone` : 'com.example.app.clone'} onChange={(e) => setNewPkg(e.target.value)} disabled={busy} />
          </label>
          <label>
            New app name
            <input value={label} placeholder="Leave empty for “<name> (clone)”" onChange={(e) => setLabel(e.target.value)} disabled={busy} />
          </label>
          <label className="small check">
            <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Open the clone when it
            is installed
          </label>
          <ul className="muted small">
            <li>Apps that check their own signature, Google sign-in, Play licensing or Play Integrity may refuse to run as a clone.</li>
            <li>Cloning again with the same package name updates the earlier clone.</li>
          </ul>
          <div className="choice-actions">
            <button className="primary" disabled={busy || !pkg || !target} onClick={() => void clone()}>
              {busy ? 'Cloning…' : 'Clone and install'}
            </button>
          </div>
        </div>
        <pre className="store-log">{log.slice(-6).join('\n') || ' '}</pre>
      </div>
    </div>
  )
}
