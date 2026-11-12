import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Adb } from './adb'

/**
 * Root for the capture phone: Magisk on a Play Store image.
 *
 * A Play Store image cannot be rooted with `adb root`, but its boot ramdisk can be
 * patched to load Magisk's init (the official route for emulators, supporting API 24-36).
 * The patch needs no root — it runs on any booted emulator, on a copy of the ramdisk.
 * The phone then boots with `-ramdisk <patched>` and Magisk's `su` gives root to the
 * shell, which is what the CA install and frida-server need.
 *
 * Binaries come from the official Magisk release APK, downloaded at runtime (pinned
 * version), so nothing Magisk is bundled or re-hosted by Sideglass. Magisk is
 * GPL-3.0; the patch steps below are Sideglass's own implementation of the publicly
 * documented cpio/magiskboot sequence.
 */

export const MAGISK_VERSION = 'v31.1'
/** Official Magisk-v31.1.apk digest from the GitHub release. */
const MAGISK_APK_SHA256 = '89cefac0a318afa39fb3880c45c87b036c05bc1ebf02a7a715b7f8d7c26ac6e7'
/** A patched ramdisk is a gzip image well above a truncated pull. */
const MIN_RAMDISK_BYTES = 256 * 1024

export const MAGISK_PACKAGE = 'com.topjohnwu.magisk'
const APK_URL = `https://github.com/topjohnwu/Magisk/releases/download/${MAGISK_VERSION}/Magisk-${MAGISK_VERSION}.apk`

/** Files in the APK's lib/<abi>/ that the ramdisk patch needs, under their working names. */
const APK_LIBS: Record<string, string> = {
  'libbusybox.so': 'busybox',
  'libmagisk.so': 'magisk',
  'libmagiskinit.so': 'magiskinit',
  'libmagiskboot.so': 'magiskboot',
  'libinit-ld.so': 'init-ld',
}

export interface MagiskArtifacts {
  dir: string
  apk: string
  binaries: string[]
}

export function magiskDir(dataDir: string): string {
  return join(dataDir, 'magisk')
}

/** Where patchedRamdisk would cache its result — lets the boot step reuse it without patching. */
export function cachedRamdiskPath(dataDir: string, sourceRamdisk: string): string {
  const st = statSync(sourceRamdisk)
  return join(magiskDir(dataDir), `ramdisk-${MAGISK_VERSION}-${st.size}-${st.mtimeMs}.img`)
}

/** True when [path] is a complete gzip image, not a pull that died mid-write. */
export function ramdiskUsable(path: string): boolean {
  if (!existsSync(path) || statSync(path).size < MIN_RAMDISK_BYTES) return false
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(2)
    return readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x1f && head[1] === 0x8b
  } finally {
    closeSync(fd)
  }
}

/** Is the Magisk manager app installed on the phone? */
export async function magiskAppInstalled(adb: Adb): Promise<boolean> {
  const out = await adb.shell(`pm path ${MAGISK_PACKAGE}`).catch(() => '')
  return out.trim().startsWith('package:')
}

/**
 * Play Protect flags Magisk's manager as harmful and can remove it — even while the phone
 * sits idle between runs. This is a disposable test phone, so its app scans are turned off
 * once here; installs and updates from the store itself keep working.
 */
export async function disablePlayProtectScans(adb: Adb): Promise<void> {
  await adb.shell('settings put global package_verifier_enable 0').catch(() => undefined)
  await adb.shell('settings put global verifier_verify_adb_installs 0').catch(() => undefined)
}

/**
 * The emulator's host-side Bluetooth simulation (netsim) is not always available on a boot
 * — a stale netsimd can keep holding the packet-streamer port — and then the guest Bluetooth
 * stack finds no HCI controller and crash-loops with a "Bluetooth keeps stopping" dialog
 * (SIGABRT in bt_stack_manage, "Can't start stack ... starting HciHal"). A capture phone has
 * no use for Bluetooth, so its package is switched off; the disable survives reboots.
 */
export async function disableBluetoothStack(adb: Adb): Promise<void> {
  await adb.shell('pm disable-user --user 0 com.android.bluetooth').catch(() => undefined)
}

