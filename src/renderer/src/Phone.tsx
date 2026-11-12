import { useEffect, useState } from 'react'
import type { Refusal, RefusalKind } from '../../shared'
import { AddApp } from './AddApp'
import { DeviceScreen, NavKeys, TypeBar } from './DeviceScreen'

const REASONS: Record<RefusalKind, string> = {
  integrity: 'an integrity check (Play Integrity or Play Protect)',
  root: 'a root check',
  emulator: 'an emulator check',
  frida: 'a hooking (Frida) check',
  crash: 'a crash',
}

/** The live phone: frames from the device; clicks and drags become taps and swipes. */
export function Phone({ onLaunched }: { onLaunched: (pid: number | null) => void }) {
  const [adding, setAdding] = useState(false)
  const [apps, setApps] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [hooksOn, setHooksOn] = useState(true)
  const [hooksStarting, setHooksStarting] = useState(false)
  const [hooksMsg, setHooksMsg] = useState('')
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [smsFrom, setSmsFrom] = useState('VM-HDFCBK')
  const [smsText, setSmsText] = useState('Rs.500.00 debited from A/c XX1234 on 07-11-26 to ZOMATO. UPI Ref 512345678901')
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    void window.api.apps().then(setApps)
    void window.api.hooksState().then((s) => {
      setHooksOn(s.enabled)
      setHooksStarting(s.starting)
    })
    return [
      window.api.on('hooks-log', (line) => setHooksMsg(line)),
      window.api.on('hooks-state', (s) => {
        setHooksOn(s.enabled)
        setHooksStarting(s.starting)
        if (!s.ready && s.message) setHooksMsg(`Hooks unavailable: ${s.message}`)
      }),
      window.api.on('app-refusal', (r) => setRefusal(r)),
    ].reduce((off, next) => {
      const prev = off
      return () => {
        prev()
        next()
      }
    })
  }, [])

  const launch = async (pkg: string) => {
    setRefusal(null)
    setStatus(`Starting ${pkg}…`)
    const result = await window.api.launch(pkg)
    onLaunched(result.pid)
    const running = result.pid
      ? `${pkg} running (pid ${result.pid})${result.hooked ? ', with hooks' : ''}`
      : `${pkg} did not start`
    setStatus(result.fallback ? `${running}. ${result.fallback}` : running)
  }

  const install = async (files: FileList) => {
    const paths = [...files].map((f) => window.api.pathForFile(f)).filter((p) => p.endsWith('.apk'))
    if (!paths.length) return setStatus('Drop .apk files (all split APKs of one app together).')
    setStatus(`Installing ${paths.length} APK file(s)…`)
    try {
      const out = await window.api.installApk(paths)
      setStatus(out.trim().split('\n').pop() ?? 'Installed')
      setApps(await window.api.apps())
    } catch (error) {
      setStatus(`Install failed: ${(error as Error).message}`)
    }
  }

  return (
    <section
      className={`right ${dragging ? 'drop' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void install(e.dataTransfer.files)
      }}
    >
      <div className="toolbar">
        <select
          defaultValue=""
          onChange={async (e) => {
            if (!e.target.value) return
            await launch(e.target.value)
          }}
        >
          <option value="">Launch app…</option>
          {apps.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <button
          className={hooksOn ? 'on' : ''}
          title="Start apps through Frida: trust the Sideglass CA, drop certificate pinning, hide root and emulator checks, rewrite locally-read integrity verdicts"
          onClick={async () => {
            const s = await window.api.setHooks(!hooksOn)
            setHooksOn(s.enabled)
            setHooksStarting(s.starting)
          }}
        >
          Hooks {hooksOn ? (hooksStarting ? 'starting…' : 'on') : 'off'}
        </button>
        <button onClick={() => void window.api.apps().then(setApps)}>↻</button>
        <button className="primary" onClick={() => setAdding(true)}>
          + Add app
        </button>
      </div>
      {refusal && (
        <div className="banner needs-user">
          <strong>{refusal.pkg} refused to run</strong> — {REASONS[refusal.kind]}. What it did before the check is
          still captured
          {refusal.kind === 'integrity' ? '; a verdict its own server verifies cannot be unlocked from here' : ''}.{' '}
          <span className="muted">{refusal.sample}</span>
        </div>
      )}
      {adding && (
        <AddApp
          onClose={() => setAdding(false)}
          onInstalled={async (pkg, open) => {
            setApps(await window.api.apps())
            if (!pkg || !open) return
            // Hand back to the capture phone: close the dialog and open the new app.
            setAdding(false)
            await launch(pkg)
          }}
        />
      )}
      <DeviceScreen device="capture" />
      <NavKeys device="capture" />
      <TypeBar device="capture" />
      <details className="sms">
        <summary>Send a test SMS</summary>
        <input value={smsFrom} onChange={(e) => setSmsFrom(e.target.value)} />
        <textarea value={smsText} onChange={(e) => setSmsText(e.target.value)} rows={3} />
        <button onClick={() => void window.api.sendSms(smsFrom, smsText).then(() => setStatus('SMS sent'))}>Send</button>
      </details>
      <div className="status">{status || hooksMsg || 'Drop an APK here to install it.'}</div>
    </section>
  )
}
