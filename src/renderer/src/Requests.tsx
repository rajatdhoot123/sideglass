import { useEffect, useMemo, useState } from 'react'
import type { Exchange, ExchangeSummary, ProxyRule, SavedSession, SaveFormat, SaveLayout } from '../../shared'
import { toCurl } from '../../main/curl'
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

const SAVE_FORMATS: { id: SaveFormat; name: string; one: string; each: string }[] = [
  { id: 'har', name: 'HAR', one: 'One file. Opens in Chrome, Charles, and Postman.', each: 'One .har file per request.' },
  { id: 'postman', name: 'Postman', one: 'One collection you can import.', each: 'One collection file per request.' },
  { id: 'curl', name: 'cURL', one: 'One shell script you can run.', each: 'One script per request.' },
  { id: 'http', name: 'HTTP', one: 'One file for VS Code and IntelliJ.', each: 'One .http file per request.' },
]

function scopeText(options: {
  saveAll: boolean
  total: number
  matched: number
  types: Set<ResourceType>
  app: string
  filter: string
  invert: boolean
  hideGoogle: boolean
}): string {
  if (options.saveAll) return `All ${options.total} captured requests.`
  const parts: string[] = []
  if (options.types.size > 0) parts.push([...options.types].map((type) => TYPE_LABELS[type]).join(' + '))
  if (options.app !== '__all__') parts.push(shortApp(options.app))
  const text = options.filter.trim()
  if (text) parts.push(options.invert ? `not "${text}"` : `"${text}"`)
  if (options.hideGoogle) parts.push('Google hidden')
  if (parts.length === 0) return `${options.matched} requests. The list is not filtered.`
  return `${options.matched} requests · ${parts.join(' · ')}.`
}

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
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveAll, setSaveAll] = useState(false)
  const [layout, setLayout] = useState<SaveLayout>('one')
  const [format, setFormat] = useState<SaveFormat>('har')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveNote, setSaveNote] = useState('')
  const [savePath, setSavePath] = useState('')
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

  const matches = useMemo(() => parseFilter(filter), [filter])
  const LIMIT = 1500
  const matched = useMemo(() => {
    const active = filter.trim() !== ''
    return list
      .filter((e) => app === '__all__' || e.app === app || (!picked && !e.app))
      .filter((e) => !hideGoogle || !/(^|\.)(google(apis)?\.com|gstatic\.com|gvt1\.com|googleusercontent\.com)$/.test(e.host.replace(/:\d+$/, '')))
      .filter((e) => types.size === 0 || types.has(resourceType(e)))
      .filter((e) => !active || matches(e) !== invert)
  }, [list, filter, matches, invert, types, hideGoogle, app, picked])

  const rows = useMemo(() => matched.slice(-LIMIT), [matched])

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

  useEffect(() => {
    if (!saveOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) setSaveOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveOpen, saving])

  const saveCount = saveAll ? list.length : matched.length
  const save = async () => {
    const ids = (saveAll ? list : matched).map((row) => row.id)
    if (ids.length === 0) return
    setSaving(true)
    setSaveError('')
    try {
      const result = await window.api.saveCalls(ids, format, layout)
      if (!result) return
      const base = result.path.split(/[/\\]/).pop() || result.path
      setSavePath(result.path)
      const saved = layout === 'each' ? `Saved ${result.count} files to ${base}` : `Saved ${result.count} to ${base}`
      setSaveNote(result.missing > 0 ? `${saved} · ${result.missing} no longer in this session` : saved)
      setSaveOpen(false)
    } catch (error) {
      setSaveError((error as Error).message)
    } finally {
      setSaving(false)
    }
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
      <div className="typebar">
        <div className="typechips" role="toolbar" aria-label="Resource type">
          <button className={types.size === 0 ? 'on' : ''} onClick={() => pickType(null, false)}>
            All
          </button>
          {RESOURCE_TYPES.map((t) => (
            <button key={t} className={types.has(t) ? 'on' : ''} onClick={(e) => pickType(t, e.metaKey || e.ctrlKey)}>
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <span className="muted small match-count">
          {matched.length > LIMIT ? `showing last ${LIMIT} of ${matched.length} matched` : `${matched.length} matched`} · {list.length} total
        </span>
        {saveNote && (
          <span className="muted small save-note" title={savePath}>
            {saveNote}
          </span>
        )}
        <button
          type="button"
          className={`save ${saveOpen ? 'on' : ''}`}
          aria-expanded={saveOpen}
          aria-controls="save-requests"
          disabled={list.length === 0}
          title="Save the requests that match the filter, type, and app"
          onClick={() => {
            setSaveOpen((open) => {
              if (!open) setSaveAll(false)
              return !open
            })
            setSaveError('')
          }}
        >
          Save {matched.length}…
        </button>
      </div>
      {saveOpen && (
        <div id="save-requests" className="save-panel">
          <p className="save-lead">
            {scopeText({ saveAll, total: list.length, matched: matched.length, types, app, filter, invert, hideGoogle })}
          </p>
          {matched.length !== list.length && (
            <label className="save-all">
              <input type="checkbox" checked={saveAll} onChange={(e) => setSaveAll(e.target.checked)} />
              Save all {list.length} instead
            </label>
          )}
          {!saveAll && types.size === 0 && list.length > 0 && (
            <p className="muted small save-hint">To save one kind only, click a type above, such as Fetch/XHR.</p>
          )}
          {!saveAll && matched.length > rows.length && <p className="muted small save-hint">This includes older matches that are not on screen.</p>}
          <div className="save-row">
            <span className="muted small" id="save-layout-label">
              Save as
            </span>
            <div className="save-layout" role="group" aria-labelledby="save-layout-label">
              <button type="button" className={layout === 'one' ? 'on' : ''} aria-pressed={layout === 'one'} onClick={() => setLayout('one')}>
                One file
              </button>
              <button type="button" className={layout === 'each' ? 'on' : ''} aria-pressed={layout === 'each'} onClick={() => setLayout('each')}>
                One file per request
              </button>
            </div>
          </div>
          <div className="muted small">Format</div>
          <div className="save-formats" role="radiogroup" aria-label="Format">
            {SAVE_FORMATS.map((item) => (
              <label key={item.id} className={format === item.id ? 'on' : ''}>
                <input type="radio" name="save-format" value={item.id} checked={format === item.id} onChange={() => setFormat(item.id)} />
                <span>
                  <b>{item.name}</b>
                  <small>{layout === 'one' ? item.one : item.each}</small>
                </span>
              </label>
            ))}
          </div>
          <p className="muted small save-hint">
            {layout === 'one'
              ? 'You pick the file name next.'
              : 'You pick a folder next. Sideglass adds a new folder inside it, with one file per request.'}
          </p>
          {saveError && <p className="save-error">{saveError}</p>}
          <div className="save-actions">
            <button type="button" className="primary" disabled={saving || saveCount === 0} onClick={() => void save()}>
              {saving ? 'Saving…' : `Save ${saveCount}`}
            </button>
            <button type="button" onClick={() => setSaveOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
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
