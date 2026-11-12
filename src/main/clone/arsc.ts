import { replacePoolStrings } from './axml'

/**
 * The resource table (resources.arsc) names its package. A normal build names it after the
 * application id, and code such as Firebase looks resources up by package name
 * (getIdentifier("google_app_id", "string", getPackageName())). A clone has to carry the new
 * name there too, or those lookups find nothing.
 *
 * String values live in the table's global pool. A manifest authority stored as @string/auth
 * is that pool entry; rewriting only the manifest leaves getString() on the original provider.
 */

const TABLE = 0x0002
const STRING_POOL = 0x0001
const PACKAGE = 0x0200
const TYPE = 0x0201
/** ResTable_package.name is char16_t[128]. */
const NAME_CHARS = 128
const NO_ENTRY = 0xffffffff
const NO_ENTRY16 = 0xffff
const FLAG_SPARSE = 0x01
const FLAG_OFFSET16 = 0x02
const ENTRY_COMPLEX = 0x0001
const ENTRY_COMPACT = 0x0008
const VALUE_STRING = 0x03

/** A copy of [arsc] with packages named [oldPkg] renamed to [newPkg], or null if none is. */
export function renameResourcePackage(arsc: Buffer, oldPkg: string, newPkg: string): Buffer | null {
  if (arsc.length < 12 || arsc.readUInt16LE(0) !== TABLE) throw new Error('Not a resources.arsc file')
  if (newPkg.length >= NAME_CHARS) throw new Error('Package name too long for the resource table')
  const out = Buffer.from(arsc)
  let renamed = false
  let at = arsc.readUInt16LE(2)
  while (at + 8 <= arsc.length) {
    const type = arsc.readUInt16LE(at)
    const size = arsc.readUInt32LE(at + 4)
    if (size < 8) break
    if (type === PACKAGE) {
      const field = at + 12
      const name = arsc.toString('utf16le', field, field + NAME_CHARS * 2).split('\0')[0]
      if (name === oldPkg) {
        out.fill(0, field, field + NAME_CHARS * 2)
        out.write(newPkg, field, 'utf16le')
        renamed = true
      }
    }
    at += size
  }
  return renamed ? out : null
}

function walk(buf: Buffer, start: number, end: number, fn: (at: number, type: number, headerSize: number, size: number) => void) {
  let at = start
  while (at + 8 <= end) {
    const type = buf.readUInt16LE(at)
    const headerSize = buf.readUInt16LE(at + 2)
    const size = buf.readUInt32LE(at + 4)
    if (size < 8 || at + size > buf.length) break
    fn(at, type, headerSize, size)
    at += size
  }
}

/** Byte offset of an entry inside its type chunk, or null when this config has no such entry. */
function entryOffset(buf: Buffer, chunkAt: number, headerSize: number, flags: number, entryCount: number, entryId: number): number | null {
  if (flags & FLAG_SPARSE) {
    const base = chunkAt + headerSize
    for (let i = 0; i < entryCount; i++) {
      const pos = base + i * 4
      if (pos + 4 > buf.length) return null
      if (buf.readUInt16LE(pos) === entryId) return buf.readUInt16LE(pos + 2) * 4
    }
    return null
  }
  if (entryId >= entryCount) return null
  if (flags & FLAG_OFFSET16) {
    const pos = chunkAt + headerSize + entryId * 2
    if (pos + 2 > buf.length) return null
    const off = buf.readUInt16LE(pos)
    return off === NO_ENTRY16 ? null : off * 4
  }
  const pos = chunkAt + headerSize + entryId * 4
  if (pos + 4 > buf.length) return null
  const off = buf.readUInt32LE(pos)
  return off === NO_ENTRY ? null : off
}

/** Global string-pool indexes holding the value of [id] (one per configuration). */
function stringIndexes(arsc: Buffer, id: number): number[] {
  const pkg = (id >>> 24) & 0xff
  const typeId = (id >>> 16) & 0xff
  const entryId = id & 0xffff
  const found: number[] = []
  const tableEnd = Math.min(arsc.length, arsc.readUInt32LE(4))
  walk(arsc, arsc.readUInt16LE(2), tableEnd, (at, type, headerSize, size) => {
    if (type !== PACKAGE || arsc.readUInt32LE(at + 8) !== pkg) return
    walk(arsc, at + headerSize, at + size, (tat, ttype, theader, tsize) => {
      if (ttype !== TYPE || theader < 20 || arsc[tat + 8] !== typeId) return
      const off = entryOffset(arsc, tat, theader, arsc[tat + 9], arsc.readUInt32LE(tat + 12), entryId)
      if (off === null) return
      const entriesStart = arsc.readUInt32LE(tat + 16)
      const entryAt = tat + entriesStart + off
      if (entryAt < tat || entryAt + 8 > tat + tsize) return
      const flags = arsc.readUInt16LE(entryAt + 2)
      if (flags & ENTRY_COMPACT) {
        if ((flags >> 8) === VALUE_STRING) found.push(arsc.readUInt32LE(entryAt + 4))
        return
      }
      const entrySize = arsc.readUInt16LE(entryAt)
      if (entrySize < 8 || entryAt + entrySize > tat + tsize) return
      if (flags & ENTRY_COMPLEX) {
        if (entryAt + 16 > tat + tsize) return
        const count = arsc.readUInt32LE(entryAt + 12)
        let p = entryAt + 16
        for (let i = 0; i < count && p + 12 <= tat + tsize; i++) {
          if (arsc[p + 7] === VALUE_STRING) found.push(arsc.readUInt32LE(p + 8))
          p += 12
        }
        return
      }
      const valueAt = entryAt + entrySize
      if (valueAt + 8 <= tat + tsize && arsc[valueAt + 3] === VALUE_STRING) found.push(arsc.readUInt32LE(valueAt + 4))
    })
  })
  return found
}

/**
 * A copy of [arsc] whose string resources listed in [values] (resource id to new text) carry
 * the new text. Other pool entries, including ones that merely share a prefix, stay put.
 * Returns null when nothing changed.
 */
export function renameResourceStrings(arsc: Buffer, values: Map<number, string>): Buffer | null {
  if (!values.size) return null
  if (arsc.length < 12 || arsc.readUInt16LE(0) !== TABLE) throw new Error('Not a resources.arsc file')
  const headerSize = arsc.readUInt16LE(2)
  if (headerSize + 8 > arsc.length || arsc.readUInt16LE(headerSize) !== STRING_POOL) return null
  const byIndex = new Map<number, string>()
  for (const [id, value] of values) {
    for (const index of stringIndexes(arsc, id)) {
      const previous = byIndex.get(index)
      if (previous !== undefined && previous !== value) throw new Error(`String pool index ${index} would be renamed two ways`)
      byIndex.set(index, value)
    }
  }
  if (!byIndex.size) return null
  const poolSize = arsc.readUInt32LE(headerSize + 4)
  const pool = replacePoolStrings(Buffer.from(arsc.subarray(headerSize, headerSize + poolSize)), byIndex)
  if (!pool) return null
  const out = Buffer.concat([arsc.subarray(0, headerSize), pool, arsc.subarray(headerSize + poolSize)])
  out.writeUInt32LE(out.length, 4)
  return out
}
