// Talks to frida-server for the Electron app. Electron's Node ABI does not match
// the frida prebuild, so this runs under system Node.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import * as frida from 'frida'

const here = dirname(fileURLToPath(import.meta.url))
const sessions = []
let bundle = null

function projectRoot() {
  // The nearest folder above this script whose node_modules has frida-java-bridge. Not the
  // resolved package path: pnpm resolves it inside node_modules/.pnpm, outside the app root.
  for (let dir = dirname(here); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', 'frida-java-bridge', 'package.json'))) return dir
    if (dirname(dir) === dir) return dirname(here)
  }
}

async function agentSource() {
  if (bundle) return bundle
  const compiled = join(here, 'frida-agent.bundle.js')
  if (existsSync(compiled)) {
    bundle = readFileSync(compiled, 'utf8')
    return bundle
  }
  const compiler = new frida.Compiler()
  const diagnostics = []
  compiler.diagnostics.connect((diag) => diagnostics.push(diag))
  bundle = await compiler.build(join(here, 'frida-agent', 'index.mjs'), { projectRoot: projectRoot() })
  if (!bundle || !bundle.includes('TrustManagerImpl')) {
    throw new Error(`Frida agent did not compile. ${JSON.stringify(diagnostics).slice(0, 500)}`)
  }
  return bundle
}

async function deviceFor(serial) {
  const devices = await frida.enumerateDevices()
  const match = devices.find((device) => device.id === serial || device.name === serial)
  if (match) return match
  const listed = devices.map((device) => `${device.id} (${device.type})`).join(', ') || 'none'
  throw new Error(`Frida cannot see ${serial}. Devices: ${listed}`)
}

async function spawn(serial, pkg) {
  if (!/^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/.test(pkg)) throw new Error(`Invalid package name: ${pkg}`)
  const source = await agentSource()
  const device = await deviceFor(serial)
  let pid = null
  try {
    pid = await device.spawn(pkg)
    const session = await device.attach(pid)
    const script = await session.createScript(source)
    const notes = []
    script.message.connect((message) => {
      if (message.type === 'error') {
        const text = message.stack || message.description || 'script error'
        notes.push(text)
        console.error(text)
      } else if (message.type === 'send') {
        const text = JSON.stringify(message.payload)
        notes.push(text)
        console.error(text)
      }
    })
    await script.load()
    if (typeof script.exports.init !== 'function') throw new Error('Unpinning script has no init export')
    const nativeHooks = await script.exports.init(pkg)
    await device.resume(pid)
    sessions.push(session)
    return { pid, nativeHooks: Number(nativeHooks) || 0, notes }
  } catch (error) {
    if (pid != null) await device.kill(pid).catch(() => undefined)
    throw error
  }
}

async function handle(message) {
  if (message.cmd === 'ping') {
    await agentSource()
    return { ok: true }
  }
  if (message.cmd === 'spawn') {
    const result = await spawn(message.serial, message.pkg)
    return { ok: true, ...result }
  }
  if (message.cmd === 'stop') {
    await Promise.all(sessions.splice(0).map((session) => session.detach().catch(() => undefined)))
    return { ok: true }
  }
  return { ok: false, error: `Unknown command ${message.cmd}` }
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  handle(message).then(
    (result) => process.stdout.write(`${JSON.stringify({ id: message.id, ...result })}\n`),
    (error) => process.stdout.write(`${JSON.stringify({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`),
  )
})
