import type { Progress } from '../../shared'

const STEPS: [string, string][] = [
  ['sdk', 'Find Android SDK'],
  ['ca', 'Local certificate'],
  ['proxy', 'Capture proxy'],
  ['avd', 'Virtual phone'],
  ['boot', 'Boot'],
  ['root', 'Root access'],
  ['trust', 'Trust certificate'],
]

export function Setup({ progress, log, onRetry }: { progress: Record<string, Progress>; log: string[]; onRetry: () => void }) {
  const failed = Object.values(progress).find((p) => p.state === 'failed')
  return (
    <div className="setup">
      <h1>Sideglass</h1>
      <p className="muted">Setting up a private virtual phone that shows every API call its apps make.</p>
      <ol className="steps">
        {STEPS.map(([id, label]) => {
          const p = progress[id]
          return (
            <li key={id} className={p?.state ?? 'waiting'}>
              <span className="dot" /> {label}
              {p?.state === 'failed' && <div className="error">{p.message}</div>}
            </li>
          )
        })}
      </ol>
      {failed && <button onClick={onRetry}>Try again</button>}
      <pre className="setup-log">{log.slice(-12).join('\n')}</pre>
    </div>
  )
}
