/** One captured request, enough to rebuild it as a curl command or a replay. */
export interface CurlRequest {
  method: string
  url: string
  requestHeaders: Record<string, string | string[] | undefined>
  requestBody?: string
}

/**
 * Headers a replay must not copy. The transport sets the first ones again, and the captured body is
 * already decompressed, so a copied Content-Encoding would tell the server to decompress plain text.
 */
export const REPLAY_SKIP = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'content-encoding', 'x-sideglass-app'])

/** Repeated headers as one value. Cookies split over HTTP/2 frames join with `; `, everything else with `, `. */
export function joinHeader(name: string, values: string[]): string {
  return values.join(name.toLowerCase() === 'cookie' ? '; ' : ', ')
}

/** A header name is a token. A newline or space in the name would start another line when a file is read back. */
export function isHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
}

/** Control characters end a shell comment and an HTTP request line. */
export function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ')
}

export function toCurl(request: CurlRequest): string {
  const command = curlCommand(request)
  if (!request.requestBody || request.method === 'GET' || request.method === 'HEAD') return command
  // --data-binary treats a leading @ as a file path. --data-raw sends the text, including an @.
  const quoted = quote(request.requestBody)
  // One argument longer than MAX_ARG_STRLEN (128KB on Linux) never reaches curl.
  if (quoted.length <= 100_000) return `${command} --data-raw ${quoted}`
  return curlStdin(command, Buffer.from(request.requestBody))
}

/**
 * The body is base64 on stdin, then curl reads it with `--data-binary @-`.
 * It is not a curl argument, so a leading `@` is not a filename and a large body still runs.
 */
export function curlStdin(command: string, raw: Buffer): string {
  const lines: string[] = []
  const encoded = raw.toString('base64')
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76))
  const body = lines.join('\n')
  const delimiter = heredocDelimiter(body)
  return `base64 --decode <<'${delimiter}' | ${command} --data-binary @-\n${body}\n${delimiter}`
}

function curlCommand(request: CurlRequest): string {
  const parts = ['curl', '-X', quote(oneLine(request.method)), quote(oneLine(request.url))]
  for (const [name, value] of Object.entries(request.requestHeaders)) {
    if (value === undefined || !isHeaderName(name) || REPLAY_SKIP.has(name.toLowerCase())) continue
    const text = oneLine(Array.isArray(value) ? joinHeader(name, value) : value)
    if (!text) continue
    parts.push('-H', quote(`${name}: ${text}`))
  }
  return parts.join(' ')
}

function heredocDelimiter(body: string): string {
  let delimiter = 'SIDEGLASS'
  const lines = new Set(body.split('\n'))
  while (lines.has(delimiter)) delimiter += '_'
  return delimiter
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
