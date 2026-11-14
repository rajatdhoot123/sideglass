// Talks to frida-server for the Electron app. Electron's Node ABI does not match
// the frida prebuild, so this process runs under system Node.
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
let compiling = null
let gating = null
let gatePending = null
let entrySeq = 0

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
  // Gate and spawn can ask at the same time. One compile serves both.
  if (compiling && compiling.source === source) return compiling.promise
  const promise = compileAgent(source).finally(() => {
    if (compiling && compiling.promise === promise) compiling = null
  })
  compiling = { source, promise }
  return promise
}

async function compileAgent(source) {
  const text = `import Java from 'frida-java-bridge'\n${source}`
  const root = projectRoot()
  const name = `.sideglass-hooks-agent-${process.pid}-${++entrySeq}.mjs`
  let bundle
  try {
    // The compiler rejects an entry file outside its project root, and that root has to
    // contain node_modules so `frida-java-bridge` resolves. A checkout can write there.
    const file = join(root, 'node_modules', name)
    writeFileSync(file, text)
    try {
      bundle = await build(file, root)
    } finally {
      rmSync(file, { force: true })
    }
  } catch (error) {
    if (!isWriteError(error)) throw error
    // An installed app's folder is often read-only. Build from a temp root that links to it.
    const temp = mkdtempSync(join(tmpdir(), 'sideglass-hooks-'))
    try {
      symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'junction')
      const file = join(temp, name)
      writeFileSync(file, text)
      bundle = await build(file, temp)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }
  compiled = bundle
  compiledFrom = source
  return bundle
}

function isWriteError(error) {
  return Boolean(error && ['EACCES', 'EPERM', 'EROFS', 'ENOENT'].includes(error.code))
}

async function build(file, root) {
  const compiler = new frida.Compiler()
  const diagnostics = []
  compiler.diagnostics.connect((diag) => diagnostics.push(diag))
  const bundle = await compiler.build(file, { projectRoot: root })
  if (!bundle || !bundle.includes('sideglass hooks loaded')) {
    throw new Error(`Hooks agent did not compile. ${JSON.stringify(diagnostics).slice(0, 500)}`)
  }
  return bundle
}

/**
 * Loaded into every zygote fork before the hooks agent. It waits for the fork to
 * become its final process, then reports the uid and name, so the large agent is
 * only loaded into user apps. Plain JS: it needs no compile.
 */
const PROBE_SOURCE = `
function exportOf(name) {
  if (typeof Module.getGlobalExportByName === 'function') return Module.getGlobalExportByName(name)
  return Module.getExportByName(null, name)
}
var getuid = new NativeFunction(exportOf('getuid'), 'uint', [])
var openFn = new NativeFunction(exportOf('open'), 'int', ['pointer', 'int'])
var readFn = new NativeFunction(exportOf('read'), 'int', ['int', 'pointer', 'int'])
var closeFn = new NativeFunction(exportOf('close'), 'int', ['int'])
var path = Memory.allocUtf8String('/proc/self/cmdline')
var buf = Memory.alloc(256)
function processName() {
  var fd = openFn(path, 0)
  if (fd < 0) return ''
  var n = readFn(fd, buf, 255)
  closeFn(fd)
  if (n <= 0) return ''
  buf.add(n).writeU8(0)
  return buf.readUtf8String() || ''
}
var ZYGOTE = /^(zygote64|zygote|usap64|usap|<pre-initialized>)$/
rpc.exports = {
  probe: function (timeoutMs) {
    var started = Date.now()
    return new Promise(function (resolve) {
      function check() {
        var uid = getuid()
        var name = processName()
        // Zygote runs as root. A fork is specialized once its uid and name have both changed.
        var settled = uid !== 0 && name && !ZYGOTE.test(name)
        if (settled || Date.now() - started > timeoutMs) resolve({ uid: uid, name: settled ? name : '' })
        else setTimeout(check, 20)
      }
      check()
    })
  },
}
`

