/**
 * What to search the decompiled app for, given a captured URL.
 *
 * Apps rarely write a full URL into their code. Retrofit and similar keep a base URL and
 * relative paths such as "v1/users/{id}/posts", so IDs in the captured path never match.
 * Pick the longest run of path segments that looks written by hand (no numbers, UUIDs or
 * long tokens), which is what an annotation or string constant would hold.
 */
export function codeQueryFor(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url.trim()
  }
  const segments = parsed.pathname.split('/').filter(Boolean).map((s) => safeDecode(s))
  let best: string[] = []
  let run: string[] = []
  for (const segment of segments) {
    if (looksStatic(segment)) {
      run.push(segment)
      if (run.join('/').length > best.join('/').length) best = run.slice()
    } else {
      run = []
    }
  }
  const path = best.join('/')
  // A single short word ("api", "v1") would match everywhere; the host is more telling.
  if (path.length >= 5 && !(best.length === 1 && /^(api|v\d+|rest|graphql|rpc)$/i.test(path))) return path
  return parsed.hostname
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * The pending query to run against [indexPkg], or null while the open tree is still another app.
 * A request with no package searches whatever is already open.
 */
export function pendingCodeSearch(indexPkg: string | null, requestPkg: string | null, pending: string | null): string | null {
  if (!pending || !indexPkg) return null
  if (requestPkg && requestPkg !== indexPkg) return null
  return pending
}

/** A path segment that was probably typed by a developer, not generated at runtime. */
export function looksStatic(segment: string): boolean {
  if (!segment || segment.length > 40) return false
  if (/\d{3,}/.test(segment)) return false
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment)) return false
  if (/^[A-Za-z0-9_-]{20,}$/.test(segment) && /\d/.test(segment) && /[A-Z]/.test(segment) && /[a-z]/.test(segment)) return false
  return /^[\w.:@-]+$/.test(segment)
}
