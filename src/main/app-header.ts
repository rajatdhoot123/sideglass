import { isPackageName } from './store/apk'

/** Added by the Frida script. The proxy records it and removes it before the request is forwarded. */
export const APP_HEADER = 'x-sideglass-app'

/** Read and delete the Sideglass app header. Returns a package name, or nothing if it is missing or not a package. */
export function takeAppHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
  let found: string | undefined
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== APP_HEADER) continue
    const value = headers[key]
    const text = (Array.isArray(value) ? value[0] : value)?.trim()
    if (text && isPackageName(text)) found = text
    delete headers[key]
  }
  return found
}
