// Talks to frida-server for the Electron app. Electron's Node ABI does not match
// the frida prebuild, so this process runs under system Node.
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import * as frida from 'frida'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const sessions = new Map()
let device = null
let compiled = null
let compiledFrom = ''
let gating = null

function projectRoot() {
  try {
    // .../node_modules/frida-java-bridge/package.json → the app root that contains node_modules.
    return dirname(dirname(dirname(require.resolve('frida-java-bridge/package.json'))))
  } catch {
    return dirname(here)
  }
}

async function remote(port) {
  if (device) return device
  const manager = await frida.getDeviceManager()
  device = await manager.addRemoteDevice(`127.0.0.1:${port}`)
  return device
}

/** Frida 17 does not define `Java` until the bridge is bundled into the agent. */
async function agentBundle(source) {
  if (compiled && compiledFrom === source) return compiled
  // The compiler rejects an entry file outside its project root, and that root has to be
  // the app checkout so `frida-java-bridge` resolves. node_modules is not watched or committed.
  const root = projectRoot()
  const file = join(root, 'node_modules', '.sideglass-hooks-agent.mjs')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `import Java from 'frida-java-bridge'\n${source}`)
  const compiler = new frida.Compiler()
  const diagnostics = []
  compiler.diagnostics.connect((diag) => diagnostics.push(diag))
  let bundle
  try {
    bundle = await compiler.build(file, { projectRoot: root })
  } finally {
    rmSync(file, { force: true })
  }
  if (!bundle || !bundle.includes('sideglass hooks loaded')) {
    throw new Error(`Hooks agent did not compile. ${JSON.stringify(diagnostics).slice(0, 500)}`)
  }
  compiled = bundle
  compiledFrom = source
  return bundle
}

function watchScript(script, label) {
  script.message.connect((scriptMessage) => {
    const payload = scriptMessage && scriptMessage.payload
    const pkg = payload && payload.pkg ? payload.pkg : label
    process.stderr.write(`${JSON.stringify({ sg: 'script', pkg, message: scriptMessage })}\n`)
  })
}

async function callPrepare(script) {
  const prepare = script.exports && script.exports.prepare
  if (typeof prepare !== 'function') throw new Error('Hooks script has no prepare export')
  await prepare()
}

async function spawnApp(message) {
  if (!/^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/.test(message.pkg)) throw new Error(`Invalid package name: ${message.pkg}`)
  if (gating) throw new Error('App starts are already hooked from the phone')
  const source = await agentBundle(message.source)
  const dev = await remote(message.port)
  let pid = null
  try {
    pid = await dev.spawn(message.pkg)
    const session = await dev.attach(pid)
    const script = await session.createScript(source)
    watchScript(script, message.pkg)
    await script.load()
    // Spawn pauses before the app runs, so the bindApplication hook has to be in place first.
    await callPrepare(script)
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

/**
 * Pause every process zygote forks, load the agent, then let it run.
 * An icon tap forks zygote the same way a launch from the list does.
 * Resume is unconditional: a child left paused freezes that app.
 */
async function instrument(dev, source, pid) {
  let resumed = false
  const resume = async () => {
    if (resumed) return
    resumed = true
    await dev.resume(pid).catch(() => undefined)
  }
  const timer = setTimeout(() => void resume(), 8_000)
  try {
    const session = await dev.attach(pid)
    const script = await session.createScript(source)
    watchScript(script, String(pid))
    await script.load()
    sessions.set(pid, { session, script })
    // The child is still a paused zygote fork. Java.perform here deadlocks, so resume first.
    await resume()
    await callPrepare(script)
  } catch (error) {
    process.stderr.write(`hook ${pid}: ${error instanceof Error ? error.message : error}\n`)
  } finally {
    clearTimeout(timer)
    await resume()
  }
}

async function gate(message) {
  if (gating) return {}
  const source = await agentBundle(message.source)
  const dev = await remote(message.port)
  const signal = dev.childAdded
  if (!signal || typeof signal.connect !== 'function') throw new Error('This Frida build cannot watch new app processes')
  const onChild = (child) => {
    const pid = child && child.pid
    if (!pid) return
    void instrument(dev, source, pid)
  }
  const onChildGone = (child) => {
    const pid = child && child.pid
    if (!pid) return
    const item = sessions.get(pid)
    if (!item) return
    sessions.delete(pid)
    void item.script.unload().catch(() => undefined)
    void item.session.detach().catch(() => undefined)
  }
  // connect() returns nothing. disconnect() takes the same function.
  signal.connect(onChild)
  if (dev.childRemoved && typeof dev.childRemoved.connect === 'function') dev.childRemoved.connect(onChildGone)
  const attached = []
  try {
    for (const name of ['zygote64', 'zygote']) {
      try {
        const session = await dev.attach(name)
        if (typeof session.enableChildGating !== 'function') throw new Error('enableChildGating is missing')
        await session.enableChildGating()
        attached.push(session)
        process.stderr.write(`Watching ${name} for app starts\n`)
      } catch (error) {
        process.stderr.write(`${name}: ${error instanceof Error ? error.message : error}\n`)
      }
    }
    if (!attached.length) throw new Error('Could not attach to zygote')
  } catch (error) {
    signal.disconnect(onChild)
    if (dev.childRemoved && typeof dev.childRemoved.disconnect === 'function') dev.childRemoved.disconnect(onChildGone)
    throw error
  }
  gating = { signal, onChild, onChildGone, removed: dev.childRemoved, sessions: attached }
  return {}
}

async function ungate() {
  const current = gating
  gating = null
  if (!current) return {}
  current.signal.disconnect(current.onChild)
  if (current.removed && typeof current.removed.disconnect === 'function') current.removed.disconnect(current.onChildGone)
  await Promise.all(current.sessions.map((session) => session.disableChildGating?.().catch(() => undefined)))
  await Promise.all(current.sessions.map((session) => session.detach().catch(() => undefined)))
  return {}
}

async function stopAll() {
  await ungate().catch(() => undefined)
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
  if (message.cmd === 'gate') return { ok: true, ...(await gate(message)) }
  if (message.cmd === 'ungate') return { ok: true, ...(await ungate()) }
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
