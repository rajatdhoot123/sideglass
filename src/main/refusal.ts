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

// Crash is first so a fatal line in the same batch outranks a weaker integrity mention.
// Success tokens (MEETS_*_INTEGRITY, a bare "frida") are not refusals.
const PATTERNS: Array<[RefusalKind, RegExp]> = [
  ['crash', /FATAL EXCEPTION|SIGSEGV|SIGABRT|SIGBUS|beginning of crash/i],
  [
    'integrity',
    /UNEVALUATED|integrity check failed|integrity verification failed|device integrity (?:is )?(?:missing|empty|failed)|verdict (?:is )?(?:missing|empty|failed)|no device integrity|not certified/i,
  ],
  [
    'root',
    /rooted (?:device|phone)|device is rooted|root detected|(?:^|\W)isRooted(?:\(\))?\s*[:=]?\s*true|su binary (?:was )?found|magisk (?:was )?(?:found|detected)/i,
  ],
  [
    'emulator',
    /emulator detect|detected emulator|running (?:on|in) an? emulator|(?:^|\W)isEmulator(?:\(\))?\s*[:=]?\s*true|qemu detect/i,
  ],
  ['frida', /\bobjection\b|gadget inject|frida(?:-server)? (?:was )?(?:detected|found|injected)/i],
]

/** Highest-priority refusal in this batch. A crash outranks an earlier integrity line. */
export function classifyRefusal(lines: LogLine[], pkg: string, pid: number | null): Refusal | null {
  const scoped = pid === null ? lines : lines.filter((line) => line.pid === pid)
  for (const [kind, pattern] of PATTERNS) {
    for (const line of scoped) {
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
