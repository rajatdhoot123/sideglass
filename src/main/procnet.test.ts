import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attributeSocket, decodeProcAddress, parsePackageUids, parseProcNet, rememberSockets } from './procnet'

test('decodes an IPv4 /proc address', () => {
  assert.deepEqual(decodeProcAddress('08080808:01BB'), { ip: '8.8.8.8', port: 443 })
})

test('decodes the emulator IPv4-mapped socket', () => {
  const local = decodeProcAddress('0000000000000000FFFF00001002000A:CDFA')
  const remote = decodeProcAddress('0000000000000000FFFF0000BC9EB2C0:146C')
  assert.deepEqual(local, { ip: '10.0.2.16', port: 0xcdfa })
  assert.deepEqual(remote, { ip: '192.178.158.188', port: 0x146c })
})

test('parses established rows and package uids', () => {
  const dump = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:C3C2 08080808:01BB 01 00000000:00000000 00:00000000 00000000 10123 0 1 1 0000000000000000 100 0 0 10 0',
    '   1: 0100007F:C3C3 08080808:0050 0A 00000000:00000000 00:00000000 00000000 10123 0 2 1 0000000000000000 100 0 0 10 0',
  ].join('\n')
  const rows = parseProcNet(dump)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].established, true)
  assert.equal(rows[0].remoteIp, '8.8.8.8')
  assert.equal(rows[0].remotePort, 443)
  assert.equal(rows[1].established, false)
  const uids = parsePackageUids('package:com.example.app uid:10123\npackage:com.other.app uid:10124\n')
  assert.deepEqual(uids.get(10123), ['com.example.app'])
})

test('attributes the launched app and refuses a guess', () => {
  const now = 10_000
  const sockets = rememberSockets(
    [],
    [
      { remoteIp: '8.8.8.8', remotePort: 443, uid: 10123, established: true },
      { remoteIp: '8.8.8.8', remotePort: 443, uid: 10124, established: true },
      { remoteIp: '1.1.1.1', remotePort: 443, uid: 1000, established: true },
    ],
    now,
    20_000,
  )
  const uidToPkgs = new Map<number, string[]>([
    [10123, ['com.example.app']],
    [10124, ['com.other.app']],
  ])
  assert.equal(
    attributeSocket({ ips: ['8.8.8.8'], port: 443, at: now, sockets, uidToPkgs, preferPkg: 'com.example.app' }),
    'com.example.app',
  )
  assert.equal(attributeSocket({ ips: ['8.8.8.8'], port: 443, at: now, sockets, uidToPkgs }), undefined)
  assert.equal(attributeSocket({ ips: ['1.1.1.1'], port: 443, at: now, sockets, uidToPkgs }), undefined)
  const only = rememberSockets([], [{ remoteIp: '9.9.9.9', remotePort: 80, uid: 10124, established: true }], now, 20_000)
  assert.equal(attributeSocket({ ips: ['9.9.9.9'], port: 80, at: now, sockets: only, uidToPkgs }), 'com.other.app')
})
