import { useState } from 'react'
import type { ExchangeSummary, PhoneInput } from '../../shared'

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false })

/** Inputs on the phone, each opened to the requests that started within two seconds. */
export function Timeline({ inputs, requests }: { inputs: PhoneInput[]; requests: ExchangeSummary[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const ordered = [...inputs].reverse()
  return (
    <div className="timeline">
      {ordered.length === 0 && <div className="empty">Tap the phone. What you do, and the requests that follow, show up here.</div>}
      {ordered.map((input) => {
        const kids = requests.filter((r) => r.inputId === input.id)
        const shown = open === input.id
        return (
          <div key={input.id} className="tl-item">
            <button className="tl-head" onClick={() => setOpen(shown ? null : input.id)}>
              {input.shot && <img src={input.shot} alt="" />}
              <span className="tl-label">
                <b>{input.label}</b>
                <span className="muted">
                  {clock(input.at)} · {kids.length} request{kids.length === 1 ? '' : 's'}
                </span>
              </span>
            </button>
            {shown && (
              <ul className="tl-reqs">
                {kids.length === 0 && <li className="muted">No requests in the next two seconds.</li>}
                {kids.map((r) => (
                  <li key={r.id}>
                    <span className="method">{r.method}</span> {r.host}
                    {r.path}
                    {r.status ? ` · ${r.status}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
