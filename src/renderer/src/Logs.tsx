import { useMemo, useState } from 'react'
import type { LogLine } from '../../shared'

export function Logs({ lines, pid }: { lines: LogLine[]; pid: number | null }) {
  const [filter, setFilter] = useState('')
  const [onlyApp, setOnlyApp] = useState(true)
  const [minLevel, setMinLevel] = useState('D')
  const order = 'VDIWEF'
  const shown = useMemo(() => {
    const f = filter.toLowerCase()
    return lines
      .filter((l) => !onlyApp || pid === null || l.pid === pid)
      .filter((l) => order.indexOf(l.level) >= order.indexOf(minLevel))
      .filter((l) => !f || l.tag.toLowerCase().includes(f) || l.message.toLowerCase().includes(f))
      .slice(-2000)
  }, [lines, filter, onlyApp, pid, minLevel])
  return (
    <div className="logs">
      <div className="filterbar">
        <input placeholder="Filter tag or text" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select value={minLevel} onChange={(e) => setMinLevel(e.target.value)}>
          {[...order].map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={onlyApp} onChange={(e) => setOnlyApp(e.target.checked)} disabled={pid === null} /> Only the launched app
          {pid !== null && ` (pid ${pid})`}
        </label>
      </div>
      <div className="loglines">
        {shown.map((l, i) => (
          <div key={i} className={`log ${l.level}`}>
            <span>{l.at.slice(6)}</span>
            <span>{l.level}</span>
            <span className="tag">{l.tag}</span>
            <span>{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