/** App uids are 10000-19999 within a user. Isolated (99000+) and system processes are skipped. */
function isAppUid(uid) {
  const appId = Number(uid) % 100000
  return appId >= 10000 && appId <= 19999
}

const SKIP_NAME = /^(android|system_server|com\.android\.|com\.google\.android\.(gms|gsf|webview|ext\.))/

function wantsHooks(uid, name) {
  return isAppUid(uid) && Boolean(name) && !SKIP_NAME.test(name)
}

function watchScript(script, label) {
  script.message.connect((scriptMessage) => {
    const payload = scriptMessage && scriptMessage.payload
    const pkg = payload && payload.pkg ? payload.pkg : label
    process.stderr.write(`${JSON.stringify({ sg: 'script', pkg, message: scriptMessage })}\n`)
  })
}

async function callExport(script, name, ...args) {
  const fn = script.exports && script.exports[name]
  if (typeof fn !== 'function') throw new Error(`Hooks script has no ${name} export`)
  return fn(...args)
}

/** Forget a hooked process once it exits. */
function track(key, session, script) {
  const item = { session, script }
  sessions.set(key, item)
  session.detached.connect(() => {
    if (sessions.get(key) === item) sessions.delete(key)
  })
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
    // Spawn pauses before the app runs, so the Java hooks are queued first.
    await callExport(script, 'prepare', { pkg: message.pkg, running: false })
    await dev.resume(pid)
    // Native hooks wait for the process to run: patching them while paused crashed Flutter.
    await callExport(script, 'started').catch(() => undefined)
    const prior = sessions.get(message.pkg)
    track(message.pkg, session, script)
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
 * Every process zygote forks arrives here paused. A small probe finds out what it
 * becomes. Only user apps get the hooks agent; the rest are detached at once.
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
  let session = null
  let keep = false
  try {
    session = await dev.attach(pid)
    const probe = await session.createScript(PROBE_SOURCE)
    await probe.load()
    // The fork is still zygote until it runs. Java.perform here deadlocks, so resume first.
    await resume()
    const { uid, name } = await callExport(probe, 'probe', 5_000)
    await probe.unload().catch(() => undefined)
    if (!wantsHooks(uid, name)) return
    const script = await session.createScript(source)
    watchScript(script, name)
    await script.load()
    keep = true
    track(pid, session, script)
    await callExport(script, 'prepare', { pkg: name, running: true })
  } catch (error) {
    process.stderr.write(`hook ${pid}: ${error instanceof Error ? error.message : error}\n`)
  } finally {
    clearTimeout(timer)
    await resume()
    if (session && !keep) await session.detach().catch(() => undefined)
  }
}

function gate(message) {
  if (gating) return Promise.resolve({})
  // A second request while the first is attaching shares it, so zygote is watched once.
  gatePending ??= startGate(message).finally(() => {
    gatePending = null
  })
  return gatePending
}

async function startGate(message) {
  const source = await agentBundle(message.source)
  const dev = await remote(message.port)
  const signal = dev.childAdded
  if (!signal || typeof signal.connect !== 'function') throw new Error('This Frida build cannot watch new app processes')
  const onChild = (child) => {
    const pid = child && child.pid
    if (!pid) return
    void instrument(dev, source, pid)
  }
  // connect() returns nothing. disconnect() takes the same function.
  signal.connect(onChild)
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
    throw error
  }
  gating = { signal, onChild, sessions: attached }
  return {}
}

async function ungate() {
  await gatePending?.catch(() => undefined)
  const current = gating
  gating = null
  if (!current) return {}
  current.signal.disconnect(current.onChild)
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
// Sideglass closed (or crashed): detach from zygote and exit instead of lingering.
lines.on('close', () => {
  const exit = () => process.exit(0)
  setTimeout(exit, 3_000).unref()
  stopAll().then(exit, exit)
})
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
