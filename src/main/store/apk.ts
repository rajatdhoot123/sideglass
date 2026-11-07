import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Adb } from '../adb'

/** Every APK file of an installed app (base plus splits), as `pm path` lists them. */
export async function apkPaths(adb: Adb, pkg: string): Promise<string[]> {
  const out = await adb.shell(`pm path ${pkg}`).catch(() => '')
  return out
    .split('\n')
    .map((l) => l.trim().replace(/^package:/, ''))
    .filter((p) => p.endsWith('.apk'))
}

/** Copy an installed app's APK files from a device to [dir]/[pkg]/. */
export async function pullApp(adb: Adb, pkg: string, dir: string): Promise<string[]> {
  const remote = await apkPaths(adb, pkg)
  if (!remote.length) throw new Error(`${pkg} is not installed on ${adb.serial}`)
  const target = join(dir, pkg)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  const local: string[] = []
  for (const [i, path] of remote.entries()) {
    const file = join(target, `${i}-${path.split('/').pop()}`)
    await adb.exec(['pull', path, file], 300_000)
    local.push(file)
  }
  return local
}

/** Install one APK or a set of splits. Returns adb's last line ("Success" or the failure). */
export async function installApks(adb: Adb, paths: string[]): Promise<string> {
  const args = paths.length > 1 ? ['install-multiple', '-r', '-g', ...paths] : ['install', '-r', '-g', paths[0]]
  try {
    const out = await adb.exec(args, 300_000)
    return out.trim().split('\n').pop() ?? ''
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string }
    const message = (err.stderr || err.stdout || err.message).trim().split('\n').pop() ?? err.message
    const pkg = /Existing package (\S+) signatures do not match/.exec(message)?.[1]
    if (!pkg) throw new Error(message)
    // A copy signed with another key is already there. Replace it if the user installed it;
    // a system app (preinstalled Google app) cannot be replaced.
    const system = (await adb.shell(`pm list packages -s ${pkg}`).catch(() => '')).split('\n').some((l) => l.trim() === `package:${pkg}`)
    if (system) throw new Error(`${pkg} is a preinstalled system app on the capture phone with a different signature; it cannot be replaced.`)
    await adb.shell(`pm uninstall ${pkg}`)
    const out = await adb.exec(args, 300_000)
    return `${out.trim().split('\n').pop() ?? ''} (replaced a differently signed copy)`
  }
}

export const isPackageName = (s: string) => /^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/.test(s)
