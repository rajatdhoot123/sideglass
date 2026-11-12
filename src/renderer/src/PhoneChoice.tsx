import { useEffect, useState } from 'react'
import type { PhoneMode, Settings, UsbPhone } from '../../shared'

const OPTIONS: { id: PhoneMode; title: string; points: string[] }[] = [
  {
    id: 'virtual',
    title: 'Virtual phone',
    points: [
      'Sideglass runs its own rooted Android emulator.',
      'Full capture: every app’s HTTPS requests and responses.',
      'First run downloads about 1.5 GB.',
    ],
  },
  {
    id: 'usb',
    title: 'My phone or another emulator',
    points: [
      'Use your own Android phone (USB debugging on), or an emulator already running on this computer. No root needed.',
      'Shows every host an app talks to. HTTPS contents only for apps that trust user certificates (Chrome, your own debug builds).',
      'Google Play, licence checks and your SIM work as normal.',
    ],
  },
]

/** Choose between the virtual phone and a USB phone. Used on first run and in Settings. */
export function PhoneChoice({ initial, saveLabel, onSave }: { initial: Settings; saveLabel: string; onSave: (s: Settings) => void }) {
  const [mode, setMode] = useState<PhoneMode>(initial.phone ?? 'virtual')
  const [serial, setSerial] = useState(initial.usbSerial ?? '')
  const [phones, setPhones] = useState<UsbPhone[] | null>(null)

  const refresh = async () => {
    setPhones(null)
    setPhones(await window.api.usbPhones().catch(() => []))
  }
  useEffect(() => {
    if (mode === 'usb') void refresh()
  }, [mode])

  return (
    <div className="choice">
      <div className="choice-options">
        {OPTIONS.map((o) => (
          <button key={o.id} className={`choice-card ${mode === o.id ? 'on' : ''}`} onClick={() => setMode(o.id)}>
            <b>{o.title}</b>
            <ul>
              {o.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </button>
        ))}
      </div>
      {mode === 'usb' && (
        <div className="choice-usb">
          {phones === null && <span className="muted">Looking for phones…</span>}
          {phones?.length === 0 && (
            <span className="muted">
              No phone found. Connect it with a USB cable, turn on USB debugging (Settings → Developer options) and allow
              this computer on the phone.
            </span>
          )}
          {!!phones?.length && (
            <select value={serial} onChange={(e) => setSerial(e.target.value)}>
              <option value="">Any connected phone</option>
              {phones.map((p) => (
                <option key={p.serial} value={p.serial}>
                  {p.model} ({p.emulator ? 'emulator, ' : ''}{p.serial})
                </option>
              ))}
            </select>
          )}
          <button onClick={() => void refresh()}>↻</button>
        </div>
      )}
      <div className="choice-actions">
        <button className="primary" onClick={() => onSave({ phone: mode, usbSerial: mode === 'usb' && serial ? serial : undefined })}>
          {saveLabel}
        </button>
      </div>
    </div>
  )
}

/** Settings dialog: change the phone choice. Saving restarts the session. */
export function SettingsDialog({ initial, onClose, onSave }: { initial: Settings; onClose: () => void; onSave: (s: Settings) => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Settings</b>
          <button className="close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <h3>Phone</h3>
          <PhoneChoice initial={initial} saveLabel="Save and restart" onSave={onSave} />
        </div>
      </div>
    </div>
  )
}

/** Top-bar switcher: Sideglass's virtual phone or any connected device. Choosing one restarts the session. */
export function DeviceSwitch({ current, onSave }: { current: Settings; onSave: (s: Settings) => void }) {
  const [phones, setPhones] = useState<UsbPhone[]>([])
  const refresh = () => void window.api.usbPhones().then(setPhones, () => setPhones([]))
  useEffect(refresh, [])
  const value = current.phone === 'usb' ? `usb:${current.usbSerial ?? ''}` : 'virtual'
  const listed = phones.some((p) => `usb:${p.serial}` === value)
  return (
    <select
      className="device-switch"
      title="Which phone Sideglass watches"
      value={value}
      // Devices come and go; look again whenever the list is opened.
      onMouseDown={refresh}
      onFocus={refresh}
      onChange={(e) => {
        const next = e.target.value
        if (next === value) return
        onSave(next === 'virtual' ? { phone: 'virtual' } : { phone: 'usb', usbSerial: next.slice(4) || undefined })
      }}
    >
      <option value="virtual">Sideglass virtual phone</option>
      {current.phone === 'usb' && !listed && (
        <option value={value}>{current.usbSerial ? `${current.usbSerial} (not connected)` : 'Any connected device'}</option>
      )}
      {phones.map((p) => (
        <option key={p.serial} value={`usb:${p.serial}`}>
          {p.model} ({p.emulator ? 'emulator' : 'USB'}, {p.serial})
        </option>
      ))}
    </select>
  )
}
