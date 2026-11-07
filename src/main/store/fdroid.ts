import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Adb } from '../adb'
import { installApks } from './apk'

/** F-Droid: free and open-source apps, with signed APKs straight from f-droid.org. */
export interface StoreApp {
  packageName: string
  name: string
  summary: string
  icon?: string
}

/** A starting shelf of well-known F-Droid apps that make network calls worth looking at. */
export const FEATURED: StoreApp[] = [
  { packageName: 'org.schabi.newpipe', name: 'NewPipe', summary: 'Lightweight YouTube front end' },
  { packageName: 'com.fsck.k9', name: 'K-9 Mail', summary: 'Email client' },
  { packageName: 'org.wikipedia', name: 'Wikipedia', summary: 'The free encyclopedia' },
  { packageName: 'de.danoeh.antennapod', name: 'AntennaPod', summary: 'Podcast player' },
  { packageName: 'org.tasks', name: 'Tasks', summary: 'To-do lists and reminders' },
  { packageName: 'com.github.libretube', name: 'LibreTube', summary: 'YouTube client using Piped' },
  { packageName: 'org.joinmastodon.android', name: 'Mastodon', summary: 'Official Mastodon client' },
  { packageName: 'net.osmand.plus', name: 'OsmAnd~', summary: 'Offline maps and navigation' },
  { packageName: 'com.nextcloud.client', name: 'Nextcloud', summary: 'Files sync client' },
]

export async function search(query: string): Promise<StoreApp[]> {
  const res = await fetch(`https://search.f-droid.org/api/search_apps?q=${encodeURIComponent(query)}`)
  if (!res.ok) throw new Error(`F-Droid search failed: HTTP ${res.status}`)
  const body = (await res.json()) as { apps: { name: string; summary: string; icon?: string; url: string }[] }
  return body.apps.map((a) => ({
    name: a.name,
    summary: a.summary,
    icon: a.icon,
    packageName: a.url.split('/packages/')[1]?.replace(/\/$/, '') ?? '',
  })).filter((a) => a.packageName)
}

/**
 * Download and install an app from F-Droid. Apps built per CPU type publish one version
 * code per ABI, so on "no matching ABI" try the other builds of the same release.
 */
export async function installFromFdroid(adb: Adb, pkg: string, dir: string, log: (l: string) => void): Promise<string> {
  const res = await fetch(`https://f-droid.org/api/v1/packages/${pkg}`)
  if (!res.ok) throw new Error(`${pkg} is not on F-Droid (HTTP ${res.status})`)
  const info = (await res.json()) as { suggestedVersionCode: number; packages: { versionName: string; versionCode: number }[] }
  const suggested = info.packages.find((p) => p.versionCode === info.suggestedVersionCode) ?? info.packages[0]
  const sameRelease = [...new Set(info.packages.filter((p) => p.versionName === suggested.versionName).map((p) => p.versionCode))]
  const codes = [info.suggestedVersionCode, ...sameRelease.filter((c) => c !== info.suggestedVersionCode)]
  mkdirSync(dir, { recursive: true })
  let last = ''
  for (const code of codes) {
    const file = join(dir, `${pkg}_${code}.apk`)
    log(`Downloading ${pkg} ${suggested.versionName} (${code})…`)
    const apk = await fetch(`https://f-droid.org/repo/${pkg}_${code}.apk`)
    if (!apk.ok || !apk.body) {
      last = `download failed: HTTP ${apk.status}`
      continue
    }
    await pipeline(Readable.fromWeb(apk.body as never), createWriteStream(file))
    log(`Installing ${pkg}…`)
    try {
      return await installApks(adb, [file])
    } catch (error) {
      last = (error as Error).message
      if (!/NO_MATCHING_ABIS|ABI/i.test(last)) throw error
    }
  }
  throw new Error(`Could not install ${pkg}: ${last}`)
}
