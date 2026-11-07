import type { TlsFailure } from '../../shared'

export function Refused({ list }: { list: TlsFailure[] }) {
  const byHost = new Map<string, { count: number; cause: string; last: number }>()
  for (const f of list) {
    const prev = byHost.get(f.host)
    byHost.set(f.host, { count: (prev?.count ?? 0) + 1, cause: f.cause, last: f.at })
  }
  return (
    <div className="refused scroll">
      <p className="muted">
        These hosts refused our certificate, so their traffic could not be read. That usually means the app pins its
        certificate. Pinning bypass (Frida) comes in a later version.
      </p>
      <table className="headers">
        <tbody>
          {[...byHost].sort((a, b) => b[1].last - a[1].last).map(([host, v]) => (
            <tr key={host}>
              <td>{host}</td>
              <td>
                {v.count}× {v.cause}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
