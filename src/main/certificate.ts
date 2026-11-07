import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate } from '@peculiar/x509'
import { generateCACertificate } from 'mockttp'
import type { Adb } from './adb'

export interface CaFiles {
  key: string
  cert: string
  /** Android's file name for this CA: OpenSSL subject_hash_old + ".0". */
  androidName: string
}

/** Our own CA, made once per install and kept in the app's data folder. */
export async function loadOrCreateCa(dir: string): Promise<CaFiles> {
  mkdirSync(dir, { recursive: true })
  const keyPath = join(dir, 'ca.key')
  const certPath = join(dir, 'ca.pem')
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const ca = await generateCACertificate({
      subject: { commonName: 'sideglass local CA (do not trust elsewhere)', organizationName: 'sideglass' },
    })
    writeFileSync(keyPath, ca.key, { mode: 0o600 })
    writeFileSync(certPath, ca.cert)
  }
  const cert = readFileSync(certPath, 'utf8')
  return { key: readFileSync(keyPath, 'utf8'), cert, androidName: `${subjectHashOld(cert)}.0` }
}

/** OpenSSL's subject_hash_old: first 4 bytes of MD5(DER subject), little-endian, as hex. */
export function subjectHashOld(pem: string): string {
  const subject = Buffer.from(new X509Certificate(pem).subjectName.toArrayBuffer())
  const md5 = createHash('md5').update(subject).digest()
  return Buffer.from([md5[3], md5[2], md5[1], md5[0]]).toString('hex')
}

/**
 * Make every app on the (rooted) device trust our CA as a system CA, without touching the
 * system image. A tmpfs copy of the system store plus our CA is mounted over the system
 * store, and on Android 14+ also over the Conscrypt APEX store inside init's and each
 * zygote's mount namespace, so apps started afterwards see it. Running apps must restart.
 */
export async function installSystemCa(adb: Adb, ca: CaFiles): Promise<void> {
  const remotePem = `/data/local/tmp/${ca.androidName}`
  const script = '/data/local/tmp/sideglass-ca.sh'
  const local = join(process.env.TMPDIR ?? '/tmp', `sideglass-${ca.androidName}`)
  writeFileSync(local, ca.cert)
  await adb.exec(['push', local, remotePem])
  const scriptLocal = join(process.env.TMPDIR ?? '/tmp', 'sideglass-ca.sh')
  writeFileSync(scriptLocal, caScript(ca.androidName))
  await adb.exec(['push', scriptLocal, script])
  const out = await adb.shell(`sh ${script}`, 60_000)
  if (!out.includes('SIDEGLASS_CA_OK')) throw new Error(`CA install failed:\n${out}`)
}

export function caScript(name: string): string {
  return `#!/system/bin/sh
NAME=${name}
PEM=/data/local/tmp/$NAME
WORK=/data/local/tmp/sideglass-cacerts
APEX=/apex/com.android.conscrypt/cacerts
SYS=/system/etc/security/cacerts

# 1. In this (init's) mount namespace: a tmpfs copy of the store plus our CA over the system store.
if [ ! -f "$SYS/$NAME" ]; then
  rm -rf "$WORK" && mkdir -p "$WORK"
  if [ -d "$APEX" ]; then cp "$APEX"/* "$WORK"/; else cp "$SYS"/* "$WORK"/; fi
  cp "$PEM" "$WORK/$NAME"
  mount -t tmpfs tmpfs "$SYS" || exit 1
  cp "$WORK"/* "$SYS"/
  chown root:root "$SYS"/*
  chmod 644 "$SYS"/*
  chcon u:object_r:system_file:s0 "$SYS" "$SYS"/*
fi

# 2. Android 14+ reads the Conscrypt APEX store. Every process has its own mount namespace
#    (zygotes, and each app forked from them), so bind our store over the APEX store in each
#    namespace that does not have it yet: running apps see it without a restart.
if [ -d "$APEX" ]; then
  [ -f "$APEX/$NAME" ] || mount --bind "$SYS" "$APEX"
  DONE=" "
  for p in /proc/[0-9]*; do
    pid=\${p#/proc/}
    ns=$(readlink "$p/ns/mnt" 2>/dev/null) || continue
    case "$DONE" in *" $ns "*) continue ;; esac
    DONE="$DONE$ns "
    nsenter --mount="$p/ns/mnt" -- /system/bin/sh -c "[ -f $APEX/$NAME ] || /system/bin/mount --bind $SYS $APEX" 2>/dev/null
  done
fi

[ -f "$SYS/$NAME" ] && echo SIDEGLASS_CA_OK
`
}