/**
 * Launch the Magisk manager. "Activity does not exist" means either the package was really
 * removed (Play Protect) or a fresh boot has not finished scanning packages yet — wait and
 * retry when it is present, reinstall from our own copy when it is gone.
 */
async function openMagiskApp(adb: Adb, apk: string, log: (l: string) => void): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const out = await adb
      .shell(`am start -n ${MAGISK_PACKAGE}/com.topjohnwu.magisk.ui.MainActivity`)
      .catch((e: Error) => e.message)
    if (!/does not exist|not been installed|Error type 3/i.test(out)) return
    if (await magiskAppInstalled(adb)) {
      log('Waiting for the Magisk app to finish loading...')
      await sleep(10_000)
    } else {
      log('The Magisk app is missing (Play Protect may have removed it) — installing it again...')
      await adb.exec(['install', '-r', apk], 300_000)
      await sleep(3000)
    }
  }
  throw new Error('The Magisk app would not start. Reinstall it manually and retry.')
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Download the release APK once and extract the binaries the patch needs for [abi]. */
export async function ensureArtifacts(dataDir: string, log: (l: string) => void, abi: string): Promise<MagiskArtifacts> {
  const dir = magiskDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const apk = join(dir, `Magisk-${MAGISK_VERSION}.apk`)
  const apkOk = existsSync(apk) && sha256(readFileSync(apk)) === MAGISK_APK_SHA256
  if (!apkOk) {
    log(`Downloading Magisk ${MAGISK_VERSION} (about 11 MB)...`)
    const response = await fetch(APK_URL)
    if (!response.ok) throw new Error(`Magisk download failed: HTTP ${response.status}`)
    const buf = Buffer.from(await response.arrayBuffer())
    if (sha256(buf) !== MAGISK_APK_SHA256) {
      throw new Error(`Magisk ${MAGISK_VERSION} download did not match the published SHA-256`)
    }
    writeFileSync(apk, buf)
    for (const name of readdirSync(dir)) {
      if (name.startsWith('bin-')) rmSync(join(dir, name), { recursive: true, force: true })
    }
  }
  const bin = join(dir, `bin-${abi}`)
  const missing = Object.values(APK_LIBS).filter((name) => !existsSync(join(bin, name)))
  if (missing.length || !existsSync(bin)) {
    rmSync(bin, { recursive: true, force: true })
    mkdirSync(bin, { recursive: true })
    const result = spawnSync('unzip', ['-o', '-q', apk, `lib/${abi}/*`, '-d', dir], { timeout: 120_000 })
    if (result.status !== 0) throw new Error(`Could not unzip the Magisk APK (is unzip installed?): ${result.stderr}`)
    for (const [lib, name] of Object.entries(APK_LIBS)) {
      copyFileSync(join(dir, 'lib', abi, lib), join(bin, name))
    }
    rmSync(join(dir, 'lib'), { recursive: true, force: true })
  }
  return { dir, apk, binaries: Object.values(APK_LIBS).map((n) => join(bin, n)) }
}

/**
 * Patch a copy of the capture phone's ramdisk to boot Magisk. Runs on a booted
 * emulator (the patch needs no root) and caches the result per Magisk version +
 * source ramdisk, so it happens once per image/Magisk update.
 */
