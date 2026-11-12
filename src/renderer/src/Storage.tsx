import { useEffect, useState } from 'react'
import type { StorageEntry } from '../../shared'

/** Databases and shared preferences of the app that was launched. */
export function Storage({ pkg }: { pkg: string | null }) {
  const [rows, setRows] = useState<StorageEntry[]>([])
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    if (!pkg) return
    let cancelled = false
    setError('')
    setRows([])
    void window.api.storage(pkg).then(
      (entries) => {
        if (!cancelled) setRows(entries)
      },
      (reason: Error) => {
        if (!cancelled) setError(reason.message)
      },
    )
    return () => {
      cancelled = true
    }
  }, [pkg])
  if (!pkg) return <p className="empty">Launch an app to read its databases and shared preferences.</p>
  return (
    <div className="storage scroll">
      <p className="muted">Files for {pkg}. A rooted phone can read any app. A USB phone can read a debuggable app.</p>
      {error && <p className="error">{error}</p>}
      {rows.map((row) => (
        <details key={row.path} open={open === row.path} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open ? row.path : null)}>
          <summary>
            {row.kind === 'database' ? 'DB' : 'Prefs'} {row.path.split('/').pop()}
          </summary>
          <pre className="body">{row.preview || '(empty)'}</pre>
        </details>
      ))}
      {!error && rows.length === 0 && <p className="empty">No databases or shared preferences found.</p>}
    </div>
  )
}
