import { gunzipSync, inflateSync } from 'node:zlib'

export interface ProtoField {
  field: number
  /** 0 varint, 1 64-bit, 2 length-delimited, 5 32-bit. */
  wire: 0 | 1 | 2 | 5
  value: string | ProtoField[]
}

const MAX_DEPTH = 32
const MAX_INFLATE = 8 * 1024 * 1024

/** Schema-less protobuf. Returns null when the buffer is not a message. */
export function decodeProtobuf(buf: Buffer, depth = 0): ProtoField[] | null {
  if (depth > MAX_DEPTH) return null
  const fields: ProtoField[] = []
  let o = 0
  while (o < buf.length) {
    const key = readVarint(buf, o)
    if (!key) return null
    const field = Number(key.value >> 3n)
    const wire = Number(key.value & 7n)
    if (field <= 0) return null
    o = key.next
    if (wire === 0) {
      const v = readVarint(buf, o)
      if (!v) return null
      o = v.next
      fields.push({ field, wire, value: v.value.toString() })
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4
      if (o + size > buf.length) return null
      fields.push({ field, wire, value: buf.subarray(o, o + size).toString('hex') })
      o += size
    } else if (wire === 2) {
      const len = readVarint(buf, o)
      if (!len) return null
      const n = Number(len.value)
      o = len.next
      if (!Number.isSafeInteger(n) || n < 0 || o + n > buf.length) return null
      const slice = buf.subarray(o, o + n)
      o += n
      fields.push({ field, wire, value: delimited(slice, depth) })
    } else {
      return null
    }
  }
  return fields
}

/** One uncompressed protobuf message per gRPC frame. Null when the framing is wrong. */
export function grpcFrames(buf: Buffer): Buffer[] | null {
  const frames: Buffer[] = []
  let o = 0
  while (o + 5 <= buf.length) {
    const flag = buf[o]
    const len = buf.readUInt32BE(o + 1)
    o += 5
    if (o + len > buf.length) return null
    let payload: Buffer = buf.subarray(o, o + len)
    o += len
    if (flag === 1) {
      const inflated = inflateGrpc(payload)
      if (!inflated) return null
      payload = inflated
    } else if (flag !== 0) {
      return null
    }
    frames.push(payload)
  }
  if (o !== buf.length || frames.length === 0) return null
  return frames
}

export function decodeGrpc(buf: Buffer): ProtoField[][] | null {
  const frames = grpcFrames(buf)
  if (!frames) return null
  const decoded: ProtoField[][] = []
  for (const payload of frames) {
    const fields = decodeProtobuf(payload)
    if (!fields) return null
    decoded.push(fields)
  }
  return decoded
}

export function formatFields(fields: ProtoField[], depth = 0): string {
  const pad = '  '.repeat(depth)
  return fields
    .map((f) => {
      if (Array.isArray(f.value)) {
        const inner = formatFields(f.value, depth + 1)
        return inner ? `${pad}${f.field}: {\n${inner}\n${pad}}` : `${pad}${f.field}: {}`
      }
      const text = f.wire === 2 && !f.value.startsWith('<') ? JSON.stringify(f.value) : f.value
      return `${pad}${f.field}: ${text}`
    })
    .join('\n')
}

export function presentBody(buf: Buffer, contentType: string): { text?: string; size: number } {
  const size = buf.length
  if (size === 0) return { size }
  if (size > 2 * 1024 * 1024) return { text: `<${size} bytes, too large to show>`, size }
  const type = contentType.toLowerCase()
  if (type.includes('grpc')) {
    const frames = decodeGrpc(buf)
    if (frames) {
      const text = frames.map((fields, i) => `frame ${i + 1}\n${formatFields(fields, 1)}`).join('\n')
      return { text, size }
    }
  }
  if (type.includes('protobuf')) {
    const fields = decodeProtobuf(buf)
    if (fields?.length) return { text: formatFields(fields), size }
  }
  const text = buf.toString('utf8')
  const bad = text.match(/[\u0000-\u0008\u000e-\u001f\ufffd]/g)?.length ?? 0
  if (bad > text.length * 0.05) return { text: `<binary, ${size} bytes>`, size }
  return { text, size }
}

function delimited(buf: Buffer, depth: number): string | ProtoField[] {
  if (buf.length === 0) return ''
  // A submessage starts with a field tag, which is a control byte. Printable text does not.
  if (isStrictText(buf)) return buf.toString('utf8')
  const nested = decodeProtobuf(buf, depth + 1)
  if (nested && nested.length > 0) return nested
  return buf.length <= 24 ? buf.toString('hex') : `<${buf.length} bytes>`
}

function isStrictText(buf: Buffer): boolean {
  if (buf.length === 0) return false
  for (const b of buf) {
    if (b < 32 || b === 127) return false
  }
  if (buf.some((b) => b >= 128) && buf.toString('utf8').includes('\ufffd')) return false
  return true
}

function readVarint(buf: Buffer, offset: number): { value: bigint; next: number } | null {
  let value = 0n
  let shift = 0n
  let o = offset
  for (let i = 0; i < 10; i++) {
    if (o >= buf.length) return null
    const b = buf[o++]
    value |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value, next: o }
    shift += 7n
  }
  return null
}

function inflateGrpc(payload: Buffer): Buffer | null {
  const limit = { maxOutputLength: MAX_INFLATE }
  try {
    return gunzipSync(payload, limit)
  } catch {
    try {
      return inflateSync(payload, limit)
    } catch {
      return null
    }
  }
}
