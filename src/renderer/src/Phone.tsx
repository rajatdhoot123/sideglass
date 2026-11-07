import { useEffect, useState } from 'react'
import { AddApp } from './AddApp'
import { DeviceScreen, NavKeys, TypeBar } from './DeviceScreen'

/** The live phone: frames from the device; clicks and drags become taps and swipes. */
export function Phone({ onLaunched }: { onLaunched: (pid: number | null) => void }) {
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
            const pid = await window.api.launch(e.target.value)
            onLaunched(pid)
            setStatus(pid ? `${e.target.value} running (pid ${pid})` : `${e.target.value} did not start`)
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
          onInstalled={() => void window.api.apps().then(setApps)}
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
      <div className="status">{status || 'Drop an APK here to install it.'}</div>
    </section>
  )
}
