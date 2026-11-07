import type { Exchange } from './proxy'

type Headers = Record<string, string | string[] | undefined>

const pairs = (h: Headers | undefined) =>
  Object.entries(h ?? {}).flatMap(([name, v]) =>
    v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((value) => ({ name, value })),
  )

/** HAR 1.2, so captures open in Chrome DevTools, Charles, Insomnia and friends. */
export function toHar(exchanges: Exchange[]): object {
  return {
    log: {
      version: '1.2',
      creator: { name: 'build-with-me', version: '0.1.0' },
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
        }
      }),
    },
  }
}
