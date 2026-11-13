import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Adb } from './adb'
import { Decompiler, insideOutput, isLibraryPath, jadxOutcome, packageVersion, parseJadxErrors, parseJadxProgress, searchText } from './decompile'

test('parseJadxProgress reads the percentage jadx prints', () => {
  assert.equal(parseJadxProgress('INFO  - progress: 2861 of 14417 (19%)'), 19)
  assert.equal(parseJadxProgress('INFO  - processing ...'), null)
  assert.equal(parseJadxProgress('progress: 0 of 0 (0%)'), null)
})

test('parseJadxErrors reads the failed class count', () => {
  assert.equal(parseJadxErrors('INFO  - done\nERROR - finished with errors, count: 12\n'), 12)
  assert.equal(parseJadxErrors('INFO  - done'), 0)
})

test('packageVersion changes when the app is updated', () => {
  const v1 = packageVersion('    versionCode=151202 minSdk=24 targetSdk=35\n    versionName=14.2.1\n    lastUpdateTime=2026-11-01 10:00:00\n')
  const v2 = packageVersion('    versionCode=151202 minSdk=24 targetSdk=35\n    versionName=14.2.1\n    lastUpdateTime=2026-11-12 09:00:00\n')
  assert.equal(v1.label, '14.2.1 (151202)')
  assert.notEqual(v1.key, v2.key)
})

test('insideOutput refuses paths that leave the folder', () => {
  assert.equal(insideOutput('/data/out', 'sources/a/B.java'), '/data/out/sources/a/B.java')
  assert.throws(() => insideOutput('/data/out', '../meta.json'))
  assert.throws(() => insideOutput('/data/out', '/etc/passwd'))
  assert.throws(() => insideOutput('/data/out', '../out2/x'))
})

test('isLibraryPath only matches well-known packages under sources/', () => {
  assert.equal(isLibraryPath('sources/androidx/core/app/A.java'), true)
  assert.equal(isLibraryPath('sources/okhttp3/OkHttpClient.java'), true)
  assert.equal(isLibraryPath('sources/org/tasks/MainActivity.java'), false)
  assert.equal(isLibraryPath('resources/AndroidManifest.xml'), false)
})

test('isLibraryPath keeps the app when its package is under a library prefix', () => {
  const maps = 'com.google.android.apps.maps'
  assert.equal(isLibraryPath('sources/com/google/android/apps/maps/MapsActivity.java', maps), false)
  assert.equal(isLibraryPath('sources/com/google/android/gms/common/Foo.java', maps), true)
  assert.equal(isLibraryPath('sources/com/facebook/katana/Home.java', 'com.facebook.katana'), false)
  assert.equal(isLibraryPath('sources/com/github/other/Lib.java', 'com.github.me.app'), true)
})

test('jadxOutcome treats exit 3 as a partial success and a signal as a failure', () => {
  assert.deepEqual(jadxOutcome({ code: 0, signal: null, cancelled: false, hasSources: true, errors: 0 }), { ok: true, errors: 0 })
  assert.deepEqual(jadxOutcome({ code: 3, signal: null, cancelled: false, hasSources: true, errors: 0 }), { ok: true, errors: 1 })
  assert.deepEqual(jadxOutcome({ code: 3, signal: null, cancelled: false, hasSources: true, errors: 12 }), { ok: true, errors: 12 })
  const killed = jadxOutcome({ code: null, signal: 'SIGKILL', cancelled: false, hasSources: true, errors: 4 })
  assert.equal(killed.ok, false)
  const signalled = jadxOutcome({ code: null, signal: 'SIGTERM', cancelled: false, hasSources: false, errors: 0 })
  assert.equal(signalled.ok, false)
  if (!signalled.ok) assert.equal(signalled.message, 'jadx was killed (SIGTERM)')
  const cancelled = jadxOutcome({ code: null, signal: 'SIGTERM', cancelled: true, hasSources: false, errors: 0 })
  assert.equal(cancelled.ok, false)
  if (!cancelled.ok) assert.equal(cancelled.message, 'Cancelled')
  assert.equal(jadxOutcome({ code: 1, signal: null, cancelled: false, hasSources: false, errors: 0 }).ok, false)
})

