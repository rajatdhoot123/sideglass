// Certificate unpinning for an app Sideglass was asked to launch.
// This script is original. It uses Frida's Java bridge (LGPL-2.0 with the
// WxWindows exception). The HTTP Toolkit unpinning script is AGPL, so it is
// not included here.
import Java from 'frida-java-bridge'

const HEADER = 'X-Sideglass-App'

/** BoringSSL ssl_verify_ok, and X509_V_OK. A custom verify callback returns 0 to accept. */
const SSL_VERIFY_OK = 0
/** BoringSSL ssl_verify_none. SSL_CTX_set_custom_verify treats 0 as "do not verify". */
const SSL_VERIFY_NONE = 0

const acceptCert = new NativeCallback(function () {
  return SSL_VERIFY_OK
}, 'int', ['pointer', 'pointer'])

const hooked = new Set()

rpc.exports = {
  init(pkg) {
    const name = String(pkg)
    installJava(name)
    // Native verify hooks and the dlopen watcher are installed after the first
    // frame. Patching them before resume crashed Flutter's raster thread while
    // it dlopen'd the emulator GLES driver.
    setTimeout(() => {
      try {
        const nativeHooks = scanAll()
        hookLoader()
        send({ sideglass: 'native', hooks: nativeHooks })
      } catch (error) {
        send({ sideglass: 'native', error: String(error) })
      }
    }, 1500)
    return 0
  },
}

function installJava(pkg) {
  if (!Java.available) return
  // Boot-classpath classes exist before the app class loader. App libraries
  // (OkHttp, TrustKit, Cronet) wait until that loader is ready.
  try {
    Java.performNow(() => hookBoot(pkg))
  } catch (error) {
    send({ sideglass: 'boot', error: String(error) })
  }
  Java.perform(() => {
    try {
      hookBoot(pkg)
      hookApp(pkg)
    } catch (error) {
      send({ sideglass: 'app', error: String(error) })
    }
  })
}

function hookBoot(pkg) {
  hookChain('com.android.org.conscrypt.TrustManagerImpl', ['checkTrusted', 'checkServerTrusted', 'verifyChain', 'getTrustedChainForServer'])
  hookChain('com.android.org.conscrypt.Platform', ['checkServerTrusted'])
  hookChain('android.security.net.config.NetworkSecurityTrustManager', ['checkServerTrusted', 'checkPins'])
  hookChain('android.security.net.config.RootTrustManager', ['checkServerTrusted'])
  hookVoid('android.webkit.SslErrorHandler', 'cancel', function () {
    this.proceed()
  })
  tagUrl(pkg)
}

function hookApp(pkg) {
  hookVoid('okhttp3.CertificatePinner', 'check')
  hookVoid('okhttp3.CertificatePinner', 'check$okhttp')
  hookTrue('okhttp3.internal.tls.OkHostnameVerifier', 'verify')
  hookTrue('com.android.okhttp.internal.tls.OkHostnameVerifier', 'verify')
  hookTrue('com.datatheorem.android.trustkit.pinning.OkHostnameVerifier', 'verify')
  hookVoid('com.datatheorem.android.trustkit.pinning.PinningTrustManager', 'checkServerTrusted')
  hookChain('org.chromium.net.X509Util', ['verifyServerCertificates'])
  tagOkHttp(pkg)
}

/** Replace the outcome of every overload: void methods return, booleans accept, lists keep the chain. */
function hookChain(className, methods) {
  const cls = use(className)
  if (!cls) return
  for (const method of methods) {
    const target = cls[method]
    if (!target || !target.overloads) continue
    target.overloads.forEach((overload) => {
      overload.implementation = function () {
        const returned = returnName(overload)
        if (returned === 'void') return
        if (returned === 'boolean') return true
        const chain = certificateChain(arguments)
        if (chain) return chain
        if (returned === 'java.util.List' || returned === 'java.util.Collection') return Java.use('java.util.ArrayList').$new()
        // Cronet wants an AndroidCertVerifyResult. Status 0 is VERIFIED.
        if (returned === 'org.chromium.net.AndroidCertVerifyResult') {
          try {
            return Java.use('org.chromium.net.AndroidCertVerifyResult').$new(0)
          } catch {
            return null
          }
        }
        return null
      }
    })
  }
}

function hookVoid(className, method, body) {
  const cls = use(className)
  const target = cls && cls[method]
  if (!target || !target.overloads) return
  target.overloads.forEach((overload) => {
    overload.implementation = body
      ? function () {
          return body.apply(this, arguments)
        }
      : function () {}
  })
}

function hookTrue(className, method) {
  const cls = use(className)
  const target = cls && cls[method]
  if (!target || !target.overloads) return
  target.overloads.forEach((overload) => {
    overload.implementation = function () {
      return true
    }
  })
}

function tagOkHttp(pkg) {
  const Builder = use('okhttp3.Request$Builder')
  if (!Builder || !Builder.build) return
  try {
    const build = Builder.build.overload()
    build.implementation = function () {
      try {
        this.header(HEADER, pkg)
      } catch {
        // A builder that rejects the header still has to build.
      }
      return build.call(this)
    }
  } catch (error) {
    send({ sideglass: 'okhttp-tag', error: String(error) })
  }
}

