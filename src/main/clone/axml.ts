/**
 * Edit a compiled (binary XML) AndroidManifest.xml in place: give the app a new package name
 * and launcher label, so a copy can be installed next to the original.
 *
 * Only attribute values change. New strings are appended to the string pool, so a string that
 * several attributes share (the package name is often also a task affinity or meta-data value)
 * keeps its old value everywhere else.
 */

const XML = 0x0003
const STRING_POOL = 0x0001
const RESOURCE_MAP = 0x0180
const START_ELEMENT = 0x0102
const UTF8_FLAG = 0x100
const SORTED_FLAG = 0x1
const NO_INDEX = 0xffffffff
const TYPE_REFERENCE = 0x01
const TYPE_STRING = 0x03
const TYPE_DYNAMIC_REFERENCE = 0x07

/** android:* attributes we touch, by resource id (names can be stripped by obfuscators). */
const ATTR_IDS: Record<number, string> = {
  0x01010001: 'label',
  0x01010003: 'name',
  0x01010004: 'manageSpaceActivity',
  0x01010006: 'permission',
  0x01010007: 'readPermission',
  0x01010008: 'writePermission',
  0x0101000a: 'permissionGroup',
  0x0101000b: 'sharedUserId',
  0x01010018: 'authorities',
  0x01010202: 'targetActivity',
  0x0101027f: 'backupAgent',
}

/** Elements whose android:name is a class, which Android resolves against the manifest package. */
const COMPONENTS = new Set(['application', 'activity', 'activity-alias', 'service', 'receiver', 'provider', 'instrumentation'])
const CLASS_ATTRS = new Set(['name', 'targetActivity', 'backupAgent', 'manageSpaceActivity', 'appComponentFactory'])
const PERMISSION_DECLS = new Set(['permission', 'permission-tree', 'permission-group'])
const PERMISSION_REFS = new Set(['permission', 'readPermission', 'writePermission', 'permissionGroup'])
const USES_PERMISSION = new Set(['uses-permission', 'uses-permission-sdk-23', 'uses-permission-sdk-m'])

interface Pool {
  strings: string[]
  utf8: boolean
  flags: number
  styleCount: number
  /** Style offsets and style data, copied unchanged. */
  styleOffsets: Buffer
  styles: Buffer
  /** Byte offset where the pool chunk ends in the file. */
  end: number
}

interface Attr {
  /** Offset of the attribute record in the file. */
  offset: number
  name: string
  value: string | null
  /** A resource id, when the value is a reference such as @string/provider_authority. */
  ref: number | null
}

interface Element {
  name: string
  parent: number
  attrs: Attr[]
}

interface Doc {
  pool: Pool
  elements: Element[]
}

function readPool(buf: Buffer, start: number): Pool {
  if (buf.readUInt16LE(start) !== STRING_POOL) throw new Error('Binary manifest: string pool not found')
  const headerSize = buf.readUInt16LE(start + 2)
  const size = buf.readUInt32LE(start + 4)
  const stringCount = buf.readUInt32LE(start + 8)
  const styleCount = buf.readUInt32LE(start + 12)
  const flags = buf.readUInt32LE(start + 16)
  const stringsStart = start + buf.readUInt32LE(start + 20)
  const stylesStart = buf.readUInt32LE(start + 24)
  const utf8 = (flags & UTF8_FLAG) !== 0
  const strings: string[] = []
  for (let i = 0; i < stringCount; i++) {
    let at = stringsStart + buf.readUInt32LE(start + headerSize + i * 4)
    if (utf8) {
      // UTF-16 length, then UTF-8 byte length; each one or two bytes.
      at += buf[at] & 0x80 ? 2 : 1
      let bytes = buf[at]
      if (bytes & 0x80) bytes = ((bytes & 0x7f) << 8) | buf[at + 1]
      at += buf[at] & 0x80 ? 2 : 1
      strings.push(buf.toString('utf8', at, at + bytes))
    } else {
      let chars = buf.readUInt16LE(at)
      at += 2
      if (chars & 0x8000) {
        chars = ((chars & 0x7fff) << 16) | buf.readUInt16LE(at)
        at += 2
      }
      strings.push(buf.toString('utf16le', at, at + chars * 2))
    }
  }
  const offsetsEnd = start + headerSize + stringCount * 4
  return {
    strings,
    utf8,
    flags,
    styleCount,
    styleOffsets: Buffer.from(buf.subarray(offsetsEnd, offsetsEnd + styleCount * 4)),
    styles: styleCount ? Buffer.from(buf.subarray(start + stylesStart, start + size)) : Buffer.alloc(0),
    end: start + size,
  }
}

