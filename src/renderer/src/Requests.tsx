import { useEffect, useMemo, useState } from 'react'
import type { Exchange, ExchangeSummary, ProxyRule, SavedSession } from '../../shared'
import { toCurl } from '../../main/curl'

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

const shortApp = (pkg?: string) => (pkg ? (pkg.split('.').pop() ?? pkg) : '')

function patternOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return url
  }
}

export function Requests({
  list,
  focusApp,
  archived,
  protoTypes,
  onLive,
  onArchive,
  onLoadProto,
}: {
  list: ExchangeSummary[]
  focusApp: string | null
  archived: boolean
  protoTypes: string[]
  onLive: () => void
  onArchive: (rows: ExchangeSummary[]) => void
  onLoadProto: () => void
}) {
  const [filter, setFilter] = useState('')
  const [hideGoogle, setHideGoogle] = useState(true)
  const [app, setApp] = useState('__all__')
  /** True after the user picks a package. Until then, untagged rows stay visible. */
  const [picked, setPicked] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Exchange | null>(null)
  const [pane, setPane] = useState<'response' | 'request' | 'headers'>('response')
  const [sessions, setSessions] = useState<SavedSession[]>([])
  const [sessionId, setSessionId] = useState('')
  const [rules, setRules] = useState<ProxyRule[]>([])
  const [editing, setEditing] = useState(false)
  const [editUrl, setEditUrl] = useState('')
  const [editMethod, setEditMethod] = useState('GET')
  const [editBody, setEditBody] = useState('')
  const [mockBody, setMockBody] = useState('{}')
  const [decoded, setDecoded] = useState('')
  const [schemaType, setSchemaType] = useState('')
  const apps = useMemo(() => [...new Set(list.map((e) => e.app).filter((name): name is string => !!name))].sort(), [list])

  useEffect(() => {
    if (!focusApp) return
    setApp(focusApp)
    setPicked(false)
  }, [focusApp])
  useEffect(() => {
    void window.api.rules().then(setRules).catch(() => undefined)
  }, [])
  useEffect(() => setDecoded(''), [selected])

  const rows = useMemo(() => {
    const f = filter.toLowerCase()
    return list
      .filter((e) => app === '__all__' || e.app === app || (!picked && !e.app))
      .filter((e) => !hideGoogle || !/(^|\.)(google(apis)?\.com|gstatic\.com|gvt1\.com|googleusercontent\.com)$/.test(e.host.replace(/:\d+$/, '')))
      .filter((e) => !f || e.url.toLowerCase().includes(f) || e.method.toLowerCase() === f || String(e.status) === f)
      .slice(-1500)
  }, [list, filter, hideGoogle, app, picked])

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
        <select
          aria-label="Saved sessions"
          value={archived ? sessionId || 'opened' : ''}
          onFocus={() => void window.api.sessions().then(setSessions)}
          onChange={(e) => {
            const value = e.target.value
            setSessionId(value)
            if (!value) {
              onLive()
              return
            }
            if (value === 'opened') return
            if (value === 'search') {
              void window.api.searchSessions(filter).then(onArchive)
              return
            }
            void window.api.loadSession(value).then(onArchive)
          }}
        >
          <option value="">Live</option>
          {archived && !sessionId && <option value="opened">Opened file</option>}
          <option value="search">Search saved</option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {new Date(session.startedAt).toLocaleString()} ({session.count})
            </option>
          ))}
        </select>
        <button onClick={onLoadProto}>{protoTypes.length ? `${protoTypes.length} proto types` : 'Load .proto'}</button>
        <select
          value={app}
          aria-label="App"
          onChange={(e) => {
            setPicked(true)
            setApp(e.target.value)
          }}
        >
          <option value="__all__">All apps</option>
          {focusApp && !apps.includes(focusApp) && <option value={focusApp}>{shortApp(focusApp)}</option>}
          {apps.map((name) => (
            <option key={name} value={name}>
              {shortApp(name)}
            </option>
          ))}
        </select>
      </div>
      <div className="table">
        <div className="row head">
          <span>Time</span>
          <span>Method</span>
          <span>Status</span>
          <span>App</span>
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
              <span className="appname" title={e.app ?? ''}>
                {shortApp(e.app)}
              </span>
              <span className="host">{e.host}</span>
              <span className="path" title={e.url}>
                {e.path}
              </span>
              <span>{size(e.responseBodySize)}</span>
              <span>{e.durationMs !== undefined ? `${e.durationMs} ms` : ''}</span>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="empty">{app === '__all__' ? 'Use an app on the phone. Its requests show up here.' : `No requests for ${shortApp(app)} yet.`}</div>
          )}
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
          <div className="detail-actions">
            <button
              onClick={() => void window.api.copyText(toCurl(detail)).catch((error: Error) => setDecoded(error.message))}
            >
              Copy as cURL
            </button>
            <button onClick={() => void window.api.replay(detail.id).catch((error: Error) => setDecoded(error.message))}>Replay</button>
            <button
              onClick={() => {
                setEditing((open) => !open)
                setEditUrl(detail.url)
                setEditMethod(detail.method)
                setEditBody(detail.requestBody ?? '')
              }}
            >
              Edit and replay
            </button>
            <button
              onClick={() =>
                void window.api.addRule({ kind: 'block', pattern: patternOf(detail.url) }).then(setRules).catch((error: Error) => setDecoded(error.message))
              }
            >
              Block URL
            </button>
            <button
              onClick={() =>
                void window.api
                  .addRule({ kind: 'mock', pattern: patternOf(detail.url), status: 200, body: mockBody, contentType: 'application/json' })
                  .then(setRules)
                  .catch((error: Error) => setDecoded(error.message))
              }
            >
              Mock URL
            </button>
            <input aria-label="Mock body" value={mockBody} onChange={(e) => setMockBody(e.target.value)} />
          </div>
          {editing && (
            <div className="detail-edit">
              <input aria-label="Replay method" value={editMethod} onChange={(e) => setEditMethod(e.target.value)} />
              <input aria-label="Replay URL" value={editUrl} onChange={(e) => setEditUrl(e.target.value)} />
              <textarea aria-label="Replay body" rows={4} value={editBody} onChange={(e) => setEditBody(e.target.value)} />
              <button
                onClick={() =>
                  void window.api.replay(detail.id, { url: editUrl, method: editMethod, body: editBody }).catch((error: Error) => setDecoded(error.message))
                }
              >
                Send
              </button>
            </div>
          )}
          {rules.length > 0 && (
            <div className="rules">
              {rules.map((rule) => (
                <button key={rule.id} onClick={() => void window.api.removeRule(rule.id).then(setRules)}>
                  {rule.kind} {rule.pattern} ×
                </button>
              ))}
            </div>
          )}
          {protoTypes.length > 0 && (
            <div className="detail-actions">
              <select aria-label="Protobuf type" value={schemaType} onChange={(e) => setSchemaType(e.target.value)}>
                <option value="">Protobuf type…</option>
                {protoTypes.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
              <button
                disabled={!schemaType}
                onClick={() =>
                  void window.api.decodeSchema(detail.id, pane === 'request' ? 'request' : 'response', schemaType).then(setDecoded, (error: Error) => setDecoded(error.message))
                }
              >
                Decode with schema
              </button>
            </div>
          )}
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
          {pane === 'request' && <pre className="scroll body">{decoded || pretty(detail.requestBody) || '(no body)'}</pre>}
          {pane === 'response' && <pre className="scroll body">{decoded || pretty(detail.responseBody, detail.contentType) || '(no body)'}</pre>}
        </div>
      )}
    </div>
  )
}
