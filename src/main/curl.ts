/** One captured request, enough to rebuild it as a curl command or a replay. */
export interface CurlRequest {
  method: string
  url: string
  requestHeaders: Record<string, string | string[] | undefined>
  requestBody?: string
}

const SKIP = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'x-sideglass-app'])

export function toCurl(request: CurlRequest): string {
  const parts = ['curl', '-X', quote(request.method), quote(request.url)]
  for (const [name, value] of Object.entries(request.requestHeaders)) {
    if (value === undefined || name.startsWith(':') || SKIP.has(name.toLowerCase())) continue
    const text = Array.isArray(value) ? value.join(', ') : value
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
