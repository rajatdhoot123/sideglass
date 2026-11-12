/**
 * The Frida agent injected into one app process at launch.
 *
 * Original code (Apache-2.0), written for Sideglass. It makes apps on the capture
 * phone behave like apps on a normal, certified phone:
 *
 *   1. TLS — trust the Sideglass CA and drop certificate pinning, so the capture
 *      proxy sees HTTPS bodies instead of "Refused TLS" entries (Java layer plus
 *      native BoringSSL for apps that pin below the Java TLS stack).
 *   2. Disguise — hide the usual root / emulator / injection indicators from
 *      client-side checks (RootBeer-style file and shell probes, qemu properties,
 *      build fields, package scans, string scans over process maps).
 *   3. Verdicts (experimental) — for apps that read Play Integrity or SafetyNet
 *      verdicts locally, rewrite the response to a passing verdict. Verdicts
 *      verified by the app's own server (a Google-signed token) can never be
 *      faked from the client; that limit is by design, not a bug.
 */

export const AGENT_SOURCE = String.raw`
'use strict'

function sgLog(level, text) { send({ sg: 'log', level: level, text: String(text) }) }
function sgTry(name, fn) {
  try { fn(); sgLog('debug', name + ' ok') } catch (e) { sgLog('debug', name + ' skipped (' + e + ')') }
}

/* --- what a normal phone looks like --- */

var BUILD_SPOOF = {
  FINGERPRINT: 'google/akita/akita:15/AP4A.250105.002/12739263:user/release-keys',
  MODEL: 'Pixel 8',
  BRAND: 'google',
  MANUFACTURER: 'Google',
  PRODUCT: 'akita',
  DEVICE: 'akita',
  HARDWARE: 'tensor_g3',
  TAGS: 'release-keys',
  TYPE: 'user',
}

var PROP_REWRITES = {
  'ro.debuggable': '0',
  'ro.secure': '1',
  'ro.build.type': 'user',
  'ro.build.tags': 'release-keys',
  'ro.boot.vbmeta.device_state': 'locked',
  'ro.boot.verifiedbootstate': 'green',
  'ro.boot.flash.locked': '1',
}

var HIDE_PATH = /\/su\b|supersu|superuser|magisk|busybox|frida|xposed|edxposed|lsposed|zygisk|shamiko/i

var HIDE_PKGS = [
  'com.topjohnwu.magisk', 'eu.chainfire.supersu', 'com.koushikdutta.superuser',
  'com.thirdparty.superuser', 'com.noshufou.android.su', 'yellow.very.su',
  'de.robv.android.xposed.installer', 'org.lsposed.manager', 'me.weishu.exp',
]

function sanitizeProp(key, value) {
  if (key === null || key === undefined) return value
  var k = String(key)
  if (/qemu|goldfish|ranchu|vbox|genymotion|gmo/i.test(k)) return ''
  if (PROP_REWRITES[k] !== undefined) return PROP_REWRITES[k]
  return value
}

function probeText(cmd) {
  if (cmd === null || cmd === undefined) return ''
  if (Array.isArray(cmd)) return cmd.join(' ')
  return String(cmd)
}

function isRootProbe(cmd) {
  return /(^|\/|\s)su(\s|$)|magisk|busybox|getenforce/i.test(cmd)
}

/* --- verdict rewriting (local reads only) --- */

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function b64urlToBytes(s) {
  var t = s.replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4 !== 0) t += '='
  var out = [], buf = 0, bits = 0
  for (var i = 0; i < t.length; i++) {
    var c = B64.indexOf(t.charAt(i))
    if (c < 0) continue
    buf = (buf << 6) | c
    bits += 6
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff) }
  }
  return out
}

function bytesToB64url(bytes) {
  var out = '', buf = 0, bits = 0
  for (var i = 0; i < bytes.length; i++) {
    buf = (buf << 8) | bytes[i]
    bits += 8
    while (bits >= 6) { bits -= 6; out += B64.charAt((buf >> bits) & 63) }
  }
  if (bits > 0) out += B64.charAt((buf << (6 - bits)) & 63)
  return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function bytesToString(bytes) {
  var s = ''
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

function stringToBytes(s) {
  var b = []
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c > 127) {
      if (c < 2048) b.push(0xc0 | (c >> 6), 0x80 | (c & 63))
      else b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    } else b.push(c)
  }
  return b
}

/** If the string is a locally-readable Play Integrity / SafetyNet JWS, rewrite it to pass. */
function rewriteVerdicts(s) {
  if (typeof s !== 'string') return s
  var parts = s.split('.')
  if (parts.length !== 3) return s
  var payload
  try { payload = JSON.parse(bytesToString(b64urlToBytes(parts[1]))) } catch (e) { return s }
  var changed = false
  if (payload.deviceIntegrity !== undefined) {
    payload.deviceIntegrity = ['MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY', 'MEETS_STRONG_INTEGRITY']
    changed = true
  }
  if (payload.appIntegrity !== undefined && payload.appIntegrity.appRecognitionVerdict !== undefined) {
    payload.appIntegrity.appRecognitionVerdict = 'PLAY_RECOGNIZED'
    changed = true
  }
  if (payload.ctsProfileMatch !== undefined) { payload.ctsProfileMatch = true; changed = true }
  if (payload.basicIntegrity !== undefined) { payload.basicIntegrity = true; changed = true }
  if (!changed) return s
  return parts[0] + '.' + bytesToB64url(stringToBytes(JSON.stringify(payload))) + '.'
}

function hookStringResults(clsName) {
  var C = Java.use(clsName)
  var methods = C.class.getDeclaredMethods()
  for (var i = 0; i < methods.length; i++) {
    var m = methods[i]
    if (String(m.getReturnType().getName()) !== 'java.lang.String') continue
    var name = String(m.getName())
    ;(function (name) {
      C[name].overloads.forEach(function (ov) {
        ov.implementation = function () {
          var result = this[name].apply(this, arguments)
          try {
            var rewritten = rewriteVerdicts(result)
            if (rewritten !== result) {
              sgLog('info', 'verdicts rewritten via ' + clsName + '.' + name)
              return rewritten
            }
          } catch (e) {}
          return result
        }
      })
    })(name)
  }
}

function scanForVerdictClasses() {
  Java.perform(function () {
    var found = []
    Java.enumerateLoadedClasses({
      onMatch: function (name) {
        if (/IntegrityTokenResponse|IntegrityVerdictResponse|AttestationResponse/.test(name)) found.push(name)
      },
      onComplete: function () {
        found.forEach(function (n) {
          sgTry('verdict hook ' + n, function () { hookStringResults(n) })
        })
      },
    })
  })
}

/* --- native helpers (work with or without Java) --- */

function globalExport(name) {
  try { var m = Module.getGlobalExportByName(name); if (m !== null) return m } catch (e) {}
  try { return Module.findExportByName(null, name) } catch (e) {}
  return null
}

function hookNative() {
  ;['SSL_CTX_set_custom_verify', 'SSL_set_custom_verify'].forEach(function (fname) {
    sgTry('native ' + fname, function () {
      var p = globalExport(fname)
      if (p === null) throw new Error('symbol not found')
      var ok = new NativeCallback(function (ssl, alert) { return 0 }, 'int', ['pointer', 'pointer'])
      Interceptor.attach(p, { onEnter: function (args) { args[2] = ok } })
    })
  })
  sgTry('native SSL_get_verify_result', function () {
    var p = globalExport('SSL_get_verify_result')
    if (p === null) throw new Error('symbol not found')
    Interceptor.replace(p, new NativeCallback(function () { return 0 }, 'long', ['pointer']))
  })
  sgTry('native maps scan filter', function () {
    var p = globalExport('strstr')
    if (p === null) throw new Error('symbol not found')
    var orig = new NativeFunction(p, 'pointer', ['pointer', 'pointer'])
    Interceptor.replace(p, new NativeCallback(function (hay, needle) {
      try {
        var n = needle.readCString()
        if (n !== null && /frida|xposed|magisk|zygisk|linjector|gadget/i.test(n)) return ptr(0)
      } catch (e) {}
      return orig(hay, needle)
    }, 'pointer', ['pointer', 'pointer']))
  })
}

/* --- run --- */

hookNative()

if (Java.available) {
  Java.perform(function () {
    sgLog('info', 'sideglass hooks loaded')

    sgTry('Build spoof', function () {
      var Build = Java.use('android.os.Build')
      for (var field in BUILD_SPOOF) Build[field].value = BUILD_SPOOF[field]
    })

    sgTry('SystemProperties sanitize', function () {
      var SP = Java.use('android.os.SystemProperties')
      SP.get.overload('java.lang.String').implementation = function (key) {
        return sanitizeProp(key, this.get(key))
      }
      SP.get.overload('java.lang.String', 'java.lang.String').implementation = function (key, def) {
        return sanitizeProp(key, this.get(key, def))
      }
      SP.getBoolean.overload('java.lang.String', 'boolean').implementation = function (key, def) {
        var k = String(key)
        if (/qemu|goldfish|ranchu/i.test(k)) return false
        if (k === 'ro.debuggable') return false
        return this.getBoolean(key, def)
      }
    })

    sgTry('File.exists hide artifacts', function () {
      var F = Java.use('java.io.File')
      F.exists.implementation = function () {
        var p = this.getAbsolutePath()
        if (p !== null && HIDE_PATH.test(String(p))) return false
        return this.exists()
      }
    })

    sgTry('Runtime.exec hide su probes', function () {
      var RT = Java.use('java.lang.Runtime')
      var IOE = Java.use('java.io.IOException')
      var hook = function () {
        if (isRootProbe(probeText(arguments[0]))) throw IOE.$new('su: not found')
        return this.exec.apply(this, arguments)
      }
      RT.exec.overload('java.lang.String').implementation = hook
      RT.exec.overload('[Ljava.lang.String;').implementation = hook
      RT.exec.overload('java.lang.String', '[Ljava.lang.String;').implementation = hook
      RT.exec.overload('[Ljava.lang.String;', '[Ljava.lang.String;').implementation = hook
    })

    sgTry('PackageManager hide root apps', function () {
      var PM = Java.use('android.app.ApplicationPackageManager')
      var NNE = Java.use('android.content.pm.PackageManager$NameNotFoundException')
      var deny = function (name) { if (HIDE_PKGS.indexOf(String(name)) >= 0) throw NNE.$new(String(name)) }
      PM.getPackageInfo.overload('java.lang.String', 'int').implementation = function (name, flags) {
        deny(name)
        return this.getPackageInfo(name, flags)
      }
      PM.getPackageInfo.overload('java.lang.String', 'android.content.pm.PackageManager$PackageInfoFlags').implementation = function (name, flags) {
        deny(name)
        return this.getPackageInfo(name, flags)
      }
      var filterSlice = function (slice) {
        try {
          var f = slice.getClass().getDeclaredField('mList')
          f.setAccessible(true)
          var list = f.get(slice)
          var out = Java.use('java.util.ArrayList').$new()
          var it = list.iterator()
          while (it.hasNext()) {
            var item = it.next()
            var pf = item.getClass().getDeclaredField('packageName')
            pf.setAccessible(true)
            if (HIDE_PKGS.indexOf(String(pf.get(item))) === -1) out.add(item)
          }
          f.set(slice, out)
        } catch (e) {}
        return slice
      }
      PM.getInstalledPackages.overload('int').implementation = function (flags) {
        return filterSlice(this.getInstalledPackages(flags))
      }
      PM.getInstalledApplications.overload('int').implementation = function (flags) {
        return filterSlice(this.getInstalledApplications(flags))
      }
    })

    sgTry('Permissive TrustManager', function () {
      var X509TM = Java.use('javax.net.ssl.X509TrustManager')
      globalThis.sgPermissiveTM = Java.registerClass({
        name: 'sg.PermissiveTrustManager',
        implements: [X509TM],
        methods: {
          checkClientTrusted: function (chain, authType) {},
          checkServerTrusted: function (chain, authType) {},
          getAcceptedIssuers: function () { return Java.array('java.security.cert.X509Certificate', []) },
        },
      })
    })

    sgTry('SSLContext.init permissive', function () {
      var SC = Java.use('javax.net.ssl.SSLContext')
      var X509TM = Java.use('javax.net.ssl.X509TrustManager')
      SC.init.overload('[Ljavax.net.ssl.KeyManager;', '[Ljavax.net.ssl.TrustManager;', 'java.security.SecureRandom').implementation = function (km, tm, sr) {
        if (tm !== null && globalThis.sgPermissiveTM !== undefined) {
          for (var i = 0; i < tm.length; i++) {
            try { Java.cast(tm[i], X509TM); tm[i] = globalThis.sgPermissiveTM.$new() } catch (e) {}
          }
        }
        return this.init(km, tm, sr)
      }
    })

    sgTry('TrustManagerImpl bypass', function () {
      var TMI = Java.use('com.android.org.conscrypt.TrustManagerImpl')
      var Arrays = Java.use('java.util.Arrays')
      TMI.checkServerTrusted.overload('[Ljava.security.cert.X509Certificate;', 'java.lang.String').implementation = function (chain, authType) {}
      TMI.checkServerTrusted.overload('[Ljava.security.cert.X509Certificate;', 'java.lang.String', 'java.net.Socket').implementation = function (chain, authType, conn) { return Arrays.asList(chain) }
      TMI.checkServerTrusted.overload('[Ljava.security.cert.X509Certificate;', 'java.lang.String', 'javax.net.ssl.SSLEngine').implementation = function (chain, authType, conn) { return Arrays.asList(chain) }
      TMI.checkServerTrusted.overload('[Ljava.security.cert.X509Certificate;', 'java.lang.String', 'java.lang.String').implementation = function (chain, authType, host) { return Arrays.asList(chain) }
    })

    sgTry('X509TrustManagerExtensions bypass', function () {
      var X = Java.use('android.net.http.X509TrustManagerExtensions')
      var Arrays = Java.use('java.util.Arrays')
      X.checkServerTrusted.overload('[Ljava.security.cert.X509Certificate;', 'java.lang.String', 'java.lang.String').implementation = function (chain, authType, host) {
        return Arrays.asList(chain)
      }
    })

    sgTry('OkHttp CertificatePinner bypass', function () {
      var CP = Java.use('okhttp3.CertificatePinner')
      CP.check.overloads.forEach(function (ov) { ov.implementation = function () {} })
    })

    sgTry('OkHttp check$okhttp bypass', function () {
      var CP = Java.use('okhttp3.CertificatePinner')
      CP['check$okhttp'].overloads.forEach(function (ov) { ov.implementation = function () {} })
    })

    sgTry('OkHostnameVerifier bypass', function () {
      var V = Java.use('okhttp3.internal.tls.OkHostnameVerifier')
      V.verify.overloads.forEach(function (ov) { ov.implementation = function () { return true } })
    })

    sgTry('WebViewClient SSL proceed', function () {
      var W = Java.use('android.webkit.WebViewClient')
      W.onReceivedSslError.implementation = function (view, handler, error) { handler.proceed() }
    })

    scanForVerdictClasses()
    setTimeout(scanForVerdictClasses, 4000)
    setTimeout(scanForVerdictClasses, 12000)
  })
} else {
  sgLog('warn', 'no Java runtime; only native hooks applied')
}
`
