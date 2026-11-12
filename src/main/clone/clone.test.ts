import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { manifestValues, patchManifest } from './axml'
import { readEntry, repack } from './zip'

const ANDROID = 'http://schemas.android.com/apk/res/android'
const ids: Record<string, number> = { label: 0x01010001, name: 0x01010003, authorities: 0x01010018, permission: 0x01010006 }
type Value = string | { ref: number }
type Node = [string, Record<string, Value>, Node[]]

/** A small binary manifest, laid out the way aapt2 writes one (UTF-8 pool, resource map first). */
function axml(root: Node): Buffer {
  const attrNames = Object.keys(ids)
  const strings = [...attrNames, ANDROID, 'android', 'package']
  const at = (s: string) => (strings.includes(s) ? strings.indexOf(s) : strings.push(s) - 1)
  const chunk = (type: number, headerSize: number, body: Buffer) => {
    const h = Buffer.alloc(8)
    h.writeUInt16LE(type, 0)
    h.writeUInt16LE(headerSize, 2)
    h.writeUInt32LE(8 + body.length, 4)
    return Buffer.concat([h, body])
  }
  const nodes: Buffer[] = []
  const walk = ([name, attrs, children]: Node) => {
    const list = Object.entries(attrs).map(([k, v]) => {
      const a = Buffer.alloc(20)
      a.writeUInt32LE(k === 'package' ? 0xffffffff : at(ANDROID), 0)
      a.writeUInt32LE(at(k), 4)
      const str = typeof v === 'string'
      a.writeUInt32LE(str ? at(v) : 0xffffffff, 8)
      a.writeUInt16LE(8, 12)
      a[15] = str ? 3 : 1
      a.writeUInt32LE(str ? at(v) : v.ref, 16)
      return a
    })
    const ext = Buffer.alloc(28)
    ext.writeUInt32LE(0xffffffff, 4) // comment
    ext.writeUInt32LE(0xffffffff, 8) // ns
    ext.writeUInt32LE(at(name), 12)
    ext.writeUInt16LE(20, 16)
    ext.writeUInt16LE(20, 18)
    ext.writeUInt16LE(list.length, 20)
    nodes.push(chunk(0x0102, 16, Buffer.concat([ext, ...list])))
    children.forEach(walk)
    const end = Buffer.alloc(16)
    end.writeUInt32LE(0xffffffff, 4)
    end.writeUInt32LE(0xffffffff, 8)
    end.writeUInt32LE(at(name), 12)
    nodes.push(chunk(0x0103, 16, end))
  }
  walk(root)
  const data: Buffer[] = []
  const offsets = Buffer.alloc(strings.length * 4)
  let size = 0
  strings.forEach((s, i) => {
    offsets.writeUInt32LE(size, i * 4)
    const b = Buffer.concat([Buffer.from([s.length, Buffer.byteLength(s)]), Buffer.from(s), Buffer.from([0])])
    data.push(b)
    size += b.length
  })
  data.push(Buffer.alloc((4 - (size % 4)) % 4))
  const head = Buffer.alloc(20)
  head.writeUInt32LE(strings.length, 0)
  head.writeUInt32LE(0x100, 8)
  head.writeUInt32LE(28 + offsets.length, 12)
  const pool = chunk(0x0001, 28, Buffer.concat([head, offsets, ...data]))
  const map = Buffer.alloc(attrNames.length * 4)
  attrNames.forEach((n, i) => map.writeUInt32LE(ids[n], i * 4))
  return chunk(0x0003, 8, Buffer.concat([pool, chunk(0x0180, 8, map), ...nodes]))
}

const manifest = axml([
  'manifest',
  { package: 'com.old' },
  [
    ['permission', { name: 'com.old.PERM' }, []],
    ['uses-permission', { name: 'com.old.PERM' }, []],
    ['uses-permission', { name: 'android.permission.INTERNET' }, []],
    [
      'application',
      { label: { ref: 0x7f010001 }, name: '.App' },
      [
        ['activity', { name: '.Main', label: 'Old' }, [['intent-filter', {}, [['category', { name: 'android.intent.category.LAUNCHER' }, []]]]]],
        ['activity', { name: 'com.lib.Other', label: 'Settings' }, []],
        ['provider', { name: 'Files', authorities: 'com.old.files;com.facebook.app.P1', permission: 'com.old.PERM' }, []],
        ['provider', { name: 'com.lib.Ref', authorities: { ref: 0x7f020002 } }, []],
      ],
    ],
  ],
])

