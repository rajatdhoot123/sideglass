import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CodeIndex, CodeProgress, CodeSearch } from '../../shared'
import { buildTree, classPathFor, highlightJava, type TreeNode } from './codeview'

/** Ask the Code tab to search, e.g. from "Find in code" on a request. */
export interface CodeRequest {
  pkg: string | null
  query: string
  n: number
}

interface OpenFile {
  path: string
  text: string
  line?: number
}

const MAX_CHILDREN = 1500
const MAX_HIGHLIGHT_LINES = 10_000

/** Decompiled code of an installed app: a file tree, a search across it, and a viewer. */
export function Code({ focusApp, request }: { focusApp: string | null; request: CodeRequest | null }) {
  const [apps, setApps] = useState<string[]>([])
  const [pkg, setPkg] = useState<string>(focusApp ?? '')
  const [index, setIndex] = useState<CodeIndex | null>(null)
  const [indexLoading, setIndexLoading] = useState(false)
  const [progress, setProgress] = useState<CodeProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [skipLibraries, setSkipLibraries] = useState(true)
  const [matchCase, setMatchCase] = useState(false)
  const [results, setResults] = useState<CodeSearch | null>(null)
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState('')
  const [file, setFile] = useState<OpenFile | null>(null)
  const [back, setBack] = useState<OpenFile[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [exported, setExported] = useState('')
  const [exporting, setExporting] = useState(false)
  const pendingSearch = useRef<string | null>(null)
  const pkgRef = useRef(pkg)
  pkgRef.current = pkg
  const fileRef = useRef(file)
  fileRef.current = file

  useEffect(() => {
    void window.api.apps().then(setApps, () => setApps([]))
    return window.api.on('code-progress', (p) => {
      if (p.pkg === pkgRef.current) setProgress(p)
    })
  }, [])

  // Follow the launched app until the user picks one here.
  const picked = useRef(false)
  useEffect(() => {
    if (focusApp && !picked.current) setPkg(focusApp)
  }, [focusApp])

  useEffect(() => {
    if (!request) return
    if (request.pkg) {
      picked.current = true
      setPkg(request.pkg)
    }
    setQuery(request.query)
    pendingSearch.current = request.query
  }, [request])

  const loadIndex = useCallback((name: string) => {
    if (!name) return
    setIndexLoading(true)
    setError('')
    void window.api
      .codeIndex(name)
      .then(
        (next) => {
          if (pkgRef.current !== name) return
          setIndex(next)
          if (next) setExpanded(new Set(initialExpanded(name)))
        },
        (reason: Error) => setError(reason.message),
      )
      .finally(() => setIndexLoading(false))
  }, [])

  useEffect(() => {
    setIndex(null)
    setResults(null)
    setFile(null)
    setBack([])
    setProgress(null)
    setExported('')
    loadIndex(pkg)
  }, [pkg, loadIndex])

  const runSearch = useCallback(
    (text: string) => {
      if (!index || text.trim().length < 2) {
        setResults(null)
        return
      }
      setSearching(true)
      setSearched(text.trim())
      void window.api
        .searchCode(index.pkg, text, { skipLibraries, matchCase })
        .then(setResults, (reason: Error) => setError(reason.message))
        .finally(() => setSearching(false))
    },
    [index, skipLibraries, matchCase],
  )

  // A search asked for before the index was ready runs as soon as it is.
  useEffect(() => {
    if (index && pendingSearch.current) {
      const text = pendingSearch.current
      pendingSearch.current = null
      runSearch(text)
    }
  }, [index, runSearch])

  const decompile = async (force: boolean) => {
    if (!pkg) return
    setBusy(true)
    setError('')
    setProgress({ pkg, message: 'Starting…' })
    try {
      const next = await window.api.decompile(pkg, force)
      if (pkgRef.current === pkg) {
        setIndex(next)
        setExpanded(new Set(initialExpanded(pkg)))
      }
    } catch (reason) {
      const message = (reason as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      if (message !== 'Cancelled') setError(message)
    } finally {
      setBusy(false)
    }
  }

  const open = useCallback(
    async (path: string, line?: number, remember = true) => {
      if (!index) return
      try {
        const text = await window.api.codeFile(index.pkg, path)
        const current = fileRef.current
        if (remember && current && current.path !== path) setBack((stack) => [...stack.slice(-50), current])
        setFile({ path, text, line })
      } catch (reason) {
        setError((reason as Error).message)
      }
    },
    [index],
  )

  const tree = useMemo(() => {
    if (!index) return []
    const needle = filter.trim().toLowerCase()
    const files = needle ? index.files.filter((f) => f.toLowerCase().includes(needle)) : index.files
    return buildTree(files)
  }, [index, filter])

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const goToClass = (name: string) => {
    if (!index || !file) return
    const path = classPathFor(name, file.text, file.path, index.files)
    if (path) void open(path)
  }

  const appOptions = useMemo(() => [...new Set([...(pkg ? [pkg] : []), ...apps])].sort(), [apps, pkg])
  const running = busy && progress && !progress.done

  return (
    <div className="code">
      <div className="code-bar">
        <select
          value={pkg}
          onChange={(event) => {
            picked.current = true
            setPkg(event.target.value)
          }}
          onFocus={() => void window.api.apps().then(setApps, () => undefined)}
        >
          {!pkg && <option value="">Pick an app…</option>}
          {appOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {running ? (
          <button onClick={() => void window.api.cancelDecompile(pkg)}>Cancel</button>
        ) : (
          <button className={index && !index.stale ? '' : 'primary'} disabled={!pkg || busy} onClick={() => void decompile(Boolean(index))}>
            {index ? (index.stale ? 'Decompile new version' : 'Decompile again') : 'Decompile'}
          </button>
        )}
        {index && !running && (
          <button
            disabled={exporting}
            title="Copy the decompiled Java sources and resources into a folder, to open in an editor or IDE"
            onClick={() => {
              setExporting(true)
              setError('')
              void window.api
                .exportCode(index.pkg)
                .then(
                  (result) => result && setExported(`Exported ${result.count.toLocaleString()} files to ${result.path}`),
                  (reason: Error) => setError(reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')),
                )
                .finally(() => setExporting(false))
            }}
          >
            {exporting ? 'Exporting…' : 'Export…'}
          </button>
        )}
        {running && (
          <span className="code-progress">
            {progress.percent !== undefined && <progress max={100} value={progress.percent} />}
            <span className="muted">
              {progress.message}
              {progress.percent !== undefined ? ` ${progress.percent}%` : ''}
            </span>
          </span>
        )}
        {!running && index && (
          <span className="muted">
            {index.version} · {index.files.length.toLocaleString()} files
            {index.errors ? ` · ${index.errors} partly decompiled` : ''}
            {index.stale ? ' · the phone has a different version' : ''}
          </span>
        )}
      </div>
      {error && <p className="error code-error">{error}</p>}
      {exported && <p className="muted code-error">{exported}</p>}
      {!pkg && <p className="empty">Pick an installed app to decompile it.</p>}
      {pkg && !index && !indexLoading && !running && (
        <div className="empty code-intro">
          <p>
            <b>Decompile</b> copies {pkg} from the phone and turns its code back into Java with jadx (Apache-2.0). The first time
            downloads jadx (about 70 MB). It needs Java, as Clone app does.
          </p>
          <p className="muted">Big apps take a few minutes. The result is kept, so it opens instantly next time.</p>
        </div>
      )}
      {index && (
        <div className="code-body">
          <div className="code-side">
            <form
              className="code-search"
              onSubmit={(event) => {
                event.preventDefault()
                runSearch(query)
              }}
            >
              <input
                placeholder="Search the code: a path, a host, a header name…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  if (!event.target.value) setResults(null)
                }}
              />
              <label title="Leave out androidx, Kotlin, Google, OkHttp and other well-known libraries">
                <input type="checkbox" checked={skipLibraries} onChange={(event) => setSkipLibraries(event.target.checked)} /> Skip libraries
              </label>
              <label>
                <input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} /> Aa
              </label>
            </form>
            {searching && <p className="muted pad">Searching…</p>}
            {results && !searching ? (
              <SearchResults results={results} query={searched} current={file} onOpen={(path, line) => void open(path, line)} onClose={() => setResults(null)} />
            ) : (
              !searching && (
                <>
                  <input className="code-filter" placeholder="Filter files" value={filter} onChange={(event) => setFilter(event.target.value)} />
                  <div className="code-tree scroll">
                    <Tree nodes={tree} depth={0} expanded={filter.trim() ? null : expanded} current={file?.path} onToggle={toggle} onOpen={(path) => void open(path)} />
                  </div>
                </>
              )
            )}
          </div>
          <div className="code-view">
            {file ? (
              <>
                <div className="code-file-bar">
                  <button
                    disabled={!back.length}
                    title="Back"
                    onClick={() => {
                      const previous = back[back.length - 1]
                      setBack((stack) => stack.slice(0, -1))
                      if (previous) void open(previous.path, previous.line, false)
                    }}
                  >
                    ←
                  </button>
                  <span className="code-path" title={file.path}>
                    {file.path}
                  </span>
                  <button onClick={() => void window.api.copyText(file.text)}>Copy</button>
                </div>
                <Source file={file} query={results ? searched : ''} matchCase={matchCase} onClass={goToClass} />
              </>
            ) : (
              <p className="empty">Open a file from the tree, or search. ⌘-click (Ctrl-click) a class name to open it.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function initialExpanded(pkg: string): string[] {
  // Open sources/ and the folders down to the app's own package.
  const parts = ['sources', ...pkg.split('.')]
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

function Tree({
  nodes,
  depth,
  expanded,
  current,
  onToggle,
  onOpen,
}: {
  nodes: TreeNode[]
  depth: number
  /** null shows every folder open, for a filtered tree. */
  expanded: Set<string> | null
  current?: string
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const shown = nodes.slice(0, MAX_CHILDREN)
  return (
    <>
      {shown.map((node) => {
        const isOpen = node.children && (expanded === null || expanded.has(node.path))
        return (
          <Fragment key={node.path}>
            <div
              className={`code-node${node.path === current ? ' on' : ''}${node.children ? ' dir' : ''}`}
              style={{ paddingLeft: 6 + depth * 12 }}
              title={node.path}
              onClick={() => (node.children ? onToggle(node.path) : onOpen(node.path))}
            >
              {node.children ? (isOpen ? '▾ ' : '▸ ') : '  '}
              {node.name}
            </div>
            {isOpen && <Tree nodes={node.children!} depth={depth + 1} expanded={expanded} current={current} onToggle={onToggle} onOpen={onOpen} />}
          </Fragment>
        )
      })}
      {nodes.length > MAX_CHILDREN && (
        <div className="code-node muted" style={{ paddingLeft: 6 + depth * 12 }}>
          … {nodes.length - MAX_CHILDREN} more. Use the filter.
        </div>
      )}
    </>
  )
}

function SearchResults({
  results,
  query,
  current,
  onOpen,
  onClose,
}: {
  results: CodeSearch
  query: string
  current: OpenFile | null
  onOpen: (path: string, line: number) => void
  onClose: () => void
}) {
  const byFile = useMemo(() => {
    const groups = new Map<string, CodeSearch['hits']>()
    for (const hit of results.hits) {
      const list = groups.get(hit.file) ?? []
      list.push(hit)
      groups.set(hit.file, list)
    }
    return [...groups.entries()]
  }, [results])
  return (
    <div className="code-results scroll">
      <div className="code-results-head">
        <span className="muted">
          {results.hits.length ? `${results.hits.length}${results.truncated ? '+' : ''} matches in ${byFile.length} files` : `No matches in ${results.scanned.toLocaleString()} files`}
        </span>
        <button onClick={onClose}>Files</button>
      </div>
      {byFile.map(([path, hits]) => (
        <div key={path} className="code-result">
          <div className="code-result-file" title={path}>
            {path.replace(/^sources\//, '')}
          </div>
          {hits.map((hit) => (
            <div
              key={hit.line}
              className={`code-hit${current?.path === path && current.line === hit.line ? ' on' : ''}`}
              onClick={() => onOpen(path, hit.line)}
            >
              <span className="ln">{hit.line}</span>
              <span>{mark(hit.text, query, false)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function Source({ file, query, matchCase, onClass }: { file: OpenFile; query: string; matchCase: boolean; onClass: (name: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => file.text.split('\n'), [file.text])
  const tokens = useMemo(() => {
    const highlight = /\.(java|kt)$/.test(file.path) && lines.length <= MAX_HIGHLIGHT_LINES
    if (!highlight) return null
    let inComment = false
    return lines.map((line) => {
      const out = highlightJava(line, inComment)
      inComment = Boolean(out.inComment)
      return out
    })
  }, [file.path, lines])

  useEffect(() => {
    const view = ref.current
    if (!view) return
    if (!file.line) {
      view.scrollTop = 0
      return
    }
    const row = view.querySelector<HTMLElement>(`[data-line="${file.line}"]`)
    if (row) view.scrollTop = Math.max(0, row.offsetTop - view.clientHeight / 3)
  }, [file])

  return (
    <div className="code-source scroll" ref={ref}>
      {lines.map((line, i) => (
        <div key={i} data-line={i + 1} className={file.line === i + 1 ? 'code-line on' : 'code-line'}>
          <span className="ln">{i + 1}</span>
          <span className="code-text">
            {tokens
              ? tokens[i].map((token, j) =>
                  token.kind === 'type' ? (
                    <span
                      key={j}
                      className="tok-type link"
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey) onClass(token.text)
                      }}
                    >
                      {mark(token.text, query, matchCase)}
                    </span>
                  ) : (
                    <span key={j} className={token.kind ? `tok-${token.kind}` : undefined}>
                      {mark(token.text, query, matchCase)}
                    </span>
                  ),
                )
              : mark(line, query, matchCase)}
          </span>
        </div>
      ))}
    </div>
  )
}

/** [text] with every [query] wrapped in <mark>. Matches that span two tokens are not marked. */
function mark(text: string, query: string, matchCase: boolean): ReactNode {
  if (!query || query.length < 2) return text
  const hay = matchCase ? text : text.toLowerCase()
  const needle = matchCase ? query : query.toLowerCase()
  let at = hay.indexOf(needle)
  if (at < 0) return text
  const parts: ReactNode[] = []
  let from = 0
  while (at >= 0) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
    at = hay.indexOf(needle, from)
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}
