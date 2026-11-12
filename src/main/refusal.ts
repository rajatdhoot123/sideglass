import type { LogLine } from './logcat'

/**
 * Why an app refused to run on the capture phone. Client-side reasons can often be
 * cleared by the launch hooks; `integrity` may also mean a verdict the app's own
 * server verifies, which no client-side tool can fake.
 */
export type RefusalKind = 'integrity' | 'root' | 'emulator' | 'frida' | 'crash'

export interface Refusal {
  pkg: string
  pid: number | null
  kind: RefusalKind
  at: string
  sample: string
}

const PATTERNS: Array<[RefusalKind, RegExp]> = [
  [
    'integrity',
    /play integrity|droidguard|integrity api|integrity verdict|integrityverdict|meets_(basic|device|strong)_integrity|not certified|play protect/i,
  ],
  ['root', /rootbeer|rooted (device|phone)|device is rooted|root detect|isRooted|superuser|magisk/i],
  ['emulator', /emulator detect|detected emulator|running (on|in) an? emulator|isEmulator|qemu detect/i],
  ['frida', /frida|objection|gadget inject/i],
  ['crash', /FATAL EXCEPTION|SIGSEGV|SIGABRT|SIGBUS|beginning of crash/i],
]

/** First refusal reason found in a batch of logcat lines from the launched app. */
export function classifyRefusal(lines: LogLine[], pkg: string, pid: number | null): Refusal | null {
  for (const line of lines) {
    if (pid !== null && line.pid !== pid) continue
    for (const [kind, pattern] of PATTERNS) {
      if (pattern.test(line.message) || pattern.test(line.tag)) {
        return {
          pkg,
          pid,
          kind,
          at: line.at,
          sample: `${line.tag}: ${line.message}`.slice(0, 180),
        }
      }
    }
  }
  return null
}