test('patchManifest renames the package, its names, and the launcher label', () => {
  const out = patchManifest(manifest, { pkg: 'com.fresh', label: 'Fresh', resolve: (id) => (id === 0x7f020002 ? 'com.old.ref' : null) })
  assert.equal(out.oldPkg, 'com.old')
  assert.equal(out.labels, 2)
  const v = manifestValues(out.manifest)
  const el = (name: string, i = 0) => v.filter((e) => e.element === name)[i].attrs
  assert.equal(el('manifest').package, 'com.fresh')
  assert.equal(el('permission').name, 'com.fresh.PERM')
  assert.equal(el('uses-permission').name, 'com.fresh.PERM')
  assert.equal(el('uses-permission', 1).name, 'android.permission.INTERNET')
  assert.deepEqual(el('application'), { label: 'Fresh', name: 'com.old.App' })
  assert.deepEqual(el('activity'), { name: 'com.old.Main', label: 'Fresh' })
  assert.deepEqual(el('activity', 1), { name: 'com.lib.Other', label: 'Settings' })
  assert.deepEqual(el('provider'), { name: 'com.old.Files', authorities: 'com.fresh.files;com.fresh.com.facebook.app.P1', permission: 'com.fresh.PERM' })
  assert.equal(el('provider', 1).authorities, 'com.fresh.ref')
  assert.equal(out.renames.get('com.old.files'), 'com.fresh.files')
  assert.equal(out.renames.get('com.old.PERM'), 'com.fresh.PERM')
})

test('repack replaces one entry, keeps the rest, and drops the old signature', () => {
  const crcless = (name: string, body: Buffer) => {
    // A stored entry built by hand.
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(n.length, 26)
    return { local: Buffer.concat([local, n, body]), name: n, size: body.length }
  }
  const files = [crcless('AndroidManifest.xml', manifest), crcless('resources.arsc', Buffer.from('arsc')), crcless('META-INF/CERT.RSA', Buffer.from('sig'))]
  let offset = 0
  const central = files.map((f) => {
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt32LE(f.size, 20)
    c.writeUInt32LE(f.size, 24)
    c.writeUInt16LE(f.name.length, 28)
    c.writeUInt32LE(offset, 42)
    offset += f.local.length
    return Buffer.concat([c, f.name])
  })
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(3, 8)
  end.writeUInt16LE(3, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  const zip = Buffer.concat([...files.map((f) => f.local), dir, end])

  const patched = patchManifest(manifest, { pkg: 'com.fresh' }).manifest
  const out = repack(zip, new Map([['AndroidManifest.xml', patched]]))
  assert.deepEqual(readEntry(out, 'AndroidManifest.xml'), patched)
  assert.equal(readEntry(out, 'resources.arsc')?.toString(), 'arsc')
  assert.equal(readEntry(out, 'META-INF/CERT.RSA'), null)
})

test('renameResourcePackage renames the app package in the resource table only', async () => {
  const { renameResourcePackage } = await import('./arsc')
  const pkgChunk = (id: number, name: string) => {
    const c = Buffer.alloc(288)
    c.writeUInt16LE(0x0200, 0)
    c.writeUInt16LE(288, 2)
    c.writeUInt32LE(288, 4)
    c.writeUInt32LE(id, 8)
    c.write(name, 12, 'utf16le')
    return c
  }
  const head = Buffer.alloc(12)
  head.writeUInt16LE(0x0002, 0)
  head.writeUInt16LE(12, 2)
  head.writeUInt32LE(12 + 288 * 2, 4)
  head.writeUInt32LE(2, 8)
  const arsc = Buffer.concat([head, pkgChunk(0x7f, 'com.old'), pkgChunk(0x02, 'com.lib')])
  const out = renameResourcePackage(arsc, 'com.old', 'com.fresh')!
  const name = (at: number) => out.toString('utf16le', at + 12, at + 12 + 256).split('\0')[0]
  assert.equal(name(12), 'com.fresh')
  assert.equal(name(12 + 288), 'com.lib')
  assert.equal(out.length, arsc.length)
  assert.equal(renameResourcePackage(arsc, 'com.other', 'com.fresh'), null)
})
