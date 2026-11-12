import type { Exchange } from './proxy'
import type { PhoneInput } from './timeline'

type Headers = Record<string, string | string[] | undefined>

const pairs = (h: Headers | undefined) =>
  Object.entries(h ?? {}).flatMap(([name, v]) =>
    v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((value) => ({ name, value })),
  )

/** HAR 1.2, so captures open in Chrome DevTools, Charles, Insomnia and friends. */
export function toHar(exchanges: Exchange[], inputs: PhoneInput[] = []): object {
  return {
    log: {
      version: '1.2',
      creator: { name: 'sideglass', version: '0.1.0' },
      _sideglass: {
        inputs: inputs.map(({ id, at, device, kind, label }) => ({ id, at, device, kind, label })),
      },
      entries: exchanges.map((e) => {
        const url = new URL(e.url)
        return {
          startedDateTime: new Date(e.startedAt).toISOString(),
          time: e.durationMs ?? 0,
          request: {
            method: e.method,
            url: e.url,
            httpVersion: `HTTP/${e.httpVersion}`,
            headers: pairs(e.requestHeaders),
            queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
            cookies: [],
            headersSize: -1,
            bodySize: e.requestBodySize,
            ...(e.requestBody
              ? { postData: { mimeType: String(e.requestHeaders['content-type'] ?? ''), text: e.requestBody } }
              : {}),
          },
          response: {
            status: e.status ?? 0,
            statusText: e.statusMessage ?? '',
            httpVersion: `HTTP/${e.httpVersion}`,
            headers: pairs(e.responseHeaders),
            cookies: [],
            content: { size: e.responseBodySize ?? 0, mimeType: e.contentType ?? '', text: e.responseBody ?? '' },
            redirectURL: '',
            headersSize: -1,
            bodySize: e.responseBodySize ?? -1,
          },
          cache: {},
          timings: { send: 0, wait: e.durationMs ?? 0, receive: 0 },
          _sideglass: { app: e.app, inputId: e.inputId },
        }
      }),
    },
  }
}

interface HarHeader {
  name: string
  value: string
}
interface HarEntry {
  startedDateTime?: string
  time?: number
  request?: {
    method?: string
    url?: string
    httpVersion?: string
    headers?: HarHeader[]
    bodySize?: number
    postData?: { text?: string }
  }
  response?: {
    status?: number
    statusText?: string
    headers?: HarHeader[]
    content?: { size?: number; mimeType?: string; text?: string }
  }
  _sideglass?: { app?: string; inputId?: string }
}

/** Entries from a HAR 1.2 file, so an exported capture can be opened again. */
export function fromHar(text: string): Exchange[] {
  const parsed = JSON.parse(text) as { log?: { entries?: HarEntry[] } }
  return (parsed.log?.entries ?? []).map((entry, index) => {
    const url = entry.request?.url ?? ''
    let host = ''
    let path = url
    try {
      const parsedUrl = new URL(url)
      host = parsedUrl.host
      path = parsedUrl.pathname + parsedUrl.search
    } catch {
      // Keep the raw URL when it is not absolute.
    }
    const requestBody = entry.request?.postData?.text
    return {
      id: `har-${index}-${entry.startedDateTime ?? index}`,
      startedAt: Date.parse(entry.startedDateTime ?? '') || Date.now(),
      method: entry.request?.method ?? 'GET',
      url,
      host,
      path,
      httpVersion: (entry.request?.httpVersion ?? 'HTTP/1.1').replace(/^HTTP\//, ''),
      requestHeaders: Object.fromEntries((entry.request?.headers ?? []).map((header) => [header.name, header.value])),
      requestBody,
      requestBodySize: entry.request?.bodySize ?? requestBody?.length ?? 0,
      status: entry.response?.status,
      statusMessage: entry.response?.statusText,
      responseHeaders: Object.fromEntries((entry.response?.headers ?? []).map((header) => [header.name, header.value])),
      responseBody: entry.response?.content?.text,
      responseBodySize: entry.response?.content?.size,
      durationMs: entry.time,
      state: 'done',
      contentType: entry.response?.content?.mimeType,
      app: entry._sideglass?.app,
      inputId: entry._sideglass?.inputId,
    }
  })
}
