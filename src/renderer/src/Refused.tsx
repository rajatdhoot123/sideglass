import type { TlsFailure } from '../../shared'

export function Refused({ list, onUnpin }: { list: TlsFailure[]; onUnpin: (pkg: string) => void }) {
  const byHost = new Map<string, { count: number; cause: string; last: number; app?: string }>()
  for (const failure of list) {
    const prev = byHost.get(failure.host)
    byHost.set(failure.host, {
      count: (prev?.count ?? 0) + 1,
      cause: failure.cause,
      last: failure.at,
      app: failure.app ?? prev?.app,
    })
  }
  return (
    <div className="refused scroll">
      <p className="muted">
        These hosts refused our certificate. On the rooted virtual phone, retry the app with unpinning and the calls
        show up under Requests. Apps that detect Frida, or that require a Play Integrity verdict, can still refuse.
      </p>
      <table className="headers">
        <tbody>
          {[...byHost].sort((a, b) => b[1].last - a[1].last).map(([host, row]) => (
            <tr key={host}>
              <td>
                {host}
                {row.app ? <div className="muted">{row.app}</div> : null}
              </td>
              <td>
                {row.count}× {row.cause}
              </td>
              <td>
                <button
                  disabled={!row.app}
                  title={row.app ? `Relaunch ${row.app} with certificate unpinning` : 'The app for this host is not known yet'}
                  onClick={() => row.app && onUnpin(row.app)}
                >
                  Retry with unpinning
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
