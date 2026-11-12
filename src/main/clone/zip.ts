import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * Just enough ZIP to re-pack an APK: every entry is copied byte for byte (same compression,
 * so stored resources.arsc and native libraries stay stored), except the ones replaced.
 * The APK Signing Block is dropped; zipalign and apksigner run afterwards.
 */

interface Entry {
  name: string
  versionMadeBy: number
  versionNeeded: number
  flags: number
  method: number
  time: number
  date: number
  crc: number
  compressedSize: number
  size: number
  internalAttrs: number
  externalAttrs: number
  data: Buffer
}

function entries(zip: Buffer): Entry[] {
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file')
  const count = zip.readUInt16LE(eocd + 10)
  let at = zip.readUInt32LE(eocd + 16)
  if (at === 0xffffffff) throw new Error('ZIP64 APKs are not supported')
  const list: Entry[] = []
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('Broken ZIP central directory')
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const compressedSize = zip.readUInt32LE(at + 20)
    const local = zip.readUInt32LE(at + 42)
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    list.push({
      name: zip.toString('utf8', at + 46, at + 46 + nameLength),
      versionMadeBy: zip.readUInt16LE(at + 4),
      versionNeeded: zip.readUInt16LE(at + 6),
      flags: zip.readUInt16LE(at + 8),
      method: zip.readUInt16LE(at + 10),
      time: zip.readUInt16LE(at + 12),
      date: zip.readUInt16LE(at + 14),
      crc: zip.readUInt32LE(at + 16),
      compressedSize,
      size: zip.readUInt32LE(at + 24),
      internalAttrs: zip.readUInt16LE(at + 36),
      externalAttrs: zip.readUInt32LE(at + 38),
      data: zip.subarray(dataStart, dataStart + compressedSize),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return list
}

/** Every entry name, in order. */
export function entryNames(zip: Buffer): string[] {
  return entries(zip).map((e) => e.name)
}

/** The uncompressed contents of one entry, or null if it is not there. */
export function readEntry(zip: Buffer, name: string): Buffer | null {
  const entry = entries(zip).find((e) => e.name === name)
  if (!entry) return null
  if (entry.method === 0) return Buffer.from(entry.data)
  if (entry.method === 8) return inflateRawSync(entry.data)
  throw new Error(`${name}: unsupported compression method ${entry.method}`)
}

/** v1 signature files. The new signer writes its own. */
const isSignature = (name: string) => /^META-INF\/([^/]+\.(SF|RSA|DSA|EC)|MANIFEST\.MF)$/i.test(name)

/**
 * A copy of the APK with [replace]d entries and without its old signature. A replaced entry keeps
 * its compression: Android requires resources.arsc to stay stored (uncompressed).
 */
export function repack(zip: Buffer, replace: Map<string, Buffer>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const original of entries(zip)) {
    if (isSignature(original.name)) continue
    const entry = { ...original }
    const contents = replace.get(entry.name)
    if (contents) {
      entry.method = original.method === 0 ? 0 : 8
      entry.data = entry.method === 0 ? contents : deflateRawSync(contents)
      entry.crc = crc32(contents)
      entry.size = contents.length
      entry.compressedSize = entry.data.length
    }
    // Sizes go in the local header, so no data descriptor follows the data.
    entry.flags &= ~0x8
    const name = Buffer.from(entry.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(entry.versionNeeded, 4)
    local.writeUInt16LE(entry.flags, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt16LE(entry.time, 10)
    local.writeUInt16LE(entry.date, 12)
    local.writeUInt32LE(entry.crc, 14)
    local.writeUInt32LE(entry.compressedSize, 18)
    local.writeUInt32LE(entry.size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(entry.versionMadeBy, 4)
    central.writeUInt16LE(entry.versionNeeded, 6)
    central.writeUInt16LE(entry.flags, 8)
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt16LE(entry.time, 12)
    central.writeUInt16LE(entry.date, 14)
    central.writeUInt32LE(entry.crc, 16)
    central.writeUInt32LE(entry.compressedSize, 20)
    central.writeUInt32LE(entry.size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(entry.internalAttrs, 36)
    central.writeUInt32LE(entry.externalAttrs, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, entry.data)
    centrals.push(central, name)
    offset += local.length + name.length + entry.data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(centrals.length / 2, 8)
  end.writeUInt16LE(centrals.length / 2, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
