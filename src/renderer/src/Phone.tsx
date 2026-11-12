import { useEffect, useState } from 'react'
import type { Device, LaunchResult, PhoneMode } from '../../shared'
import { AddApp } from './AddApp'
import { CloneApp } from './CloneApp'
import { DeviceScreen, NavKeys, TypeBar } from './DeviceScreen'

/** The live phone: frames from the device; clicks and drags become taps and swipes. */
export function Phone({
  mode,
  activeDevice,
  onActiveDevice,
  onLaunched,
}: {
  mode: PhoneMode
  activeDevice: Device
  onActiveDevice: (device: Device) => void
  onLaunched: (pid: number | null, pkg?: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [lastApp, setLastApp] = useState<string | undefined>()
  const [apps, setApps] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [smsFrom, setSmsFrom] = useState('VM-HDFCBK')
  const [smsText, setSmsText] = useState('Rs.500.00 debited from A/c XX1234 on 07-11-26 to ZOMATO. UPI Ref 512345678901')
  const [dragging, setDragging] = useState(false)
  useEffect(() => void window.api.apps().then(setApps), [])
  // Long steps (such as putting Google Play on the phone for a licensed app) report progress here.
  useEffect(() => window.api.on('store-log', (line) => setStatus(line)), [])

  const showLaunch = (pkg: string, result: LaunchResult, idle: string) => {
    setLastApp(pkg)
    onActiveDevice(result.device)
    // Logcat is the capture phone. A Play-phone pid would filter it to the wrong process.
    onLaunched(result.device === 'capture' ? result.pid : null, pkg)
    setStatus(result.message ?? (result.pid ? `${pkg} running (pid ${result.pid})` : idle))
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
            setStatus(`Starting ${e.target.value}…`)
            try {
              showLaunch(e.target.value, await window.api.launch(e.target.value), `${e.target.value} did not start`)
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
        {activeDevice === 'play' && (
          <button
            onClick={() => {
              onActiveDevice('capture')
              onLaunched(null)
              setStatus('Showing the capture phone.')
            }}
          >
            Capture phone
          </button>
        )}
        <button disabled={!apps.length} title="Install a renamed copy of an app next to the original" onClick={() => setCloning(true)}>
          Clone app
        </button>
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
            // Close the dialog and open the app on the device that can run it.
            setAdding(false)
            setStatus(`Starting ${pkg}…`)
            try {
              showLaunch(pkg, await window.api.launch(pkg), `${pkg} installed; it did not start by itself`)
            } catch (error) {
              setStatus(`Could not start ${pkg}: ${(error as Error).message}`)
            }
          }}
        />
      )}
      {cloning && (
        <CloneApp
          apps={apps}
          initial={lastApp}
          onClose={() => setCloning(false)}
          onCloned={async (pkg, open) => {
            setApps(await window.api.apps())
            if (!open) return
            setCloning(false)
            setStatus(`Starting ${pkg}…`)
            try {
              showLaunch(pkg, await window.api.launch(pkg), `${pkg} installed; it did not start by itself`)
            } catch (error) {
              setStatus(`Could not start ${pkg}: ${(error as Error).message}`)
            }
          }}
        />
      )}
      <DeviceScreen device={activeDevice} />
      <NavKeys device={activeDevice} />
      <TypeBar device={activeDevice} />
      {mode === 'usb' && (
        <div className="cert-hint">
          <span className="muted">
            To see HTTPS contents for apps that allow it, install <code>Download/sideglass-ca.crt</code> on the phone as a
            CA certificate.
          </span>
          <button
            onClick={() =>
              void window.api.openCertificateSettings().catch((error: Error) => setStatus(`Could not open settings: ${error.message}`))
            }
          >
            Open phone settings
          </button>
        </div>
      )}
      {mode === 'virtual' && (
        <details className="sms">
          <summary>Send a test SMS to this phone</summary>
          <input value={smsFrom} onChange={(e) => setSmsFrom(e.target.value)} />
          <textarea value={smsText} onChange={(e) => setSmsText(e.target.value)} rows={3} />
          <button
            onClick={() =>
              void window.api.sendSms(activeDevice, smsFrom, smsText).then(
                () => setStatus('SMS sent'),
                (error: Error) => setStatus(`SMS failed: ${error.message}`),
              )
            }
          >
            Send
          </button>
        </details>
      )}
      <div className="status">{status || 'Drop an APK here to install it.'}</div>
    </section>
  )
}
