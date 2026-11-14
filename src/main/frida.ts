import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Pinned to the exact `frida` npm version in package.json: client and server must match. */
export const FRIDA_VERSION = '17.26.2'

/**
 * SHA-256 of the official `.xz` release files (the digests GitHub publishes for the 17.26.2
 * assets). frida-server runs as root on the phone, so anything else is refused.
 */
const SERVER_XZ_SHA256: Record<string, string> = {
  'android-arm64': '84519c157b76b9050cfcf197b530288040f8dca34d66341f5d5a688f792a3af9',
  'android-x86_64': '1f03e1bd3800618f6e6b4a978b84a7d093a2bdefd42722eb3f27e4c3bbfd2139',
}

export function fridaArch(abi: string): string | null {
  switch (abi.trim()) {
    case 'arm64-v8a':
      return 'android-arm64'
    case 'armeabi-v7a':
      return 'android-arm'
    case 'x86_64':
      return 'android-x86_64'
    case 'x86':
      return 'android-x86'
    default:
      return null
  }
}

export function serverAsset(arch: string): string {
  return `frida-server-${FRIDA_VERSION}-${arch}`
}

export function serverUrl(arch: string): string {
  return `https://github.com/frida/frida/releases/download/${FRIDA_VERSION}/${serverAsset(arch)}.xz`
}

export function isElf(bytes: Uint8Array): boolean {
  return bytes.length > 1024 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
}

export function isXz(bytes: Uint8Array): boolean {
  return bytes.length > 6 && bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a && bytes[3] === 0x58 && bytes[4] === 0x5a && bytes[5] === 0x00
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Is this the official release file for `arch`? False for an arch without a pinned digest. */
export function trustedServerXz(arch: string, bytes: Uint8Array): boolean {
  const want = SERVER_XZ_SHA256[arch]
  return Boolean(want) && sha256(bytes) === want
}

/** xz via Python. macOS and Linux have python3; the Frida release files are xz-compressed. */
export function decompressXz(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', 'import lzma,sys; sys.stdout.buffer.write(lzma.decompress(sys.stdin.buffer.read()))'])
    const chunks: Buffer[] = []
    let error = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error.trim() || `xz decode failed (${code})`))))
    child.stdin.write(bytes)
    child.stdin.end()
  })
}

/**
 * The frida-server binary for `arch`, downloaded once into `cacheDir`. The download must match
 * the pinned digest before it is unpacked; the unpacked copy is reused on later runs.
 */
export async function fridaServerBinary(
  cacheDir: string,
  arch: string,
  log: (line: string) => void = () => undefined,
): Promise<string> {
  const path = join(cacheDir, serverAsset(arch))
  if (existsSync(path)) return path
  if (!SERVER_XZ_SHA256[arch]) throw new Error(`No pinned frida-server build for ${arch}`)
  await mkdir(cacheDir, { recursive: true })
  log(`Downloading frida-server ${FRIDA_VERSION} (${arch})...`)
  const response = await fetch(serverUrl(arch), { signal: AbortSignal.timeout(300_000), headers: { 'user-agent': 'sideglass' } })
  if (!response.ok) throw new Error(`frida-server download failed: HTTP ${response.status}`)
  const compressed = Buffer.from(await response.arrayBuffer())
  if (!isXz(compressed) || !trustedServerXz(arch, compressed)) {
    throw new Error(`frida-server ${FRIDA_VERSION} download did not match the published SHA-256`)
  }
  const binary = await decompressXz(compressed)
  if (!isElf(binary)) throw new Error('frida-server did not unpack to an ELF binary')
  // Written last and in one go, so a half-finished download is never mistaken for the binary.
  await writeFile(`${path}.part`, binary, { mode: 0o755 })
  await rename(`${path}.part`, path)
  return path
}
