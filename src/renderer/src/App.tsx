import { useEffect, useMemo, useState } from 'react'
import type { ExchangeSummary, LogLine, Progress, TlsFailure } from '../../shared'
import { Phone } from './Phone'
import { Requests } from './Requests'
import { Logs } from './Logs'
import { Refused } from './Refused'
import { Setup } from './Setup'

type Tab = 'requests' | 'logs' | 'refused'

export function App() {
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [setupLog, setSetupLog] = useState<string[]>([])
  const [exchanges, setExchanges] = useState<Map<string, ExchangeSummary>>(new Map())
  const [refused, setRefused] = useState<TlsFailure[]>([])
  const [logs, setLogs] = useState<LogLine[]>([])
  const [tab, setTab] = useState<Tab>('requests')
  const [appPid, setAppPid] = useState<number | null>(null)
  const ready = progress.ready?.state === 'done'

  useEffect(() => {
    const offs = [
      window.api.on('progress', (p) => setProgress((prev) => ({ ...prev, [p.step]: p }))),
      window.api.on('setup-log', (line) => setSetupLog((prev) => [...prev.slice(-200), line])),
      window.api.on('exchange', (e) =>
        setExchanges((prev) => {
          const next = new Map(prev)
          next.set(e.id, e)
          return next
        }),
      ),
      window.api.on('tls-failure', (f) => setRefused((prev) => [...prev.slice(-999), f])),
      window.api.on('logcat', (lines) => setLogs((prev) => [...prev, ...lines].slice(-5000))),
    ]
    void window.api.start()
    return () => offs.forEach((off) => off())
  }, [])

  const list = useMemo(() => [...exchanges.values()], [exchanges])

  if (!ready) return <Setup progress={progress} log={setupLog} onRetry={() => void window.api.start()} />

  return (
    <div className="app">
      <section className="left">
        <nav className="tabs">
          <button className={tab === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>
            Requests <span className="count">{list.length}</span>
          </button>
          <button className={tab === 'logs' ? 'on' : ''} onClick={() => setTab('logs')}>
            Logs
          </button>
          <button className={tab === 'refused' ? 'on' : ''} onClick={() => setTab('refused')}>
            Refused TLS <span className={refused.length ? 'count warn' : 'count'}>{refused.length}</span>
          </button>
          <div className="spacer" />
          <button
            onClick={async () => {
              await window.api.clear()
              setExchanges(new Map())
              setRefused([])
              setLogs([])
            }}
          >
            Clear
          </button>
          <button onClick={() => void window.api.exportHar()}>Export HAR</button>
        </nav>
        {tab === 'requests' && <Requests list={list} />}
        {tab === 'logs' && <Logs lines={logs} pid={appPid} />}
        {tab === 'refused' && <Refused list={refused} />}
      </section>
      <Phone onLaunched={setAppPid} />
    </div>
  )
}