export async function patchedRamdisk(
  adb: Adb,
  dataDir: string,
  sourceRamdisk: string,
  log: (l: string) => void,
  abi: string,
): Promise<string> {
  const target = cachedRamdiskPath(dataDir, sourceRamdisk)
  if (ramdiskUsable(target)) return target
  rmSync(target, { force: true })

  const artifacts = await ensureArtifacts(dataDir, log, abi)
  const remote = '/data/local/tmp/.sgmagisk'
  log('Patching the boot ramdisk for Magisk (first time only, a few seconds)...')
  await adb.exec(['shell', `rm -rf ${remote} && mkdir ${remote}`])
  await adb.exec(['push', ...artifacts.binaries, remote + '/'])
  await adb.exec(['push', sourceRamdisk, `${remote}/ramdisk.img`])
  const patchScript = join(artifacts.dir, 'sg-patch.sh')
  writeFileSync(patchScript, patchShell())
  await adb.exec(['push', patchScript, `${remote}/patch.sh`])
  // adb push keeps the local 644 mode; the patch needs its binaries executable.
  await adb.shell(`chmod 755 ${remote}/busybox ${remote}/magisk ${remote}/magiskinit ${remote}/magiskboot ${remote}/init-ld ${remote}/patch.sh`)
  const out = await adb.shell(`ASH_STANDALONE=1 ${remote}/busybox sh ${remote}/patch.sh`, 180_000)
  if (!out.includes('SIDEGLASS_MAGISK_PATCH_OK')) throw new Error(`ramdisk patch failed:\n${out}`)
  const partial = `${target}.part`
  rmSync(partial, { force: true })
  try {
    await adb.exec(['pull', `${remote}/ramdisk-magisk.img`, partial])
    if (!ramdiskUsable(partial)) throw new Error('Patched ramdisk is incomplete')
    renameSync(partial, target)
  } catch (error) {
    rmSync(partial, { force: true })
    rmSync(target, { force: true })
    throw error
  }
  await adb.shell(`rm -rf ${remote}`)
  log('Ramdisk patched')
  return target
}

/**
 * The patch, in our own words: decompress the gzip ramdisk to cpio, write Magisk's
 * config (AVD-safe: keep verity and force-encrypt alone; API 28's RECOVERYMODE branch
 * does not apply on API 35), xz-compress the Magisk binaries into the init overlay,
 * rewrite /init to magiskinit, record the original as backup, and gzip the result.
 * The exact sequence mirrors Magisk's documented AVD integration for API 29+.
 */
function patchShell(): string {
  return `cd /data/local/tmp/.sgmagisk || exit 1
chmod 755 busybox magisk magiskinit magiskboot init-ld || exit 1
rm -f work.cpio work.cpio.orig config magisk.xz init-ld.xz ramdisk-magisk.img

./magiskboot decompress ramdisk.img work.cpio || exit 1
cp work.cpio work.cpio.orig

export KEEPVERITY=true
export KEEPFORCEENCRYPT=true
echo "KEEPVERITY=true" > config
echo "KEEPFORCEENCRYPT=true" >> config
echo "PREINITDEVICE=$(./magisk --preinit-device)" >> config

./magiskboot compress=xz magisk magisk.xz || exit 1
./magiskboot compress=xz init-ld init-ld.xz || exit 1

./magiskboot cpio work.cpio \\
  "add 0750 init magiskinit" \\
  "mkdir 0750 overlay.d" \\
  "mkdir 0750 overlay.d/sbin" \\
  "add 0644 overlay.d/sbin/magisk.xz magisk.xz" \\
  "add 0644 overlay.d/sbin/init-ld.xz init-ld.xz" \\
  "patch" \\
  "backup work.cpio.orig" \\
  "mkdir 000 .backup" \\
  "add 000 .backup/.magisk config" || exit 1

rm -f work.cpio.orig config magisk.xz init-ld.xz
./magiskboot compress=gzip work.cpio ramdisk-magisk.img || exit 1
echo SIDEGLASS_MAGISK_PATCH_OK
`
}

/** Is `su` already granted to the shell user? */
export async function suGranted(adb: Adb): Promise<boolean> {
  const out = await adb.shell('su -c id -u').catch(() => '')
  return out.trim() === '0'
}

/**
 * Grant superuser to the shell user by driving the Magisk app's own UI with adb taps
 * (the app no longer shows reactive prompts): open the app, accept its one-time
 * "additional setup" (which reboots the phone), then Superuser tab → add → tick Shell.
 * Every tap is placed by reading the screen with uiautomator, so it works at any
 * resolution; if the UI cannot be driven, the promise rejects and the user is told
 * how to do the two taps themselves.
 */
