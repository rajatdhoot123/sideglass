import { useEffect, useMemo, useState } from 'react'
import type { Exchange, ExchangeSummary } from '../../shared'
import { FILTER_KEYS, parseFilter, RESOURCE_TYPES, resourceType, TYPE_LABELS, type ResourceType } from './netfilter'

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

export function Requests({ list, focusApp }: { list: ExchangeSummary[]; focusApp: string | null }) {
  const [filter, setFilter] = useState('')
  const [invert, setInvert] = useState(false)
  /** Empty means All. */
  const [types, setTypes] = useState<Set<ResourceType>>(new Set())
  const [hideGoogle, setHideGoogle] = useState(true)
  const [app, setApp] = useState('__all__')
  /** True after the user picks a package. Until then, untagged rows stay visible. */
  const [picked, setPicked] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Exchange | null>(null)
  const [pane, setPane] = useState<'response' | 'request' | 'headers'>('response')
  const apps = useMemo(() => [...new Set(list.map((e) => e.app).filter((name): name is string => !!name))].sort(), [list])

  useEffect(() => {
    if (!focusApp) return
    setApp(focusApp)
    setPicked(false)
  }, [focusApp])

  const matches = useMemo(() => parseFilter(filter), [filter])
  const rows = useMemo(() => {
    const active = filter.trim() !== ''
    return list
      .filter((e) => app === '__all__' || e.app === app || (!picked && !e.app))
      .filter((e) => !hideGoogle || !/(^|\.)(google(apis)?\.com|gstatic\.com|gvt1\.com|googleusercontent\.com)$/.test(e.host.replace(/:\d+$/, '')))
      .filter((e) => types.size === 0 || types.has(resourceType(e)))
      .filter((e) => !active || matches(e) !== invert)
      .slice(-1500)
  }, [list, filter, matches, invert, types, hideGoogle, app, picked])

  /** Click picks one type; Cmd/Ctrl-click adds or removes it, as in Chrome. */
  const pickType = (type: ResourceType | null, multi: boolean) => {
    if (type === null) return setTypes(new Set())
    setTypes((prev) => {
      if (!multi) return new Set(prev.size === 1 && prev.has(type) ? [] : [type])
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const current = selected ? list.find((e) => e.id === selected) : undefined
  useEffect(() => {
    if (!selected) return setDetail(null)
    void window.api.getExchange(selected).then(setDetail)
  }, [selected, current?.state])

  return (
    <div className="requests">
      <div className="filterbar">
        <input
          type="search"
          placeholder="Filter  (e.g. api -analytics method:POST status-code:4xx /v\d+/)"
          title={`Space-separated terms must all match. -term excludes, /regex/ matches the URL.\nKeys: ${FILTER_KEYS.join(', ')}\nCommas mean any of: method:POST,PUT. * is a wildcard: domain:*.example.com`}
          value={filter}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label title="Show the requests that do not match the filter text">
          <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> Invert
        </label>
        <label>
          <input type="checkbox" checked={hideGoogle} onChange={(e) => setHideGoogle(e.target.checked)} /> Hide Google system traffic
        </label>
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
      <div className="typechips" role="toolbar" aria-label="Resource type">
        <button className={types.size === 0 ? 'on' : ''} onClick={() => pickType(null, false)}>
          All
        </button>
        {RESOURCE_TYPES.map((t) => (
          <button key={t} className={types.has(t) ? 'on' : ''} onClick={(e) => pickType(t, e.metaKey || e.ctrlKey)}>
            {TYPE_LABELS[t]}
          </button>
        ))}
        <span className="spacer" />
        <span className="muted small">
          {rows.length} / {list.length} requests
        </span>
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
            <div className="empty">{list.length > 0 && (filter.trim() || types.size > 0) ? 'No requests match the filter.' : app === '__all__' ? 'Use an app on the phone. Its requests show up here.' : `No requests for ${shortApp(app)} yet.`}</div>
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
