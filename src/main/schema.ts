import { readFileSync } from 'node:fs'
import protobuf from 'protobufjs'
import { grpcFrames } from './protobody'

/** A .proto loaded for this session. Decoding prefers it over the schema-less field tree. */
export class ProtoSchema {
  private root: protobuf.Root | null = null
  private names: string[] = []

  get types(): string[] {
    return this.names
  }

  loadFile(file: string): string[] {
    this.root = protobuf.loadSync(file)
    this.names = listTypes(this.root)
    if (!this.names.length) throw new Error('That file has no message types')
    return this.names
  }

  loadSource(source: string): string[] {
    this.root = protobuf.parse(source).root
    this.names = listTypes(this.root)
    if (!this.names.length) throw new Error('That file has no message types')
    return this.names
  }

  decode(buf: Buffer, contentType: string, typeName: string): string {
    if (!this.root) throw new Error('Load a .proto first')
    const type = this.root.lookupType(typeName)
    const payloads = contentType.toLowerCase().includes('grpc') ? grpcFrames(buf) : [buf]
    if (!payloads) throw new Error('The body is not a gRPC frame')
    return payloads
      .map((payload, index) => {
        const message = type.decode(payload)
        const text = JSON.stringify(type.toObject(message, { longs: String, bytes: String, defaults: false }), null, 2)
        return payloads.length > 1 ? `frame ${index + 1}\n${text}` : text
      })
      .join('\n')
  }
}

export function readProto(file: string): string {
  return readFileSync(file, 'utf8')
}

function listTypes(root: protobuf.Root): string[] {
  const names: string[] = []
  const walk = (ns: protobuf.Namespace, prefix: string) => {
    for (const [name, obj] of Object.entries(ns.nested ?? {})) {
      const full = prefix ? `${prefix}.${name}` : name
      if (obj instanceof protobuf.Type) names.push(full)
      else if (obj instanceof protobuf.Namespace) walk(obj, full)
    }
  }
  walk(root, '')
  return names
}