export async function grantSu(
  adb: Adb,
  apk: string,
  log: (l: string) => void,
  timeoutMs = 10 * 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let rebootedForSetup = false
  while (Date.now() < deadline) {
    // The phone may be restarting (Magisk's setup reboot) — wait it out before anything.
    const ready = await adb.shell('true').then(() => true).catch(() => false)
    if (!ready) {
      log('Waiting for the phone to finish rebooting...')
      await adb.waitForBoot()
      continue
    }
    if (await suGranted(adb)) return

    // Bring the Magisk app to the front (it may be closed after a setup reboot, or
    // freshly booted — PackageManager can lag behind boot_completed for a few seconds).
    await openMagiskApp(adb, apk, log)
    await new Promise((r) => setTimeout(r, 2500))

    const xml = await dumpUi(adb)
    if (!xml) {
      log('Waiting for the Magisk app to settle...')
      await sleep(4000)
      continue
    }

    // One-time dialogs first.
    if (await tapByText(adb, xml, 'Allow')) {
      log('Allowed Magisk notifications')
      await sleep(1500)
      continue
    }
    const setupDialog = /additional setup for Magisk/.test(xml)
    if (setupDialog && (await tapByText(adb, xml, 'OK'))) {
      log('Magisk asked for a one-time setup reboot — accepting; the phone restarts...')
      rebootedForSetup = true
      await sleep(4000)
      await adb.waitForBoot()
      log('Phone is back up')
      continue
    }
    if (setupDialog && (await tapByText(adb, xml, 'Cancel'))) {
      log('Magisk setup dialog is showing; retrying...')
      await sleep(2000)
      continue
    }

    // The grant list, or the Superuser list with the Shell row: tick the switch — but
    // only when it is off (suGranted() is the source of truth for "on").
    if (await tapShellCheckbox(adb, xml)) {
      log('Granted superuser to Shell')
      await sleep(2500)
      continue
    }

    // Superuser tab: the add control is the FAB labelled "Grant Superuser".
    if (await tapByText(adb, xml, 'Grant Superuser')) {
      log('Opened the grant list')
      await sleep(2500)
      continue
    }
    if (/No apps have asked for Superuser permission yet/.test(xml)) {
      const add = pickAddButton(xml)
      if (add) {
        await adb.shell(`input tap ${add.x} ${add.y}`)
        log('Opened the grant list')
        await sleep(2500)
        continue
      }
    }

    // Any other Magisk screen (e.g. Home after opening the app): go to the Superuser tab.
    if (await tapByText(adb, xml, 'Superuser')) {
      log('Opened the Superuser tab')
      await sleep(2000)
      continue
    }

    await sleep(3000)
  }
  throw new Error(
    rebootedForSetup
      ? 'Shell superuser was not granted in time. Open the Magisk app → Superuser → ＋ and enable "Shell", then retry.'
      : 'Could not reach the Magisk app in time. Open it once, complete its setup, then retry.',
  )
}

/** A fresh uiautomator dump, or '' when it could not be read (never a stale file). */
async function dumpUi(adb: Adb): Promise<string> {
  const path = '/sdcard/sideglass-magisk-ui.xml'
  await adb.shell(`rm -f ${path}`).catch(() => undefined)
  const out = await adb.shell(`uiautomator dump ${path} >/dev/null 2>&1 && cat ${path}`).catch(() => '')
  return out.includes('<hierarchy') ? out : ''
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface Point {
  x: number
  y: number
}

function center(bounds: string): Point | null {
  const m = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(bounds)
  if (!m) return null
  return { x: Math.round((Number(m[1]) + Number(m[3])) / 2), y: Math.round((Number(m[2]) + Number(m[4])) / 2) }
}

function nodeBounds(node: string): string | null {
  return /bounds="[^"]+"/.exec(node)?.[0] ?? null
}

/** Tap a node whose text or content-desc equals [text]: the node itself if it is clickable
 * (dialog buttons), else the smallest clickable ancestor containing it (Compose wraps nav
 * labels in clickable containers — and toolbar titles have none, so every match gets its
 * turn instead of giving up on the first). */
