import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { shellQuote, type Adb } from './adb'
import { isPackageName } from './store/apk'

export interface StorageEntry {
  path: string
  kind: 'database' | 'prefs'
  preview: string
}

const SAFE_TABLE = /^[A-Za-z_][\w]*$/

/** How files are read: an adb shell that is root, Magisk su, or run-as for a debuggable app. */
type Access = 'shell' | 'su' | 'run-as'

/** Characters an app's own file names may use here. Anything else is skipped, never sent to a shell. */
const SAFE_PATH = /^[\w./@+-]+$/

/** A path `find` printed that is safe to read: plain characters, inside the app's folders. */
export function readablePath(path: string, pkg: string, access: Access): boolean {
  if (!SAFE_PATH.test(path) || path.split('/').includes('..')) return false
  const roots = access === 'run-as' ? ['databases/', 'shared_prefs/'] : [`/data/data/${pkg}/databases/`, `/data/data/${pkg}/shared_prefs/`]
  return roots.some((root) => path.startsWith(root))
}

async function accessFor(adb: Adb): Promise<Access> {
  if ((await adb.shell('id -u').catch(() => '')).trim() === '0') return 'shell'
  if ((await adb.su('id -u', 10_000).catch(() => '')).trim() === '0') return 'su'
  return 'run-as'
}

/** One device shell command line, run with the chosen access. */
function asAccess(access: Access, pkg: string, command: string): string {
  if (access === 'su') return `su -c ${shellQuote(command)}`
  if (access === 'run-as') return `run-as ${pkg} ${command}`
  return command
}

/** Databases and shared preferences of one app. Root can read any app; a debuggable app can be read with run-as. */
export async function readAppStorage(adb: Adb, pkg: string): Promise<StorageEntry[]> {
  if (!isPackageName(pkg)) throw new Error('Invalid package name')
  const access = await accessFor(adb)
  const files = await listFiles(adb, pkg, access)
  const entries: StorageEntry[] = []
  for (const file of files.slice(0, 20)) {
    try {
      const bytes = await pullFile(adb, pkg, file.path, access)
      entries.push({ path: file.path, kind: file.kind, preview: file.kind === 'database' ? previewDatabase(bytes) : bytes.toString('utf8').slice(0, 4000) })
    } catch (error) {
      entries.push({ path: file.path, kind: file.kind, preview: `Could not read: ${(error as Error).message}` })
    }
  }
  return entries
}

async function listFiles(adb: Adb, pkg: string, access: Access): Promise<{ path: string; kind: 'database' | 'prefs' }[]> {
  const roots = access === 'run-as' ? ['databases', 'shared_prefs'] : [`/data/data/${pkg}/databases`, `/data/data/${pkg}/shared_prefs`]
  const out = await adb.shell(`${asAccess(access, pkg, `find ${roots.join(' ')} -type f`)} 2>/dev/null`).catch(() => '')
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('.db-journal') && !line.endsWith('-wal') && !line.endsWith('-shm'))
    .filter((line) => readablePath(line, pkg, access))
    .map((path) => ({ path, kind: path.includes('shared_prefs') || path.endsWith('.xml') ? ('prefs' as const) : ('database' as const) }))
}

async function pullFile(adb: Adb, pkg: string, path: string, access: Access): Promise<Buffer> {
  if (!readablePath(path, pkg, access)) throw new Error('Unexpected path')
  // exec-out joins its arguments into one device shell line, so the path is quoted, not passed bare.
  const bytes = await adb.execBuffer(['exec-out', asAccess(access, pkg, `cat ${shellQuote(path)}`)], 20_000)
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
