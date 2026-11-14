import { useEffect, useMemo, useState } from 'react'
import type { Device, ExchangeSummary, LogLine, PhoneInput, Progress, Settings, TlsFailure } from '../../shared'
import { DeviceSwitch, PhoneChoice, SettingsDialog } from './PhoneChoice'
import { Phone } from './Phone'
import { Requests } from './Requests'
import { Logs } from './Logs'
import { Refused } from './Refused'
import { Setup } from './Setup'
import { Storage } from './Storage'
import { Code, type CodeRequest } from './Code'
import { Timeline } from './Timeline'
import { WatchersButton } from './Watch'

type Tab = 'requests' | 'timeline' | 'logs' | 'refused' | 'storage' | 'code'

export function App() {
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [setupLog, setSetupLog] = useState<string[]>([])
  const [exchanges, setExchanges] = useState<Map<string, ExchangeSummary>>(new Map())
  const [refused, setRefused] = useState<TlsFailure[]>([])
  const [logs, setLogs] = useState<LogLine[]>([])
  const [inputs, setInputs] = useState<PhoneInput[]>([])
  const [tab, setTab] = useState<Tab>('requests')
  const [appPid, setAppPid] = useState<number | null>(null)
  const [focusApp, setFocusApp] = useState<string | null>(null)
  /** null until loaded; no `phone` yet means first run: ask. */
  const [settings, setSettings] = useState<Settings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [activeDevice, setActiveDevice] = useState<Device>('capture')
  const [unpinRequest, setUnpinRequest] = useState<{ pkg: string; n: number } | null>(null)
  const [protoTypes, setProtoTypes] = useState<string[]>([])
  const [archive, setArchive] = useState<ExchangeSummary[] | null>(null)
  const [codeRequest, setCodeRequest] = useState<CodeRequest | null>(null)
  const ready = progress.ready?.state === 'done'

  /** Save the phone choice and start a fresh session with it. */
  const choose = async (next: Settings) => {
    const saved = await window.api.saveSettings(next)
    setShowSettings(false)
    setProgress({})
    setSetupLog([])
    setExchanges(new Map())
    setRefused([])
    setLogs([])
    setInputs([])
    setAppPid(null)
    setFocusApp(null)
    setActiveDevice('capture')
    setSettings(saved)
    void window.api.start()
  }

  useEffect(() => {
    const offs = [
      window.api.on('progress', (p) => setProgress((prev) => ({ ...prev, [p.step]: p }))),
      window.api.on('setup-log', (line) => setSetupLog((prev) => [...prev.slice(-200), line])),
      window.api.on('exchanges', (batch) =>
        setExchanges((prev) => {
          const next = new Map(prev)
          for (const e of batch) next.set(e.id, e)
          return next
        }),
      ),
      window.api.on('tls-failure', (f) =>
        setRefused((prev) => {
          const index = prev.findIndex((row) => row.id === f.id)
          if (index === -1) return [...prev.slice(-999), f]
          const next = prev.slice()
          next[index] = f
          return next
        }),
      ),
      window.api.on('logcat', (lines) => setLogs((prev) => [...prev, ...lines].slice(-5000))),
      window.api.on('input', (input) =>
        setInputs((prev) => {
          const index = prev.findIndex((row) => row.id === input.id)
          if (index === -1) return [...prev, input].slice(-2000)
          const next = prev.slice()
          next[index] = input
          return next
        }),
      ),
    ]
    void window.api.settings().then((s) => {
      setSettings(s)
      if (s.phone) void window.api.start()
    })
    return () => offs.forEach((off) => off())
  }, [])

  const list = useMemo(() => [...exchanges.values()], [exchanges])

  if (!settings) return null
  if (!settings.phone) {
    return (
      <div className="setup">
        <h1>Sideglass</h1>
        <p className="muted">Which phone should Sideglass watch? You can change this later in Settings.</p>
        <PhoneChoice initial={settings} saveLabel="Continue" onSave={(s) => void choose(s)} />
      </div>
    )
  }
  const dialog = showSettings && (
    <SettingsDialog initial={settings} onClose={() => setShowSettings(false)} onSave={(s) => void choose(s)} />
  )
  if (!ready) {
    return (
      <>
        <Setup
          mode={settings.phone}
          progress={progress}
          log={setupLog}
          onRetry={() => void window.api.start()}
          onChangePhone={() => setShowSettings(true)}
        />
        {dialog}
      </>
    )
  }

  return (
    <div className="app">
      <section className="left">
        <nav className="tabs">
          <button className={tab === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>
            Requests <span className="count">{list.length}</span>
          </button>
          <button className={tab === 'timeline' ? 'on' : ''} onClick={() => setTab('timeline')}>
            Timeline <span className="count">{inputs.length}</span>
          </button>
          <button className={tab === 'logs' ? 'on' : ''} onClick={() => setTab('logs')}>
            Logs
          </button>
          <button className={tab === 'refused' ? 'on' : ''} onClick={() => setTab('refused')}>
            Refused TLS <span className={refused.length ? 'count warn' : 'count'}>{refused.length}</span>
          </button>
          <button className={tab === 'storage' ? 'on' : ''} onClick={() => setTab('storage')}>
            Storage
          </button>
          <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')} title="Decompile an app and read its code">
            Code
          </button>
          <div className="spacer" />
          <DeviceSwitch current={settings} onSave={(s) => void choose(s)} />
          <WatchersButton />
          <button
            onClick={async () => {
              await window.api.clear()
              setExchanges(new Map())
              setRefused([])
              setLogs([])
              setInputs([])
            }}
          >
            Clear
          </button>
          <button title="Every request as HAR, including ones the filter hides. To save a filtered set, use Save on Requests." onClick={() => void window.api.exportHar()}>Export HAR</button>
          <button
            onClick={() =>
              void window.api.openHar().then((rows) => {
                if (!rows) return
                setArchive(rows)
                setTab('requests')
              })
            }
          >
            Open HAR
          </button>
          <button title="Settings" onClick={() => setShowSettings(true)}>
            ⚙
          </button>
        </nav>
        {tab === 'requests' && (
          <Requests
            list={archive ?? list}
            focusApp={focusApp}
            archived={archive != null}
            protoTypes={protoTypes}
            onLive={() => setArchive(null)}
            onArchive={setArchive}
            onLoadProto={() => void window.api.loadProto().then(setProtoTypes)}
            onFindInCode={(pkg, query) => {
              setCodeRequest({ pkg, query, n: Date.now() })
              setTab('code')
            }}
          />
        )}
        {tab === 'timeline' && <Timeline inputs={inputs} requests={list} />}
        {tab === 'logs' && <Logs lines={logs} pid={appPid} />}
        {tab === 'refused' && <Refused list={refused} onUnpin={(pkg) => setUnpinRequest({ pkg, n: Date.now() })} />}
        {tab === 'storage' && <Storage pkg={focusApp} />}
        {/* Kept mounted so the open file, tree and search survive a trip to another tab. */}
        <div className={tab === 'code' ? 'code-host' : 'code-host hidden'}>
          <Code focusApp={focusApp} request={codeRequest} />
        </div>
      </section>
      <Phone
        mode={settings.phone}
        activeDevice={activeDevice}
        unpinRequest={unpinRequest}
        onActiveDevice={setActiveDevice}
        onLaunched={(pid, pkg) => {
          setAppPid(pid)
          // USB capture is not tagged, so filtering to the package would hide every row.
          if (pkg && settings.phone === 'virtual') setFocusApp(pkg)
        }}
      />
      {dialog}
    </div>
  )
}
