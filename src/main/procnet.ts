import { isIP } from 'node:net'

/** One row of `/proc/net/tcp` or `tcp6`. Addresses are already decoded. */
export interface GuestSocket {
  remoteIp: string
  remotePort: number
  uid: number
  established: boolean
}

export interface SeenSocket extends GuestSocket {
  firstSeen: number
  lastSeen: number
}

const APP_UID = 10_000

/** Decode the little-endian hex address from `/proc/net/tcp` (`AABBCCDD:PORT`). */
export function decodeProcAddress(token: string): { ip: string; port: number } | null {
  const split = token.lastIndexOf(':')
  if (split <= 0) return null
  const hex = token.slice(0, split)
  const port = Number.parseInt(token.slice(split + 1), 16)
  if (!Number.isFinite(port)) return null
  if (hex.length === 8) {
    const n = Number.parseInt(hex, 16)
    if (!Number.isFinite(n)) return null
    return { ip: `${n & 0xff}.${(n >> 8) & 0xff}.${(n >> 16) & 0xff}.${(n >> 24) & 0xff}`, port }
  }
  if (hex.length !== 32) return null
  const bytes: number[] = []
  for (let i = 0; i < 4; i++) {
    const word = Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16)
    if (!Number.isFinite(word)) return null
    bytes.push(word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff, (word >> 24) & 0xff)
  }
  // IPv4-mapped IPv6 (::ffff:a.b.c.d), which is how the emulator lists most sockets.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return { ip: bytes.slice(12).join('.'), port }
  }
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  return { ip: groups.join(':'), port }
}

/** Parse `cat /proc/net/tcp /proc/net/tcp6`. Header lines are skipped. */
export function parseProcNet(dump: string): GuestSocket[] {
  const rows: GuestSocket[] = []
  for (const line of dump.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 8 || !parts[0].endsWith(':')) continue
    const remote = decodeProcAddress(parts[2])
    const uid = Number(parts[7])
    if (!remote || !Number.isInteger(uid)) continue
    const state = parts[3]
    rows.push({
      remoteIp: remote.ip,
      remotePort: remote.port,
      uid,
      established: state === '01' || state === '02',
    })
  }
  return rows
}

/** `pm list packages -U` → uid to package names. */
export function parsePackageUids(text: string): Map<number, string[]> {
  const map = new Map<number, string[]>()
  for (const line of text.split('\n')) {
    const match = /^package:(\S+)\s+uid:(\d+)/.exec(line.trim())
    if (!match) continue
    const uid = Number(match[2])
    const list = map.get(uid) ?? []
    list.push(match[1])
    map.set(uid, list)
  }
  return map
}

/** Same key for a DNS answer and a `/proc` address, so IPv6 spelling does not matter. */
export function canonicalIp(ip: string): string | null {
  if (isIP(ip) === 4) return ip.split('.').map((n) => String(Number(n))).join('.')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return canonicalIp(mapped[1])
  if (isIP(ip) !== 6) return null
  let body = ip.toLowerCase()
  if (body.includes('::')) {
    const [head, tail] = body.split('::')
    const h = head ? head.split(':').filter(Boolean) : []
    const t = tail ? tail.split(':').filter(Boolean) : []
    const fill = Array(Math.max(0, 8 - h.length - t.length)).fill('0')
    body = [...h, ...fill, ...t].join(':')
  }
  const groups = body.split(':')
  if (groups.length !== 8) return null
  return groups.map((g) => g.padStart(4, '0')).join(':')
}

export function rememberSockets(prev: SeenSocket[], rows: GuestSocket[], now: number, keepMs: number): SeenSocket[] {
  const byKey = new Map<string, SeenSocket>()
  for (const socket of prev) {
    if (now - socket.lastSeen <= keepMs) byKey.set(socketKey(socket), socket)
  }
  for (const row of rows) {
    if (!row.established || row.uid < APP_UID || row.remotePort === 0) continue
    const ip = canonicalIp(row.remoteIp)
    if (!ip || ip === '0.0.0.0' || ip === '127.0.0.1') continue
    const key = `${row.uid}|${ip}|${row.remotePort}`
    const existing = byKey.get(key)
    if (existing) existing.lastSeen = now
    else byKey.set(key, { ...row, remoteIp: ip, firstSeen: now, lastSeen: now })
  }
  return [...byKey.values()]
}

function socketKey(socket: SeenSocket): string {
  return `${socket.uid}|${socket.remoteIp}|${socket.remotePort}`
}

/**
 * Which package owns a request to one of [ips] on [port] at [at].
 * The launched package wins when it has a socket there. Several unrelated apps
 * on the same address are left untagged rather than guessed.
 */
export function attributeSocket(opts: {
  ips: string[]
  port: number
  at: number
  sockets: SeenSocket[]
  uidToPkgs: Map<number, string[]>
  preferPkg?: string
}): string | undefined {
  const wanted = new Set(opts.ips.map(canonicalIp).filter((ip): ip is string => !!ip))
  if (wanted.size === 0) return
  const hits = opts.sockets.filter(
    (s) =>
      s.remotePort === opts.port &&
      wanted.has(s.remoteIp) &&
      s.firstSeen <= opts.at + 1000 &&
      s.lastSeen >= opts.at - 3000,
  )
  if (hits.length === 0) return
  const uids = [...new Set(hits.map((s) => s.uid))]
  if (opts.preferPkg) {
    for (const uid of uids) {
      if (opts.uidToPkgs.get(uid)?.includes(opts.preferPkg)) return opts.preferPkg
    }
  }
  if (uids.length !== 1) return
  const pkgs = opts.uidToPkgs.get(uids[0]) ?? []
  if (pkgs.length === 1) return pkgs[0]
  return
}
