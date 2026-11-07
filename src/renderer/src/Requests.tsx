import { useEffect, useMemo, useState } from 'react'
import type { Exchange, ExchangeSummary } from '../../shared'

const size = (n?: number) => (n === undefined ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`)
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false })

function pretty(body?: string, type?: string): string {
  if (!body) return ''
  if ((type ?? '').includes('json') || /^\s*[[{]/.test(body)) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      return body
    }
  }
  return body
}

function Headers({ headers }: { headers?: Record<string, string | string[] | undefined> }) {
  return (
    <table className="headers">
      <tbody>
        {Object.entries(headers ?? {}).map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td>{Array.isArray(v) ? v.join(', ') : v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Requests({ list }: { list: ExchangeSummary[] }) {
  const [filter, setFilter] = useState('')
  const [hideGoogle, setHideGoogle] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Exchange | null>(null)
  const [pane, setPane] = useState<'response' | 'request' | 'headers'>('response')

  const rows = useMemo(() => {
    const f = filter.toLowerCase()
    return list
      .filter((e) => !hideGoogle || !/(^|\.)(google(apis)?\.com|gstatic\.com|gvt1\.com|googleusercontent\.com)$/.test(e.host.replace(/:\d+$/, '')))
      .filter((e) => !f || e.url.toLowerCase().includes(f) || e.method.toLowerCase() === f || String(e.status) === f)
      .slice(-1500)
  }, [list, filter, hideGoogle])

  const current = selected ? list.find((e) => e.id === selected) : undefined
  useEffect(() => {
    if (!selected) return setDetail(null)
    void window.api.getExchange(selected).then(setDetail)
  }, [selected, current?.state])

  return (
    <div className="requests">
      <div className="filterbar">
        <input placeholder="Filter by URL, method or status" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label>
          <input type="checkbox" checked={hideGoogle} onChange={(e) => setHideGoogle(e.target.checked)} /> Hide Google system traffic
        </label>
      </div>
      <div className="table">
        <div className="row head">
          <span>Time</span>
          <span>Method</span>
          <span>Status</span>
          <span>Host</span>
          <span>Path</span>
          <span>Size</span>
          <span>Time</span>
        </div>
        <div className="rows">
          {rows.map((e) => (
            <div
              key={e.id}
              className={`row ${selected === e.id ? 'sel' : ''} ${e.state} ${e.status && e.status >= 400 ? 'bad' : ''}`}
              onClick={() => setSelected(e.id)}
            >
              <span>{time(e.startedAt)}</span>
              <span className="method">{e.method}</span>
              <span>{e.state === 'aborted' ? 'aborted' : (e.status ?? '…')}</span>
              <span className="host">{e.host}</span>
              <span className="path" title={e.url}>
                {e.path}
              </span>
              <span>{size(e.responseBodySize)}</span>
              <span>{e.durationMs !== undefined ? `${e.durationMs} ms` : ''}</span>
            </div>
          ))}
          {rows.length === 0 && <div className="empty">Use an app on the phone. Its requests show up here.</div>}
        </div>
      </div>
      {detail && (
        <div className="detail">
          <div className="detail-title">
            <b>{detail.method}</b> {detail.url}
            <button className="close" onClick={() => setSelected(null)}>
              ×
            </button>
          </div>
          <nav className="subtabs">
            {(['response', 'request', 'headers'] as const).map((p) => (
              <button key={p} className={pane === p ? 'on' : ''} onClick={() => setPane(p)}>
                {p[0].toUpperCase() + p.slice(1)}
              </button>
            ))}
          </nav>
          {pane === 'headers' && (
            <div className="scroll">
              <h4>Request headers</h4>
              <Headers headers={detail.requestHeaders} />
              <h4>Response headers {detail.status && `(${detail.status} ${detail.statusMessage ?? ''})`}</h4>
              <Headers headers={detail.responseHeaders} />
            </div>
          )}
          {pane === 'request' && <pre className="scroll body">{pretty(detail.requestBody) || '(no body)'}</pre>}
          {pane === 'response' && <pre className="scroll body">{pretty(detail.responseBody, detail.contentType) || '(no body)'}</pre>}
        </div>
      )}
    </div>
  )
}