function encodeLength(n: number, wide: boolean): Buffer {
  if (wide) {
    if (n > 0x7fff) {
      const b = Buffer.alloc(4)
      b.writeUInt16LE(0x8000 | (n >>> 16), 0)
      b.writeUInt16LE(n & 0xffff, 2)
      return b
    }
    const b = Buffer.alloc(2)
    b.writeUInt16LE(n, 0)
    return b
  }
  if (n > 0x7fff) throw new Error('Binary manifest: string too long')
  return n > 0x7f ? Buffer.from([0x80 | (n >> 8), n & 0xff]) : Buffer.from([n])
}

function writePool(pool: Pool, strings: string[]): Buffer {
  const data: Buffer[] = []
  const offsets = Buffer.alloc(strings.length * 4)
  let at = 0
  strings.forEach((s, i) => {
    offsets.writeUInt32LE(at, i * 4)
    const bytes = pool.utf8 ? Buffer.from(s, 'utf8') : Buffer.from(s, 'utf16le')
    const parts = pool.utf8
      ? [encodeLength(s.length, false), encodeLength(bytes.length, false), bytes, Buffer.from([0])]
      : [encodeLength(s.length, true), bytes, Buffer.from([0, 0])]
    for (const p of parts) {
      data.push(p)
      at += p.length
    }
  })
  const pad = (4 - (at % 4)) % 4
  data.push(Buffer.alloc(pad))
  const stringData = Buffer.concat(data)
  const headerSize = 28
  const stringsStart = headerSize + offsets.length + pool.styleOffsets.length
  const stylesStart = pool.styleCount ? stringsStart + stringData.length : 0
  const header = Buffer.alloc(headerSize)
  const size = stringsStart + stringData.length + pool.styles.length
  header.writeUInt16LE(STRING_POOL, 0)
  header.writeUInt16LE(headerSize, 2)
  header.writeUInt32LE(size, 4)
  header.writeUInt32LE(strings.length, 8)
  header.writeUInt32LE(pool.styleCount, 12)
  // Appended strings break any sort order.
  header.writeUInt32LE(pool.flags & ~SORTED_FLAG, 16)
  header.writeUInt32LE(stringsStart, 20)
  header.writeUInt32LE(stylesStart, 24)
  return Buffer.concat([header, offsets, pool.styleOffsets, stringData, pool.styles])
}

/** A string-pool chunk. The resource table's global pool uses the same layout. */
export function stringPoolChunk(strings: string[], utf8 = true): Buffer {
  return writePool(
    { strings, utf8, flags: utf8 ? UTF8_FLAG : 0, styleCount: 0, styleOffsets: Buffer.alloc(0), styles: Buffer.alloc(0), end: 0 },
    strings,
  )
}

/** Strings in a string-pool chunk, in index order. */
export function poolStrings(chunk: Buffer): string[] {
  return readPool(chunk, 0).strings
}

/** Replace strings by index. Indexes stay valid, so resource entries that point at them do too. */
export function replacePoolStrings(chunk: Buffer, byIndex: Map<number, string>): Buffer | null {
  if (!byIndex.size) return null
  const pool = readPool(chunk, 0)
  const strings = pool.strings.slice()
  let changed = false
  for (const [index, value] of byIndex) {
    if (index < 0 || index >= strings.length) throw new Error(`String pool has no index ${index}`)
    if (strings[index] !== value) {
      strings[index] = value
      changed = true
    }
  }
  return changed ? writePool(pool, strings) : null
}

