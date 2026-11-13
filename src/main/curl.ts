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

export function toCurl(request: CurlRequest): string {
  const parts = ['curl', '-X', quote(request.method), quote(request.url)]
  for (const [name, value] of Object.entries(request.requestHeaders)) {
    if (value === undefined || name.startsWith(':') || REPLAY_SKIP.has(name.toLowerCase())) continue
    const text = Array.isArray(value) ? joinHeader(name, value) : value
    parts.push('-H', quote(`${name}: ${text}`))
  }
  if (request.requestBody && request.method !== 'GET' && request.method !== 'HEAD') {
    parts.push('--data-binary', quote(request.requestBody))
  }
  return parts.join(' ')
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