test('decompile rejects a bad package name before adb', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sideglass-code-'))
  let calls = 0
  const adb = {
    serial: 'emulator-1',
    shell: async () => {
      calls++
      return ''
    },
    exec: async () => {
      calls++
      return ''
    },
  } as unknown as Adb
  const decompiler = new Decompiler(root, () => undefined)
  try {
    await assert.rejects(() => decompiler.decompile(adb, 'com.example.app; id', true), /Invalid package name/)
    assert.equal(calls, 0)
    assert.equal(decompiler.isRunning('com.example.app; id'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancel stops an in-flight pull and leaves a published tree in place', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sideglass-code-'))
  const pkg = 'com.example.app'
  const published = join(root, 'code', pkg, 'out', 'sources', 'Keep.java')
  mkdirSync(join(root, 'code', pkg, 'out', 'sources'), { recursive: true })
  writeFileSync(published, 'class Keep {}')
  let release: (signal?: AbortSignal) => void = () => undefined
  const pulling = new Promise<AbortSignal | undefined>((resolve) => {
    release = resolve
  })
  const adb = {
    serial: 'emulator-1',
    shell: async (command: string, _timeout?: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' })
      if (command.startsWith('dumpsys')) return 'versionCode=3\nversionName=1.0\nlastUpdateTime=t\n'
      if (command.startsWith('pm path')) return 'package:/data/app/base.apk\n'
      return ''
    },
    exec: async (_args: string[], _timeout?: number, signal?: AbortSignal) => {
      mkdirSync(join(root, 'code', pkg, 'out.part'), { recursive: true })
      writeFileSync(join(root, 'code', pkg, 'out.part', 'partial.java'), 'partial')
      release(signal)
      await new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' }))
        else signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' })))
      })
      return ''
    },
  } as unknown as Adb
  const decompiler = new Decompiler(root, () => undefined)
  const pending = decompiler.decompile(adb, pkg, true)
  const settled = pending.then(
    () => 'resolved',
    (error: Error) => error.message,
  )
  try {
    const signal = await pulling
    assert.equal(decompiler.isRunning(pkg), true)
    decompiler.cancel(pkg)
    assert.equal(signal?.aborted, true)
    assert.equal(await settled, 'Cancelled')
    assert.equal(decompiler.isRunning(pkg), false)
    assert.equal(existsSync(join(root, 'code', pkg, 'out.part')), false)
    assert.equal(existsSync(join(root, 'code', pkg, 'apk')), false)
    assert.equal(existsSync(published), true)
  } finally {
    decompiler.cancel(pkg)
    await settled
    rmSync(root, { recursive: true, force: true })
  }
})

test('dispose cancels a decompile so a stopped session cannot publish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sideglass-code-'))
  const pkg = 'com.example.app'
  let release: () => void = () => undefined
  const pulling = new Promise<void>((resolve) => {
    release = resolve
  })
  const adb = {
    serial: 'emulator-1',
    shell: async (command: string, _timeout?: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' })
      if (command.startsWith('dumpsys')) return 'versionCode=3\nversionName=1.0\nlastUpdateTime=t\n'
      if (command.startsWith('pm path')) return 'package:/data/app/base.apk\n'
      return ''
    },
    exec: async (_args: string[], _timeout?: number, signal?: AbortSignal) => {
      release()
      await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' })), { once: true })
      })
      return ''
    },
  } as unknown as Adb
  const decompiler = new Decompiler(root, () => undefined)
  const pending = decompiler.decompile(adb, pkg, true)
  const settled = pending.then(
    () => 'resolved',
    (error: Error) => error.message,
  )
  try {
    await pulling
    await decompiler.dispose()
    assert.equal(await settled, 'Cancelled')
    assert.equal(decompiler.isRunning(pkg), false)
  } finally {
    await decompiler.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('searchText returns line numbers and one hit per line', () => {
  const text = 'package a;\n\n@GET("v1/users/{id}")\nCall<User> user(); // v1/users\nString x = "V1/USERS";\n'
  assert.deepEqual(
    searchText(text, 'v1/users', false, 'f', 10).map((h) => h.line),
    [3, 4, 5],
  )
  assert.deepEqual(
    searchText(text, 'v1/users', true, 'f', 10).map((h) => [h.line, h.text]),
    [
      [3, '@GET("v1/users/{id}")'],
      [4, 'Call<User> user(); // v1/users'],
    ],
  )
  assert.equal(searchText(text, 'v1/users', false, 'f', 1).length, 1)
  assert.deepEqual(searchText(text, 'nothing', false, 'f', 10), [])
})
