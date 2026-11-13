import assert from 'node:assert/strict'
import { test } from 'node:test'
import { insideOutput, isLibraryPath, packageVersion, parseJadxErrors, parseJadxProgress, searchText } from './decompile'

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
