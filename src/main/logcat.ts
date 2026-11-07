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
        const m = LINE.exec(raw.trimEnd())
        if (m) this.pending.push({ at: m[1], pid: Number(m[2]), level: m[3], tag: m[4], message: m[5] })
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
