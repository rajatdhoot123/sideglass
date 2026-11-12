export interface ProxyRule {
  id: string
  kind: 'block' | 'mock'
  pattern: string
  status?: number
  body?: string
  contentType?: string
}

export function ruleMatches(url: string, pattern: string): boolean {
  return pattern.length > 0 && url.includes(pattern)
}

export function findRule(rules: readonly ProxyRule[], url: string): ProxyRule | undefined {
  return rules.find((rule) => ruleMatches(url, rule.pattern))
}
