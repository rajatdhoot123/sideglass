import type { PhoneMode, Progress } from '../../shared'

const COMMON: [string, string][] = [
  ['sdk', 'Find Android SDK'],
  ['ca', 'Local certificate'],
  ['proxy', 'Capture proxy'],
]
const STEPS: Record<PhoneMode, [string, string][]> = {
  virtual: [...COMMON, ['avd', 'Virtual phone'], ['boot', 'Boot'], ['root', 'Root access'], ['trust', 'Trust certificate']],
  usb: [...COMMON, ['device', 'Find your phone'], ['route', 'Route traffic over USB'], ['trust', 'Copy certificate']],
}

export function Setup({
  mode,
  progress,
  log,
  onRetry,
  onChangePhone,
}: {
  mode: PhoneMode
  progress: Record<string, Progress>
  log: string[]
  onRetry: () => void
  onChangePhone: () => void
}) {
  const failed = Object.values(progress).find((p) => p.state === 'failed')
  return (
    <div className="setup">
      <h1>Sideglass</h1>
      <p className="muted">
        {mode === 'usb'
          ? 'Connecting to your phone to show every API call its apps make.'
          : 'Setting up a private virtual phone that shows every API call its apps make.'}
      </p>
      <ol className="steps">
        {STEPS[mode].map(([id, label]) => {
          const p = progress[id]
          return (
            <li key={id} className={p?.state ?? 'waiting'}>
              <span className="dot" /> {label}
              {p?.state === 'failed' && <div className="error">{p.message}</div>}
            </li>
          )
        })}
      </ol>
      {failed && (
        <div className="setup-actions">
          <button onClick={onRetry}>Try again</button>
          <button onClick={onChangePhone}>Change phone…</button>
        </div>
      )}
      <pre className="setup-log">{log.slice(-12).join('\n')}</pre>
    </div>
  )
}