function parse(buf: Buffer): Doc {
  if (buf.readUInt16LE(0) !== XML) throw new Error('Not a binary AndroidManifest.xml')
  const pool = readPool(buf, buf.readUInt16LE(2))
  let resourceIds: number[] = []
  const elements: Element[] = []
  const stack: number[] = []
  const str = (i: number) => (i === NO_INDEX ? null : (pool.strings[i] ?? null))
  let at = pool.end
  while (at + 8 <= buf.length) {
    const type = buf.readUInt16LE(at)
    const headerSize = buf.readUInt16LE(at + 2)
    const size = buf.readUInt32LE(at + 4)
    if (size < 8) throw new Error('Binary manifest: bad chunk')
    if (type === RESOURCE_MAP) {
      resourceIds = []
      for (let p = at + headerSize; p < at + size; p += 4) resourceIds.push(buf.readUInt32LE(p))
    } else if (type === START_ELEMENT) {
      const ext = at + headerSize
      const attrStart = buf.readUInt16LE(ext + 8)
      const attrSize = buf.readUInt16LE(ext + 10)
      const attrCount = buf.readUInt16LE(ext + 12)
      const attrs: Attr[] = []
      for (let i = 0; i < attrCount; i++) {
        const offset = ext + attrStart + i * attrSize
        const nameIndex = buf.readUInt32LE(offset + 4)
        const raw = buf.readUInt32LE(offset + 8)
        const dataType = buf[offset + 15]
        const data = buf.readUInt32LE(offset + 16)
        const id = resourceIds[nameIndex]
        const name = (id !== undefined ? ATTR_IDS[id] : undefined) ?? str(nameIndex) ?? ''
        // aapt1 and `--keep-raw-values` store the source "@string/name" in rawValue while the
        // typed value is the resource id. Treating that text as the authority renames it to
        // "com.fresh.@string/name" and never asks the resource table for the real string.
        const ref = dataType === TYPE_REFERENCE || dataType === TYPE_DYNAMIC_REFERENCE ? data : null
        const rawText = raw !== NO_INDEX ? str(raw) : null
        const value = ref !== null ? null : rawText !== null ? rawText : dataType === TYPE_STRING ? str(data) : null
        attrs.push({ offset, name, value, ref })
      }
      elements.push({ name: str(buf.readUInt32LE(ext + 4)) ?? '', parent: stack.at(-1) ?? -1, attrs })
      stack.push(elements.length - 1)
    } else if (type === START_ELEMENT + 1) {
      stack.pop()
    }
    at += size
  }
  return { pool, elements }
}

/** Every element and its attribute values (string values only), for checks and tests. */
export function manifestValues(axml: Buffer): { element: string; attrs: Record<string, string | null> }[] {
  return parse(axml).elements.map((e) => ({ element: e.name, attrs: Object.fromEntries(e.attrs.map((a) => [a.name, a.value])) }))
}

/** The package name in a binary manifest. */
export function manifestPackage(axml: Buffer): string {
  const manifest = parse(axml).elements.find((e) => e.name === 'manifest')
  const pkg = manifest?.attrs.find((a) => a.name === 'package')?.value
  if (!pkg) throw new Error('The manifest has no package name')
  return pkg
}

export interface ManifestEdit {
  /** The new package name (application id). */
  pkg: string
  /** The new name shown under the launcher icon. Omit to keep it. */
  label?: string
  /** The default string value of a resource, for authorities and names given as @string references. */
  resolve?: (id: number) => string | null
}

export interface PatchResult {
  manifest: Buffer
  oldPkg: string
  /** How many labels were replaced (0 for split APKs). */
  labels: number
  /**
   * Authorities, permissions and shared user ids that were renamed, old to new. Code that has
   * the old names written in must be changed the same way, or it disagrees with the manifest.
   */
  renames: Map<string, string>
  /**
   * String resources the manifest referenced, resource id to the new text. The pool in
   * resources.arsc still has the old text until those entries are rewritten.
   */
  resources: Map<number, string>
}

