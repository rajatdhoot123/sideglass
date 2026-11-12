import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Exchange, ExchangeSummary } from './proxy'
import { summarize } from './proxy'

interface StoredExchange extends Exchange {
  requestBytesB64?: string
  responseBytesB64?: string
}

/** One capture session on disk, so a later launch can search it and open a saved HAR-like view. */
export class History {
  private db: DatabaseSync | null = null
  readonly sessionId = `${Date.now()}`

  constructor(private readonly file: string) {}

  open(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const db = new DatabaseSync(this.file)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exchanges (
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        method TEXT,
        url TEXT,
        host TEXT,
        path TEXT,
        status INTEGER,
        app TEXT,
        json TEXT NOT NULL,
        PRIMARY KEY (session_id, id)
      );
    `)
    db.prepare('INSERT OR IGNORE INTO sessions (id, started_at) VALUES (?, ?)').run(this.sessionId, Date.now())
    this.db = db
  }

  save(exchange: Exchange): void {
    const db = this.db
    if (!db) return
    const stored = toStored(exchange)
    db.prepare(
      `INSERT INTO exchanges (id, session_id, started_at, method, url, host, path, status, app, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, id) DO UPDATE SET
         started_at = excluded.started_at,
         method = excluded.method,
         url = excluded.url,
         host = excluded.host,
         path = excluded.path,
         status = excluded.status,
         app = excluded.app,
         json = excluded.json`,
    ).run(
      exchange.id,
      this.sessionId,
      exchange.startedAt,
      exchange.method,
      exchange.url,
      exchange.host,
      exchange.path,
      exchange.status ?? null,
      exchange.app ?? null,
      JSON.stringify(stored),
    )
  }

  list(): { id: string; startedAt: number; count: number }[] {
    const db = this.db
    if (!db) return []
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.started_at AS startedAt, COUNT(e.id) AS count
         FROM sessions s LEFT JOIN exchanges e ON e.session_id = s.id
         GROUP BY s.id ORDER BY s.started_at DESC LIMIT 50`,
      )
      .all() as { id: string; startedAt: number; count: number }[]
    return rows
  }

  load(sessionId: string): ExchangeSummary[] {
    return this.select('session_id = ?', [sessionId]).map(summarize)
  }

  search(query: string): ExchangeSummary[] {
    const needle = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    return this.select(
      `? = '' OR host LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR IFNULL(app, '') LIKE ? ESCAPE '\\'`,
      [query, needle, needle, needle, needle],
    ).map(summarize)
  }

  find(id: string): Exchange | null {
    const db = this.db
    if (!db) return null
    const row = db.prepare('SELECT json FROM exchanges WHERE id = ? ORDER BY started_at DESC LIMIT 1').get(id) as { json: string } | undefined
    return row ? fromStored(row.json) : null
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  private select(where: string, params: (string | number)[]): Exchange[] {
    const db = this.db
    if (!db) return []
    const rows = db.prepare(`SELECT json FROM exchanges WHERE ${where} ORDER BY started_at DESC LIMIT 400`).all(...params) as { json: string }[]
    return rows.map((row) => fromStored(row.json))
  }
}

function toStored(exchange: Exchange): StoredExchange {
  const { requestBytes, responseBytes, ...rest } = exchange
  return {
    ...rest,
    ...(requestBytes ? { requestBytesB64: requestBytes.toString('base64') } : {}),
    ...(responseBytes ? { responseBytesB64: responseBytes.toString('base64') } : {}),
  }
}

function fromStored(json: string): Exchange {
  const stored = JSON.parse(json) as StoredExchange
  const { requestBytesB64, responseBytesB64, ...rest } = stored
  return {
    ...rest,
    ...(requestBytesB64 ? { requestBytes: Buffer.from(requestBytesB64, 'base64') } : {}),
    ...(responseBytesB64 ? { responseBytes: Buffer.from(responseBytesB64, 'base64') } : {}),
  }
}
