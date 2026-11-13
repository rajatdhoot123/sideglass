/** Pure helpers for the Code tab: a small Java tokenizer, class lookup, and the file tree. */

export type TokenKind = 'kw' | 'type' | 'str' | 'com' | 'num' | 'ann' | undefined
export interface Token {
  text: string
  kind: TokenKind
}

const KEYWORDS = new Set(
  (
    'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if ' +
    'implements import instanceof int interface long native new package private protected public return short static strictfp super switch ' +
    'synchronized this throw throws transient try void volatile while var record yield true false null'
  ).split(' '),
)

/**
 * One line of Java (or Kotlin-ish) source split into tokens. Block comments that span lines
 * are tracked by the caller through [inComment].
 */
export function highlightJava(line: string, inComment = false): Token[] & { inComment?: boolean } {
  const out: Token[] & { inComment?: boolean } = []
  let i = 0
  let plain = ''
  const flush = () => {
    if (plain) out.push({ text: plain, kind: undefined })
    plain = ''
  }
  const push = (text: string, kind: TokenKind) => {
    flush()
    out.push({ text, kind })
  }
  if (inComment) {
    const end = line.indexOf('*/')
    if (end < 0) {
      out.push({ text: line, kind: 'com' })
      out.inComment = true
      return out
    }
    push(line.slice(0, end + 2), 'com')
    i = end + 2
  }
  while (i < line.length) {
    const c = line[i]
    if (c === '/' && line[i + 1] === '/') {
      push(line.slice(i), 'com')
      i = line.length
    } else if (c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2)
      if (end < 0) {
        push(line.slice(i), 'com')
        out.inComment = true
        return out
      }
      push(line.slice(i, end + 2), 'com')
      i = end + 2
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1
      push(line.slice(i, j + 1), 'str')
      i = j + 1
    } else if (c === '@' && /[A-Za-z]/.test(line[i + 1] ?? '')) {
      const m = /^@[\w.]+/.exec(line.slice(i))!
      push(m[0], 'ann')
      i += m[0].length
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[\w$]+/.exec(line.slice(i))!
      const word = m[0]
      if (KEYWORDS.has(word)) push(word, 'kw')
      else if (/^[A-Z][\w$]*[a-z][\w$]*$/.test(word)) push(word, 'type')
      else plain += word
      i += word.length
    } else if (/\d/.test(c) && !/[\w$]/.test(line[i - 1] ?? '')) {
      const m = /^(0x[\da-fA-F_]+|[\d_]+(\.\d+)?([eE][+-]?\d+)?)[lLfFdD]?/.exec(line.slice(i))!
      push(m[0], 'num')
      i += m[0].length
    } else {
      plain += c
      i++
    }
  }
  flush()
  return out
}

/**
 * The file for a class name clicked in [source]: an explicit import, then the same package,
 * then the only class anywhere with that simple name.
 */
export function classPathFor(name: string, source: string, currentFile: string, files: string[]): string | null {
  const imported = new RegExp(`^import\\s+([\\w.$]+\\.${name.replace(/\$/g, '\\$')})\\s*;`, 'm').exec(source)?.[1]
  const has = new Set(files)
  if (imported) {
    const path = `sources/${imported.replace(/\./g, '/')}.java`
    if (has.has(path)) return path
  }
  const dir = currentFile.slice(0, currentFile.lastIndexOf('/') + 1)
  if (has.has(`${dir}${name}.java`)) return `${dir}${name}.java`
  const suffix = `/${name}.java`
  const matches = files.filter((f) => f.startsWith('sources/') && f.endsWith(suffix))
  return matches.length === 1 ? matches[0] : null
}

export interface TreeNode {
  /** Shown name; single-child folder chains are joined with "/" (compact packages). */
  name: string
  /** Full path for files and folders. */
  path: string
  children?: TreeNode[]
}

export function buildTree(files: string[]): TreeNode[] {
  interface Dir {
    dirs: Map<string, Dir>
    files: string[]
  }
  const root: Dir = { dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part)
      if (!next) {
        next = { dirs: new Map(), files: [] }
        dir.dirs.set(part, next)
      }
      dir = next
    }
    dir.files.push(parts[parts.length - 1])
  }
  const toNodes = (dir: Dir, prefix: string): TreeNode[] => {
    const folders = [...dir.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => {
        let label = name
        let path = prefix + name
        let node = child
        // Compact a chain like com/example/app into one row.
        while (node.files.length === 0 && node.dirs.size === 1) {
          const [nextName, nextDir] = [...node.dirs.entries()][0]
          label += `/${nextName}`
          path += `/${nextName}`
          node = nextDir
        }
        return { name: label, path, children: toNodes(node, `${path}/`) }
      })
    const leaves = dir.files.sort((a, b) => a.localeCompare(b)).map((name) => ({ name, path: prefix + name }))
    return [...folders, ...leaves]
  }
  return toNodes(root, '')
}
