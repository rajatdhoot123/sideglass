import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { manifestValues, patchManifest, poolStrings, stringPoolChunk } from './axml'
import { readEntry, repack } from './zip'
import { renameResourcePackage, renameResourceStrings } from './arsc'
import { replaceSmaliStrings } from './code'
import { crashLogMentionsPackage } from './explain'
import { zipalignLacksPageFlag } from './index'

const ANDROID = 'http://schemas.android.com/apk/res/android'
const ids: Record<string, number> = { label: 0x01010001, name: 0x01010003, authorities: 0x01010018, permission: 0x01010006 }
type Value = string | { ref: number; raw?: string }
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
      const raw = str ? v : v.raw
      a.writeUInt32LE(raw ? at(raw) : 0xffffffff, 8)
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
  assert.equal(out.resources.get(0x7f020002), 'com.fresh.ref')
})

test('patchManifest resolves a raw @string reference instead of renaming that text', () => {
  const bin = axml([
    'manifest',
    { package: 'com.old' },
    [
      ['permission', { name: { ref: 0x7f010010, raw: '@string/perm' } }, []],
      ['uses-permission', { name: 'com.old.PERM' }, []],
      ['uses-permission', { name: { ref: 0x7f010010, raw: '@string/perm' } }, []],
      [
        'application',
        {},
        [
          ['provider', { name: 'P', authorities: { ref: 0x7f010011, raw: '@string/auth' } }, []],
          ['provider', { name: 'Q', authorities: 'com.facebook.app.P1' }, []],
        ],
      ],
    ],
  ])
  const out = patchManifest(bin, {
    pkg: 'com.fresh',
    resolve: (id) => (id === 0x7f010010 ? 'com.old.PERM' : id === 0x7f010011 ? 'com.old.auth' : null),
  })
  const v = manifestValues(out.manifest)
  const el = (name: string, i = 0) => v.filter((e) => e.element === name)[i].attrs
  assert.equal(el('permission').name, 'com.fresh.PERM')
  assert.equal(el('uses-permission').name, 'com.fresh.PERM')
  assert.equal(el('uses-permission', 1).name, 'com.fresh.PERM')
  assert.equal(el('provider').authorities, 'com.fresh.auth')
  assert.equal(el('provider', 1).authorities, 'com.fresh.com.facebook.app.P1')
  assert.equal(out.resources.get(0x7f010010), 'com.fresh.PERM')
  assert.equal(out.resources.get(0x7f010011), 'com.fresh.auth')
  assert.equal(out.renames.has('@string/perm'), false)
  assert.equal(out.renames.has('@string/auth'), false)
  assert.equal(out.renames.get('com.facebook.app.P1'), 'com.fresh.com.facebook.app.P1')
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

test('renameResourcePackage renames the app package in the resource table only', () => {
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

function simpleEntry(key: number, poolIndex: number): Buffer {
  const entry = Buffer.alloc(16)
  entry.writeUInt16LE(8, 0)
  entry.writeUInt16LE(0, 2)
  entry.writeUInt32LE(key, 4)
  entry.writeUInt16LE(8, 8)
  entry[11] = 3
  entry.writeUInt32LE(poolIndex, 12)
  return entry
}

function compactEntry(key: number, poolIndex: number): Buffer {
  const entry = Buffer.alloc(8)
  entry.writeUInt16LE(key, 0)
  entry.writeUInt16LE(0x0008 | (0x03 << 8), 2)
  entry.writeUInt32LE(poolIndex, 4)
  return entry
}

/** A type chunk. [flags] 0 is dense uint32 offsets, 2 is uint16 offsets stored as offset/4. */
function typeChunk(id: number, flags: number, entries: (Buffer | null)[]): Buffer {
  const offsetBytes = flags & 0x02 ? 2 : 4
  const offsets = Buffer.alloc(entries.length * offsetBytes)
  const bodies: Buffer[] = []
  let rel = 0
  entries.forEach((entry, i) => {
    if (!entry) {
      if (offsetBytes === 2) offsets.writeUInt16LE(0xffff, i * 2)
      else offsets.writeUInt32LE(0xffffffff, i * 4)
      return
    }
    if (offsetBytes === 2) offsets.writeUInt16LE(rel / 4, i * 2)
    else offsets.writeUInt32LE(rel, i * 4)
    bodies.push(entry)
    rel += entry.length
  })
  const headerSize = 24
  const entriesStart = headerSize + offsets.length
  const rest = Buffer.alloc(headerSize - 8)
  rest[0] = id
  rest[1] = flags
  rest.writeUInt32LE(entries.length, 4)
  rest.writeUInt32LE(entriesStart, 8)
  rest.writeUInt32LE(4, 12)
  const payload = Buffer.concat([rest, offsets, ...bodies])
  const head = Buffer.alloc(8)
  head.writeUInt16LE(0x0201, 0)
  head.writeUInt16LE(headerSize, 2)
  head.writeUInt32LE(8 + payload.length, 4)
  return Buffer.concat([head, payload])
}

function sparseType(id: number, entryId: number, entry: Buffer): Buffer {
  const offsets = Buffer.alloc(4)
  offsets.writeUInt16LE(entryId, 0)
  offsets.writeUInt16LE(0, 2)
  const headerSize = 24
  const entriesStart = headerSize + offsets.length
  const rest = Buffer.alloc(headerSize - 8)
  rest[0] = id
  rest[1] = 0x01
  rest.writeUInt32LE(1, 4)
  rest.writeUInt32LE(entriesStart, 8)
  rest.writeUInt32LE(4, 12)
  const payload = Buffer.concat([rest, offsets, entry])
  const head = Buffer.alloc(8)
  head.writeUInt16LE(0x0201, 0)
  head.writeUInt16LE(headerSize, 2)
  head.writeUInt32LE(8 + payload.length, 4)
  return Buffer.concat([head, payload])
}

function resourceTable(pool: Buffer, inner: Buffer, name = 'com.old'): Buffer {
  const pkg = Buffer.alloc(288 + inner.length)
  pkg.writeUInt16LE(0x0200, 0)
  pkg.writeUInt16LE(288, 2)
  pkg.writeUInt32LE(pkg.length, 4)
  pkg.writeUInt32LE(0x7f, 8)
  pkg.write(name, 12, 'utf16le')
  inner.copy(pkg, 288)
  const head = Buffer.alloc(12)
  head.writeUInt16LE(0x0002, 0)
  head.writeUInt16LE(12, 2)
  head.writeUInt32LE(12 + pool.length + pkg.length, 4)
  head.writeUInt32LE(1, 8)
  return Buffer.concat([head, pool, pkg])
}

function globalPool(arsc: Buffer): Buffer {
  const start = arsc.readUInt16LE(2)
  return arsc.subarray(start, start + arsc.readUInt32LE(start + 4))
}

test('renameResourceStrings updates referenced strings and leaves the rest of the pool', () => {
  const strings = ['Hello', 'com.old.auth.extra', 'com.old.auth', 'com.facebook.app.P1', 'com.old.PERM']
  for (const utf8 of [true, false]) {
    const pool = stringPoolChunk(strings, utf8)
    const inner = Buffer.concat([
      typeChunk(1, 0, [simpleEntry(0, 2), simpleEntry(1, 1), null]),
      typeChunk(2, 0x02, [simpleEntry(0, 3)]),
      typeChunk(3, 0, [compactEntry(0, 4)]),
      sparseType(4, 5, simpleEntry(5, 2)),
    ])
    const arsc = resourceTable(pool, inner)
    const out = renameResourceStrings(
      arsc,
      new Map<number, string>([
        [0x7f010000, 'com.fresh.auth'],
        [0x7f020000, 'com.fresh.com.facebook.app.P1'],
        [0x7f030000, 'com.fresh.PERM'],
        [0x7f040005, 'com.fresh.auth'],
      ]),
    )!
    assert.deepEqual(poolStrings(globalPool(out)), [
      'Hello',
      'com.old.auth.extra',
      'com.fresh.auth',
      'com.fresh.com.facebook.app.P1',
      'com.fresh.PERM',
    ])
    const renamed = renameResourcePackage(out, 'com.old', 'com.fresh')!
    // The package chunk follows the resized string pool.
    const pkgAt = renamed.readUInt16LE(2) + renamed.readUInt32LE(renamed.readUInt16LE(2) + 4)
    assert.equal(renamed.readUInt16LE(pkgAt), 0x0200)
    assert.equal(renamed.toString('utf16le', pkgAt + 12, pkgAt + 12 + 32).split('\0')[0], 'com.fresh')
    assert.equal(renameResourceStrings(arsc, new Map([[0x7f0100ff, 'nope']])), null)
  }
})

test('replaceSmaliStrings renames whole literals only', () => {
  const renames = new Map([
    ['com.facebook.app.P1', 'com.fresh.com.facebook.app.P1'],
    ['downloads', 'com.fresh.downloads'],
  ])
  const { text, count } = replaceSmaliStrings(
    ['const-string v0, "com.facebook.app.P1"', 'const-string v1, "com.facebook.app.P1.extra"', 'const-string v2, "downloads"', 'const-string v3, "mydownloads"'].join('\n'),
    renames,
  )
  assert.equal(count, 2)
  assert.match(text, /"com\.fresh\.com\.facebook\.app\.P1"/)
  assert.match(text, /"com\.facebook\.app\.P1\.extra"/)
  assert.match(text, /"com\.fresh\.downloads"/)
  assert.match(text, /"mydownloads"/)
})

test('crash log lines match the package and not a longer name', () => {
  assert.equal(crashLogMentionsPackage('Process: com.foo, PID: 3', 'com.foo'), true)
  assert.equal(crashLogMentionsPackage('Process: com.foo.bar, PID: 3', 'com.foo'), false)
  assert.equal(crashLogMentionsPackage('Process: com.foo.bar, PID: 3', 'com.foo.bar'), true)
})

test('zipalign falls back only when the page-size flag is unknown', () => {
  assert.equal(zipalignLacksPageFlag('ERROR: unknown flag -P'), true)
  assert.equal(zipalignLacksPageFlag('zipalign: illegal option -- P'), true)
  assert.equal(zipalignLacksPageFlag("Unable to open 'app.apk' as zip archive"), false)
})

test('explainInstallError names the limitation behind adb install failures', async () => {
  const { explainInstallError } = await import('./explain')
  assert.match(
    explainInstallError('Failure [INSTALL_FAILED_CONFLICTING_PROVIDER: Scanning Failed.: Can\'t install because provider name x]', 'com.fresh'),
    /content provider .* cannot be cloned/,
  )
  assert.match(explainInstallError('com.fresh is already installed and signed with another key.', 'com.fresh'), /Pick a different package name/)
  assert.match(explainInstallError('Failure [SOMETHING_NEW]', 'com.fresh'), /^Android refused to install the clone: Failure \[SOMETHING_NEW\]$/)
})