/** Rename the package (and its authorities and permissions) and, optionally, the label. */
export function patchManifest(input: Buffer, edit: ManifestEdit): PatchResult {
  const doc = parse(input)
  const out = Buffer.from(input)
  const strings = doc.pool.strings.slice()
  const index = new Map<string, number>()
  const intern = (s: string) => {
    let i = index.get(s)
    if (i === undefined) {
      i = strings.length
      strings.push(s)
      index.set(s, i)
    }
    return i
  }
  const set = (attr: Attr, value: string) => {
    if (attr.value === value) return
    const i = intern(value)
    out.writeUInt32LE(i, attr.offset + 8) // raw value
    out.writeUInt16LE(8, attr.offset + 12) // Res_value size
    out[attr.offset + 14] = 0
    out[attr.offset + 15] = TYPE_STRING
    out.writeUInt32LE(i, attr.offset + 16)
  }
  // A referenced string is written into the manifest and recorded so resources.arsc can
  // change the same text. getString() and the manifest then agree.
  const resources = new Map<number, string>()
  const apply = (attr: Attr, value: string) => {
    if (attr.ref !== null) resources.set(attr.ref, value)
    set(attr, value)
  }

  const manifest = doc.elements.find((e) => e.name === 'manifest')
  const pkgAttr = manifest?.attrs.find((a) => a.name === 'package')
  const oldPkg = pkgAttr?.value
  if (!manifest || !pkgAttr || !oldPkg) throw new Error('The manifest has no package name')
  const newPkg = edit.pkg

  /** A name that must not clash with the original app's: swap the package in, or put it in front. */
  const renames = new Map<string, string>()
  const own = (value: string) => {
    const renamed = value.includes(oldPkg) ? value.split(oldPkg).join(newPkg) : `${newPkg}.${value}`
    renames.set(value, renamed)
    return renamed
  }
  /** Android reads ".Foo" and "Foo" as classes in the manifest package; the code keeps the old one. */
  const absolute = (value: string) => (value.startsWith('.') ? oldPkg + value : value.includes('.') ? value : `${oldPkg}.${value}`)

  // Permissions this app declares must be renamed, and every use of them with them.
  const permissions = new Map<string, string>()
  for (const el of doc.elements) {
    if (!PERMISSION_DECLS.has(el.name)) continue
    const attr = el.attrs.find((a) => a.name === 'name')
    const name = attr?.value ?? (attr?.ref != null ? edit.resolve?.(attr.ref) : null)
    if (name) permissions.set(name, own(name))
  }

  // Activities shown in the launcher; their own label wins over the application's.
  const launchers = new Set<number>()
  doc.elements.forEach((el) => {
    if (el.name !== 'category' || !el.attrs.some((a) => a.name === 'name' && a.value === 'android.intent.category.LAUNCHER')) return
    const filter = doc.elements[el.parent]
    if (filter?.name === 'intent-filter') launchers.add(filter.parent)
  })

  let labels = 0
  doc.elements.forEach((el, i) => {
    for (const attr of el.attrs) {
      const value = attr.value ?? (attr.ref !== null && attr.name !== 'label' ? (edit.resolve?.(attr.ref) ?? null) : null)
      if (el === manifest && attr === pkgAttr) set(attr, newPkg)
      else if (el === manifest && attr.name === 'sharedUserId' && value) apply(attr, own(value))
      else if (COMPONENTS.has(el.name) && CLASS_ATTRS.has(attr.name) && value) set(attr, absolute(value))
      else if (el.name === 'provider' && attr.name === 'authorities' && value) {
        const renamed = value.split(';').map((part) => own(part)).join(';')
        if (renamed !== value) renames.set(value, renamed)
        apply(attr, renamed)
      } else if (PERMISSION_DECLS.has(el.name) && attr.name === 'name' && value) apply(attr, permissions.get(value)!)
      else if ((PERMISSION_REFS.has(attr.name) || (USES_PERMISSION.has(el.name) && attr.name === 'name')) && value && permissions.has(value)) {
        apply(attr, permissions.get(value)!)
      } else if (
        edit.label !== undefined &&
        attr.name === 'label' &&
        (el.name === 'application' || ((el.name === 'activity' || el.name === 'activity-alias') && launchers.has(i)))
      ) {
        set(attr, edit.label)
        labels++
      }
    }
  })

  const pool = writePool(doc.pool, strings)
  const rest = out.subarray(doc.pool.end)
  const header = Buffer.from(out.subarray(0, out.readUInt16LE(2)))
  header.writeUInt32LE(header.length + pool.length + rest.length, 4)
  return { manifest: Buffer.concat([header, pool, rest]), oldPkg, labels, renames, resources }
}