function tagUrl(pkg) {
  const URL = use('java.net.URL')
  if (!URL || !URL.openConnection) return
  URL.openConnection.overloads.forEach((overload) => {
    overload.implementation = function () {
      const connection = overload.apply(this, arguments)
      try {
        connection.setRequestProperty(HEADER, pkg)
      } catch {
        // Some URLConnection subclasses have no request properties.
      }
      return connection
    }
  })
}

function use(className) {
  try {
    return Java.use(className)
  } catch {
    return null
  }
}

function returnName(overload) {
  try {
    return String(overload.returnType.className)
  } catch {
    return 'void'
  }
}

function certificateChain(args) {
  const Arrays = Java.use('java.util.Arrays')
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === null || arg === undefined) continue
    try {
      if (typeof arg.size === 'function' && arg.size() > 0) return arg
    } catch {
      // Not a List.
    }
    try {
      if (arg.length > 0) return Arrays.asList(arg)
    } catch {
      // Not a Java array.
    }
  }
  return null
}

function scanAll() {
  let count = 0
  for (const mod of Process.enumerateModules()) {
    // libflutter.so statically links BoringSSL. Patching those symbols crashed
    // the pinning demo in egl_display_t::initialize (SIGSEGV on the raster thread).
    // Separate libssl / conscrypt / cronet libraries are hooked. Flutter itself
    // is handled by hookFlutter, which only rewrites the custom-verify callback.
    if (/flutter/i.test(mod.name)) {
      count += hookFlutter(mod)
      continue
    }
    if (!/ssl|boring|cronet|conscrypt/i.test(mod.name)) continue
    count += scanModule(mod)
  }
  return count
}

function hookFlutter(mod) {
  let count = 0
  for (const name of ['SSL_CTX_set_custom_verify', 'SSL_set_custom_verify']) {
    let exported = null
    try {
      exported = mod.findExportByName(name)
    } catch {
      exported = null
    }
    if (hookCustomVerify(exported)) count++
  }
  return count
}

function scanModule(mod) {
  let count = 0
  for (const name of ['SSL_CTX_set_custom_verify', 'SSL_set_custom_verify']) {
    if (hookCustomVerify(findSymbol(mod, name))) count++
  }
  for (const name of ['SSL_CTX_set_verify', 'SSL_set_verify']) {
    if (hookVerifyNone(findSymbol(mod, name))) count++
  }
  if (hookReturn(findSymbol(mod, 'SSL_get_verify_result'), SSL_VERIFY_OK)) count++
  if (hookReturn(findSymbol(mod, 'X509_verify_cert'), 1)) count++
  return count
}

function findSymbol(mod, name) {
  try {
    const exported = mod.findExportByName(name)
    if (isExecutable(exported)) return exported
  } catch {
    // The module has no such export.
  }
  // Flutter statically links BoringSSL and often strips the export table.
  // Only a function symbol is safe to patch. A data symbol with the same name
  // would corrupt the process, which crashed the pinning demo's Flutter raster thread.
  if (!/flutter/i.test(mod.name) || typeof mod.enumerateSymbols !== 'function') return null
  try {
    for (const sym of mod.enumerateSymbols()) {
      if (sym.name === name && sym.type === 'function' && isExecutable(sym.address)) return sym.address
    }
  } catch {
    // Stripped binaries throw or return nothing useful.
  }
  return null
}

function isExecutable(address) {
  if (!address || address.isNull()) return false
  try {
    const range = Process.findRangeByAddress(address)
    return Boolean(range && range.protection.indexOf('x') !== -1)
  } catch {
    return false
  }
}

function hookCustomVerify(address) {
  return once(address, (target) => {
    Interceptor.attach(target, {
      onEnter(args) {
        args[1] = ptr(SSL_VERIFY_NONE)
        args[2] = acceptCert
      },
    })
  })
}

function hookVerifyNone(address) {
  return once(address, (target) => {
    Interceptor.attach(target, {
      onEnter(args) {
        args[1] = ptr(SSL_VERIFY_NONE)
        args[2] = ptr(0)
      },
    })
  })
}

function hookReturn(address, value) {
  return once(address, (target) => {
    Interceptor.attach(target, {
      onLeave(retval) {
        retval.replace(value)
      },
    })
  })
}

function once(address, install) {
  if (!address || address.isNull()) return false
  const key = address.toString()
  if (hooked.has(key)) return false
  try {
    install(address)
    hooked.add(key)
    return true
  } catch {
    return false
  }
}

function hookLoader() {
  const libc = Process.findModuleByName('libc.so')
  if (!libc) return
  for (const name of ['android_dlopen_ext', 'dlopen']) {
    let address = null
    try {
      address = libc.findExportByName(name)
    } catch {
      address = null
    }
    once(address, (target) => {
      Interceptor.attach(target, {
        onEnter(args) {
          try {
            this.opened = args[0].readCString()
          } catch {
            this.opened = ''
          }
        },
        onLeave() {
          if (/flutter|ssl|cronet|boring/i.test(this.opened || '')) scanAll()
        },
      })
    })
  }
}
