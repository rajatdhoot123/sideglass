import { useEffect, useState } from 'react'
import type { PhoneMode } from '../../shared'
import { AddApp } from './AddApp'
import { DeviceScreen, NavKeys, TypeBar } from './DeviceScreen'

/** The live phone: frames from the device; clicks and drags become taps and swipes. */
export function Phone({ mode, onLaunched }: { mode: PhoneMode; onLaunched: (pid: number | null) => void }) {
  const [adding, setAdding] = useState(false)
  const [apps, setApps] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [smsFrom, setSmsFrom] = useState('VM-HDFCBK')
  const [smsText, setSmsText] = useState('Rs.500.00 debited from A/c XX1234 on 07-11-26 to ZOMATO. UPI Ref 512345678901')
  const [dragging, setDragging] = useState(false)
  useEffect(() => void window.api.apps().then(setApps), [])
  // Long steps (such as putting Google Play on the phone for a licensed app) report progress here.
  useEffect(() => window.api.on('store-log', (line) => setStatus(line)), [])

  const launch = async (pkg: string, notStarted: string) => {
    setStatus(`Starting ${pkg}…`)
    try {
      const { pid, message } = await window.api.launch(pkg)
      onLaunched(pid)
      setStatus(message ?? (pid ? `${pkg} running (pid ${pid})` : notStarted))
    } catch (error) {
      setStatus(`Could not start ${pkg}: ${(error as Error).message}`)
    }
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
            await launch(e.target.value, `${e.target.value} did not start`)
          }}
        >
          <option value="">Launch app…</option>
          {apps.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <button onClick={() => void window.api.apps().then(setApps)}>↻</button>
        <button className="primary" onClick={() => setAdding(true)}>
          + Add app
        </button>
      </div>
      {adding && (
        <AddApp
          mode={mode}
          onClose={() => setAdding(false)}
          onInstalled={async (pkg, open) => {
            setApps(await window.api.apps())
            if (!pkg || !open) return
            // Hand back to the capture phone: close the dialog and open the new app.
            setAdding(false)
            await launch(pkg, `${pkg} installed; it did not start by itself`)
          }}
        />
      )}
      <DeviceScreen device="capture" />
      <NavKeys device="capture" />
      <TypeBar device="capture" />
      {mode === 'usb' && (
        <div className="cert-hint">
          <span className="muted">
            To see HTTPS contents for apps that allow it, install <code>Download/sideglass-ca.crt</code> on the phone as a
            CA certificate.
          </span>
          <button onClick={() => void window.api.openCertificateSettings()}>Open phone settings</button>
        </div>
      )}
      {mode === 'virtual' && (
        <details className="sms">
          <summary>Send a test SMS</summary>
          <input value={smsFrom} onChange={(e) => setSmsFrom(e.target.value)} />
          <textarea value={smsText} onChange={(e) => setSmsText(e.target.value)} rows={3} />
          <button onClick={() => void window.api.sendSms(smsFrom, smsText).then(() => setStatus('SMS sent'))}>Send</button>
        </details>
      )}
      <div className="status">{status || 'Drop an APK here to install it.'}</div>
    </section>
  )
}
