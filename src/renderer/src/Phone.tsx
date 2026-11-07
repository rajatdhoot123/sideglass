import { useEffect, useState } from 'react'
import type { Device } from '../../shared'
import { AddApp } from './AddApp'
import { DeviceScreen, NavKeys, TypeBar } from './DeviceScreen'

/** The live phone: frames from the device; clicks and drags become taps and swipes. */
export function Phone({
  activeDevice,
  onActiveDevice,
  onLaunched,
}: {
  activeDevice: Device
  onActiveDevice: (device: Device) => void
  onLaunched: (pid: number | null) => void
}) {
  const [adding, setAdding] = useState(false)
  const [apps, setApps] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [smsFrom, setSmsFrom] = useState('VM-HDFCBK')
  const [smsText, setSmsText] = useState('Rs.500.00 debited from A/c XX1234 on 07-11-26 to ZOMATO. UPI Ref 512345678901')
  const [dragging, setDragging] = useState(false)
  useEffect(() => void window.api.apps().then(setApps), [])

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
            setStatus(`Starting ${e.target.value}…`)
            try {
              const result = await window.api.launch(e.target.value)
              onActiveDevice(result.device)
              onLaunched(result.pid)
              setStatus(result.message ?? (result.pid ? `${e.target.value} running (pid ${result.pid})` : `${e.target.value} did not start`))
            } catch (error) {
              setStatus(`Could not start ${e.target.value}: ${(error as Error).message}`)
            }
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
          onClose={() => setAdding(false)}
          onInstalled={async (pkg, open) => {
            setApps(await window.api.apps())
            if (!pkg || !open) return
            // Close the dialog and open the app on the device that can run it.
            setAdding(false)
            setStatus(`Starting ${pkg}…`)
            try {
              const result = await window.api.launch(pkg)
              onActiveDevice(result.device)
              onLaunched(result.pid)
              setStatus(result.message ?? (result.pid ? `${pkg} running (pid ${result.pid})` : `${pkg} installed; it did not start by itself`))
            } catch (error) {
              setStatus(`Could not start ${pkg}: ${(error as Error).message}`)
            }
          }}
        />
      )}
      <DeviceScreen device={activeDevice} />
      <NavKeys device={activeDevice} />
      <TypeBar device={activeDevice} />
      <details className="sms">
        <summary>Send a test SMS</summary>
        <input value={smsFrom} onChange={(e) => setSmsFrom(e.target.value)} />
        <textarea value={smsText} onChange={(e) => setSmsText(e.target.value)} rows={3} />
        <button onClick={() => void window.api.sendSms(smsFrom, smsText).then(() => setStatus('SMS sent'))}>Send</button>
      </details>
      <div className="status">{status || 'Drop an APK here to install it.'}</div>
    </section>
  )
}