async function tapByText(adb: Adb, xml: string, text: string): Promise<boolean> {
  const nodes = [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0])
  const hits = nodes.filter((n) => new RegExp(`(text|content-desc)="${text}"`).test(n) && /enabled="true"/.test(n))
  for (const hit of hits) {
    const tb = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(hit)
    if (!tb) continue
    const midX = (Number(tb[1]) + Number(tb[3])) / 2
    const midY = (Number(tb[2]) + Number(tb[4])) / 2
    if (/clickable="true"/.test(hit)) {
      await adb.shell(`input tap ${Math.round(midX)} ${Math.round(midY)}`)
      return true
    }
    let target: { x: number; y: number; area: number } | null = null
    for (const n of nodes) {
      if (!/clickable="true"/.test(n)) continue
      const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n)
      if (!b) continue
      if (midX < Number(b[1]) || midX > Number(b[3]) || midY < Number(b[2]) || midY > Number(b[4])) continue
      const area = (Number(b[3]) - Number(b[1])) * (Number(b[4]) - Number(b[2]))
      if (!target || area < target.area) {
        target = { x: (Number(b[1]) + Number(b[3])) / 2, y: (Number(b[2]) + Number(b[4])) / 2, area }
      }
    }
    if (target) {
      await adb.shell(`input tap ${Math.round(target.x)} ${Math.round(target.y)}`)
      return true
    }
  }
  return false
}

/** Geometric fallback for the Superuser ＋ when its "Grant Superuser" label is missing. */
function pickAddButton(xml: string): Point | null {
  const nodes = [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0])
  // Screen size from the root frame (some dumps give <hierarchy> no bounds attribute).
  const screen = /<node [^>]*bounds="\[0,0\]\[(\d+),(\d+)\]"/.exec(xml)
  if (!screen) return null
  const width = Number(screen[1])
  const height = Number(screen[2])
  const items = nodes
    .filter((n) => /clickable="true"/.test(n) && /enabled="true"/.test(n))
    .map((n) => /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n))
    .filter((b): b is RegExpExecArray => b !== null)
    .map((b) => ({ x1: Number(b[1]), y1: Number(b[2]), x2: Number(b[3]), y2: Number(b[4]) }))
  // Bottom navigation: a band holding three or more clickables in the lower quarter.
  // If that band is not detected, still ignore the bottom strip so a nav tab cannot win.
  let navTop = height * 0.9
  const bands = new Map<string, number>()
  for (const it of items) {
    const midY = (it.y1 + it.y2) / 2
    if (midY <= 0.75 * height) continue
    const key = `${it.y1}-${it.y2}`
    bands.set(key, (bands.get(key) ?? 0) + 1)
  }
  for (const [key, count] of bands) {
    if (count < 3) continue
    navTop = Math.min(navTop, Number(key.split('-')[0]))
  }
  let best: { at: Point; score: number } | null = null
  for (const it of items) {
    const midY = (it.y1 + it.y2) / 2
    if (midY >= navTop - 8) continue
    const at = { x: Math.round((it.x1 + it.x2) / 2), y: Math.round((it.y1 + it.y2) / 2) }
    const score = at.x / width + at.y / height
    if (score > (best?.score ?? 0)) best = { at, score }
  }
  return best?.at ?? null
}

/** Tick the switch of the row labelled "Shell" — a checkable node covering the label's height. */
async function tapShellCheckbox(adb: Adb, xml: string): Promise<boolean> {
  const nodes = [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0])
  const shell = nodes.find((n) => /text="Shell"/.test(n))
  if (!shell) return false
  const shellBounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(nodeBounds(shell) ?? '')
  if (!shellBounds) return false
  const shellMidY = (Number(shellBounds[2]) + Number(shellBounds[4])) / 2
  // The row's toggle: a checkable, clickable node whose vertical range covers the label.
  const toggle = nodes.find((n) => {
    if (!/checkable="true"/.test(n) || !/clickable="true"/.test(n)) return false
    if (/checked="true"/.test(n)) return false
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n)
    if (!b) return false
    return shellMidY >= Number(b[2]) && shellMidY <= Number(b[4])
  })
  if (!toggle) return false
  const at = center(nodeBounds(toggle)!)
  if (!at) return false
  await adb.shell(`input tap ${at.x} ${at.y}`)
  return true
}
