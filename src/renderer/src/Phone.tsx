import { useEffect, useState } from 'react'
import type { Device, LaunchResult, PhoneMode, Refusal, RefusalKind } from '../../shared'
import { AddApp } from './AddApp'
import { CloneApp } from './CloneApp'
import { DeviceScreen, NavKeys, TypeBar } from './DeviceScreen'

const REASONS: Record<RefusalKind, string> = {
  integrity: 'an integrity check (Play Integrity or Play Protect)',
  root: 'a root check',
  emulator: 'an emulator check',
  frida: 'a hooking (Frida) check',
  crash: 'a crash',
}

/** The live phone: frames from the device; clicks and drags become taps and swipes. */
export function Phone({
  mode,
  activeDevice,
  onActiveDevice,
  onLaunched,
  unpinRequest,
}: {
  mode: PhoneMode
  activeDevice: Device
  onActiveDevice: (device: Device) => void
  onLaunched: (pid: number | null, pkg?: string) => void
  /** Set when Refused TLS asks to relaunch an app with unpinning. */
  unpinRequest: { pkg: string; n: number } | null
}) {
  const [adding, setAdding] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [lastApp, setLastApp] = useState<string | undefined>()
  const [apps, setApps] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [smsFrom, setSmsFrom] = useState('VM-HDFCBK')
  const [smsText, setSmsText] = useState('Rs.500.00 debited from A/c XX1234 on 07-11-26 to ZOMATO. UPI Ref 512345678901')
  const [dragging, setDragging] = useState(false)
  const [unpin, setUnpin] = useState(false)
  const [hooksOn, setHooksOn] = useState(true)
  const [hooksStarting, setHooksStarting] = useState(false)
  const [hooksMsg, setHooksMsg] = useState('')
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  useEffect(() => void window.api.apps().then(setApps), [])
  useEffect(() => {
    const showHooks = (s: { enabled: boolean; ready: boolean; starting: boolean; message: string }) => {
      setHooksOn(s.enabled)
      setHooksStarting(s.starting)
      // Only an enabled switch that failed to start is "unavailable". Turning it off is not a failure.
      if (s.message) setHooksMsg(s.enabled && !s.ready && !s.starting ? `Hooks unavailable: ${s.message}` : s.message)
    }
    void window.api.hooksState().then(showHooks)
    return [
      window.api.on('hooks-log', (line) => setHooksMsg(line)),
      window.api.on('hooks-state', showHooks),
      window.api.on('app-refusal', (r) => setRefusal(r)),
    ].reduce((off, next) => {
      const prev = off
      return () => {
        prev()
        next()
      }
    })
  }, [])
  // Long steps (such as putting Google Play on the phone for a licensed app) report progress here.
  useEffect(() => window.api.on('store-log', (line) => setStatus(line)), [])

  const start = async (pkg: string, unpinning = unpin) => {
    setStatus(`Starting ${pkg}${unpinning ? ' with unpinning' : ''}…`)
    try {
      showLaunch(pkg, await window.api.launch(pkg, { unpin: unpinning }), `${pkg} did not start`)
    } catch (error) {
      setStatus(`Could not start ${pkg}: ${(error as Error).message}`)
    }
  }

  useEffect(() => {
    if (!unpinRequest) return
    setUnpin(true)
    void start(unpinRequest.pkg, true)
  }, [unpinRequest?.n])

  const showLaunch = (pkg: string, result: LaunchResult, idle: string) => {
    setLastApp(pkg)
    setRefusal(null)
    onActiveDevice(result.device)
    // Logcat is the capture phone. A Play-phone pid would filter it to the wrong process.
    onLaunched(result.device === 'capture' ? result.pid : null, pkg)
    const running = result.pid ? `${pkg} running (pid ${result.pid})${result.hooked ? ', with hooks' : ''}` : idle
    setStatus(result.message ? `${running}. ${result.message}` : running)
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
          title="Opens an installed app. With Hooks on, tapping its icon on the phone does the same."
          onChange={(e) => {
            if (e.target.value) void start(e.target.value)
          }}
        >
          <option value="">Launch app…</option>
          {apps.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        {mode === 'virtual' && (
          <button
            className={hooksOn ? 'on' : ''}
            title="Hook every app as it opens, including from its icon. Trusts the Sideglass CA, drops certificate pinning, hides root and emulator checks, and rewrites integrity verdicts the app reads locally. Close an already-open app once so it starts fresh."
            onClick={async () => {
              const s = await window.api.setHooks(!hooksOn)
              setHooksOn(s.enabled)
              setHooksStarting(s.starting)
            }}
          >
            Hooks {hooksOn ? (hooksStarting ? 'starting…' : 'on') : 'off'}
          </button>
        )}
        <label title="Spawn the next app with the unpinning script when Hooks are off. Needs the rooted virtual phone.">
          <input type="checkbox" checked={unpin} onChange={(e) => setUnpin(e.target.checked)} />
          Unpin
        </label>
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
      {refusal && (
        <div className="banner needs-user">
          <strong>{refusal.pkg} refused to run</strong> — {REASONS[refusal.kind]}. What it did before the check is still
          captured
          {refusal.kind === 'integrity' ? '; a verdict its own server verifies cannot be unlocked from here' : ''}.{' '}
          <span className="muted">{refusal.sample}</span>
        </div>
      )}
      {adding && (
        <AddApp
          mode={mode}
          onClose={() => setAdding(false)}
          onInstalled={async (pkg, open) => {
            setApps(await window.api.apps())
            if (!pkg || !open) return
            // Close the dialog and open the app on the device that can run it.
            setAdding(false)
            void start(pkg)
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
      <div className="status">
        {status && hooksMsg && !status.includes(hooksMsg)
          ? `${status} — ${hooksMsg}`
          : status || hooksMsg || 'Drop an APK here to install it.'}
      </div>
    </section>
  )
}
