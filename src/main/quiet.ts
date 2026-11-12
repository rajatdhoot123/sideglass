import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const NOISE = [
  'Unknown TLS error:',
  'Generating certificate for',
  'Cert generation error',
  'Proxying SOCKS',
  'Proxying HTTP/',
  'Unknown protocol server error',
  'Error on client socket',
  'TLS client hello data not available',
  'SSLV3_ALERT',
  'TLSV1_ALERT',
  'ERR_SSL_',
]

/** mockttp writes certificate refusals and proxy chatter straight to the console. */
export function isProxyNoise(text: string): boolean {
  return NOISE.some((line) => text.includes(line))
}

export function appendLog(file: string, line: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${line}\n`)
  } catch {
    // A log file must not take the capture session down.
  }
}

/** Send mockttp's console noise to the app log. Returns a function that restores the console. */
export function installQuietLog(file: string): () => void {
  const original = { log: console.log, warn: console.warn, error: console.error }
  const wrap =
    (fn: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const text = args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg))).join(' ')
      if (isProxyNoise(text)) {
        appendLog(file, text)
        return
      }
      fn(...args)
    }
  console.log = wrap(original.log.bind(console))
  console.warn = wrap(original.warn.bind(console))
  console.error = wrap(original.error.bind(console))
  return () => {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
}
