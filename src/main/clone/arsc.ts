/**
 * The resource table (resources.arsc) names its package. A normal build names it after the
 * application id, and code such as Firebase looks resources up by package name
 * (getIdentifier("google_app_id", "string", getPackageName())). A clone has to carry the new
 * name there too, or those lookups find nothing.
 */

const TABLE = 0x0002
const PACKAGE = 0x0200
/** ResTable_package.name is char16_t[128]. */
const NAME_CHARS = 128

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
