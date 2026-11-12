import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Adb } from './adb'
import { isPackageName } from './store/apk'

export interface StorageEntry {
  path: string
  kind: 'database' | 'prefs'
  preview: string
}

const SAFE_TABLE = /^[A-Za-z_][\w]*$/

/** Databases and shared preferences of one app. Root can read any app; a debuggable app can be read with run-as. */
export async function readAppStorage(adb: Adb, pkg: string): Promise<StorageEntry[]> {
  if (!isPackageName(pkg)) throw new Error('Invalid package name')
  const rooted = (await adb.shell('id -u')).trim() === '0'
  const files = await listFiles(adb, pkg, rooted)
  const entries: StorageEntry[] = []
  for (const file of files.slice(0, 20)) {
    try {
      const bytes = await pullFile(adb, pkg, file.path, rooted)
      entries.push({ path: file.path, kind: file.kind, preview: file.kind === 'database' ? previewDatabase(bytes) : bytes.toString('utf8').slice(0, 4000) })
    } catch (error) {
      entries.push({ path: file.path, kind: file.kind, preview: `Could not read: ${(error as Error).message}` })
    }
  }
  return entries
}

async function listFiles(adb: Adb, pkg: string, rooted: boolean): Promise<{ path: string; kind: 'database' | 'prefs' }[]> {
  const roots = rooted ? [`/data/data/${pkg}/databases`, `/data/data/${pkg}/shared_prefs`] : ['databases', 'shared_prefs']
  const command = rooted
    ? `find ${roots.join(' ')} -type f 2>/dev/null`
    : `run-as ${pkg} find ${roots.join(' ')} -type f 2>/dev/null`
  const out = await adb.shell(command).catch(() => '')
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('.db-journal') && !line.endsWith('-wal') && !line.endsWith('-shm'))
    .map((path) => ({ path, kind: path.includes('shared_prefs') || path.endsWith('.xml') ? ('prefs' as const) : ('database' as const) }))
}

async function pullFile(adb: Adb, pkg: string, path: string, rooted: boolean): Promise<Buffer> {
  if (path.includes('..') || path.includes("'") || path.includes('\n')) throw new Error('Unexpected path')
  const args = rooted ? ['exec-out', 'cat', path] : ['exec-out', 'run-as', pkg, 'cat', path]
  const bytes = await adb.execBuffer(args, 20_000)
  if (bytes.length > 8 * 1024 * 1024) throw new Error('file is larger than 8 MB')
  return bytes
}

export function previewDatabase(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'sideglass-db-'))
  const file = join(dir, 'app.db')
  try {
    writeFileSync(file, bytes)
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
      const text = tables
        .map((table) => {
          if (!SAFE_TABLE.test(table.name)) return `${table.name}: skipped`
          const rows = db.prepare(`SELECT * FROM "${table.name}" LIMIT 5`).all()
          return `${table.name}\n${JSON.stringify(rows, null, 2)}`
        })
        .join('\n\n')
      return text.slice(0, 4000) || '(no tables)'
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
