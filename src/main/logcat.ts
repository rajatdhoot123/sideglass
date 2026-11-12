import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Adb } from './adb'

export interface LogLine {
  at: string
  pid: number
  level: string
  tag: string
  message: string
}

const LINE = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+\d+\s+([VDIWEF])\s+(.*?)\s*:\s(.*)$/

/** One `logcat -v threadtime` line, or null when the line is a continuation. */
export function parseLogLine(raw: string): LogLine | null {
  const match = LINE.exec(raw.trimEnd())
  if (!match) return null
  return { at: match[1], pid: Number(match[2]), level: match[3], tag: match[4], message: match[5] }
}

/** Streams `logcat -v threadtime` from now on, in small batches. */
export class Logcat extends EventEmitter {
  private child: ChildProcess | null = null
  private pending: LogLine[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly adb: Adb) {
    super()
  }

  start(): void {
    this.child = this.adb.spawn(['logcat', '-v', 'threadtime', '-T', '1'])
    let rest = ''
    this.child.stdout?.on('data', (d: Buffer) => {
      const lines = (rest + d.toString()).split('\n')
      rest = lines.pop() ?? ''
      for (const raw of lines) {
        const line = parseLogLine(raw)
        if (line) this.pending.push(line)
      }
    })
    this.timer = setInterval(() => {
      if (this.pending.length === 0) return
      this.emit('lines', this.pending)
      this.pending = []
    }, 250)
  }

  stop(): void {
    this.child?.kill()
    if (this.timer) clearInterval(this.timer)
  }
}
