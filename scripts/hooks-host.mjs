// Talks to frida-server for the Electron app. Electron's Node ABI does not match
// the frida prebuild, so this process runs under system Node.
import * as frida from 'frida'
import readline from 'node:readline'

const sessions = new Map()
let device = null

async function remote(port) {
  if (device) return device
  const manager = await frida.getDeviceManager()
  device = await manager.addRemoteDevice(`127.0.0.1:${port}`)
  return device
}

async function spawnApp(message) {
  if (!/^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/.test(message.pkg)) throw new Error(`Invalid package name: ${message.pkg}`)
  const dev = await remote(message.port)
  let pid = null
  try {
    pid = await dev.spawn(message.pkg)
    const session = await dev.attach(pid)
    const script = await session.createScript(message.source)
    script.message.connect((scriptMessage) => {
      process.stderr.write(`${JSON.stringify({ sg: 'script', pkg: message.pkg, message: scriptMessage })}\n`)
    })
    await script.load()
    await dev.resume(pid)
    const prior = sessions.get(message.pkg)
    sessions.set(message.pkg, { session, script })
    if (prior) {
      await prior.script.unload().catch(() => undefined)
      await prior.session.detach().catch(() => undefined)
    }
    return { pid }
  } catch (error) {
    if (pid != null) await dev.kill(pid).catch(() => undefined)
    throw error
  }
}

async function stopAll() {
  device = null
  const open = [...sessions.values()]
  sessions.clear()
  await Promise.all(
    open.map(async (item) => {
      await item.script.unload().catch(() => undefined)
      await item.session.detach().catch(() => undefined)
    }),
  )
  return {}
}

async function handle(message) {
  if (message.cmd === 'ping') return { ok: true }
  if (message.cmd === 'spawn') return { ok: true, ...(await spawnApp(message)) }
  if (message.cmd === 'stop') return { ok: true, ...(await stopAll()) }
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
    (error) =>
      process.stdout.write(
        `${JSON.stringify({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
      ),
  )
})
