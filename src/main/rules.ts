export interface ProxyRule {
  id: string
  kind: 'block' | 'mock'
  pattern: string
  status?: number
  body?: string
  contentType?: string
}

/** Host, or host plus a path prefix. `example.com/v1` matches that path and not `notexample.com`. */
export function ruleMatches(url: string, pattern: string): boolean {
  if (!pattern) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const hostPath = `${parsed.host}${parsed.pathname}`
  if (!pattern.includes('/')) return parsed.host === pattern || parsed.host.endsWith(`.${pattern}`)
  return hostPath === pattern || hostPath.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`)
}

export function findRule(rules: readonly ProxyRule[], url: string): ProxyRule | undefined {
  return rules.find((rule) => ruleMatches(url, rule.pattern))
}
