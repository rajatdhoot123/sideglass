# Sideglass: handoff and TODO

Status updated 2026-11-07, after PRs #4, #5, #6 and #8 merged.
Repo: https://github.com/rajatdhoot123/sideglass (public, Apache-2.0).
Local folder on the original machine: `~/project/build-with-me`.

## 1. What Sideglass is

A desktop app (Electron) that shows every API call an Android app makes, next to the live
phone. Sideglass runs its own rooted Android emulator, makes it trust a local CA, sends all its
traffic through a capture proxy, and shows requests on the left and the phone on the right.
The user never sets anything up.

Use it on apps you build or are allowed to test. Keep it local only, with no cloud capture.

## 2. State of the code

`main` has the v0.1 capture app (setup, proxy, system CA, Requests / Logs / Refused TLS, APK drop, launch, logcat, test SMS, HAR) plus the rows below. Draft PR #2 only added this handoff and the Tango packages; PR #4 contains it and the stream. Do not continue `feat/scrcpy-stream`.

| PR | What landed |
|---|---|
| #1 | **+ Add app:** F-Droid, a Play Store link (second phone), a USB phone, an APK file. Headless check: `scripts/apps.mts`. |
| #3 | Play hand-over: Sideglass taps Install and stops only when the user must act. |
| #4 | Roadmap 4.1. H.264 scrcpy stream, real touch, scroll and keyboard, screenshot fallback, on both phones. |
| #5 | The Play helper AVD gets `PlayStore.enabled=yes`. A running helper that still has Play off is restarted after its AVD lock is released. Cold boot only when that flag was off. |
| #6 | First approach for licensed apps: run them on the Play phone, outside the proxy. Replaced by #7. |
| #7 | The real Play Store is copied onto the capture phone, so a licensed app stays there and its traffic is captured. The capture phone starts with `-writable-system`. |
| #8 | Test SMS goes to the phone on screen. One shared Play-phone startup. |
| #11 | First run chooses a virtual phone or the user's own phone over USB. USB mode uses `adb reverse` and the global HTTP proxy, and restores both on quit. No root, so HTTPS bodies only for apps that trust a user CA. |

Next roadmap item is **4.2 Frida certificate unpinning**. 4.3–4.6 are not started. USB mode still cannot see apps that ignore the system proxy.

### Layout

```
src/main/            Electron main process (Node)
  index.ts           window + IPC handlers; SIDEGLASS_SNAPSHOT=/x.png saves window screenshots every 3s
  session.ts         setup steps in order (sdk → ca → proxy → avd → boot → root → trust → ready),
                     app install/launch, Play/USB/F-Droid entry points. The first licensed
                     launch copies the real Play Store onto the capture phone
  sdk.ts             finds the Android SDK (ANDROID_HOME, Android Studio, Homebrew, ~/.sideglass/android-sdk)
  adb.ts             adb CLI wrapper (exec, shell, root, remount, reboot, waitForBoot, screenSize)
  emulator.ts        PhoneSpec: CAPTURE_PHONE (google_apis, port 5590, rooted, -http-proxy)
                     and PLAY_PHONE (google_apis_playstore, port 5592, not rooted); ensureAvd, start, stop.
                     Repairs `PlayStore.enabled` in the Play AVD config before boot
  certificate.ts     CA create/load; installSystemCa: tmpfs over /system/etc/security/cacerts and
                     bind mount over /apex/com.android.conscrypt/cacerts in EVERY mount namespace
  proxy.ts           mockttp proxy: Exchange records, bodies (2 MB cap), TLS refusals, 5000-row cap
  playstore.ts       copies Phonesky and its privileged-permission allowlist from the Play phone
                     and replaces the capture phone's LicenseChecker stub
  screen.ts          screenshot fallback: `screencap -p` loop + `input tap/swipe/keyevent/text`
  mirror.ts          scrcpy H.264 stream (Tango) with touch, scroll, and keyboard; falls back to screen.ts
  keys.ts            DOM key codes to Android key codes
  logcat.ts          `logcat -v threadtime -T 1`, parsed, batched every 250 ms
  har.ts             HAR 1.2 export
  store/apk.ts       pm path / pull / install(-multiple); replaces differently signed user copies
  store/fdroid.ts    F-Droid search API + featured list + install (retries other ABI builds)
  store/play.ts      PlayHelper: second phone, open market:// link, wait for install, pull splits.
                     Copies onto the capture phone are installed as coming from Google Play
  store/usb.ts       list USB phones and their user apps
src/preload/index.ts contextBridge `window.api`
src/shared.ts        Api type shared by preload and renderer
src/renderer/src/    React UI: App, Setup, Requests, Logs, Refused, Phone, DeviceScreen, AddApp, styles.css
scripts/smoke.mts    headless end-to-end: boot, trust, open https://example.com, expect it captured
scripts/apps.mts     headless check of F-Droid and the Play pull path
scripts/trust.mts    re-run CA install on a running phone
```

### Run

```bash
npm install            # npm 11 blocks some install scripts; if Electron is missing:
node node_modules/electron/install.js
npm run dev            # app with hot reload
npm run build && npx electron-vite preview
npm run smoke          # must print "OK example.com captured"
npx tsx scripts/apps.mts
npm run typecheck
```

Needs the Android SDK with `emulator`, `platform-tools` and `cmdline-tools/latest`. The first
run downloads `system-images;android-35;google_apis;<abi>`; the Play flow also downloads
`google_apis_playstore`.

### Things learned the hard way (don't redo)

- **Root only on Google APIs images.** `google_apis_playstore` can't be rooted. That's why the
  Play phone is a separate, unrooted emulator.
- **Android 14+ CA.** The trust store is in the Conscrypt APEX, and each process has its own
  mount namespace. Without the per-namespace bind mount in `caScript()`, about 900 TLS
  refusals came from already-running apps. With it, only pinned hosts refuse.
- **Chrome** ignores runtime system CAs. It's fixed with `/data/local/tmp/chrome-command-line`
  containing `--ignore-certificate-errors-spki-list=<CA SPKI>` plus `--disable-fre`, and
  `am set-debug-app --persistent com.android.chrome` (see `session.ts`).
- **Routing** uses the emulator's `-http-proxy`, so every app's TCP goes through mockttp,
  including apps that ignore the system proxy. mockttp has `passthrough: ['unknown-protocol']`
  for non-HTTP.
- **`subject_hash_old`** is computed in JS (`certificate.ts`), so no host `openssl` is needed.
- **Electron `EventEmitter` `error`:** emitting `error` with no listener crashes the process.
  Use other event names.
- **Screenshots:** macOS blocks `screencapture` from the terminal. Use
  `SIDEGLASS_SNAPSHOT=/path.png` instead.
- **Port 5580** on the original Mac is another project's e2e emulator. Don't kill it.

### Known issues

- Chrome's status bar showed "No internet connection" once, although pages loaded. Probably
  Android's network check (HTTPS to google.com) failing during boot. Check whether it persists.
- mockttp prints `SSLV3_ALERT_CERTIFICATE_UNKNOWN` stack traces to stdout when a pinned
  client refuses. Silence or route them into Refused TLS.
- Requests are not tagged with the app that made them, so the list mixes all apps.
- The Store tab of Add app was clicked through. The Play, USB and APK-file tabs were not.
- Not tested: a real Google sign-in and Install on the Play phone; a real USB phone.
- The first licensed launch reboots the capture phone while Google Play is installed.
  Signing in there goes through the capture proxy and can show up under Refused TLS.
  A real Google account sign-in has not been completed.

## 3. Add apps: checks still open after merge

- [x] UI pass of the Store tab over CDP: featured list renders, Install (Tasks, AntennaPod) → Success.
- [ ] UI pass of the Play, USB and APK-file tabs by hand.
- [ ] Real Play test: sign in on the Play phone, install a free app (e.g. Wikipedia), and confirm
      base + splits are copied to the capture phone and the app starts there. A licensed app
      also needs Google Play on that phone, which the first launch installs.
- [ ] Split-APK check: Play installs splits for ABI/density/language. Both phones are
      `pixel_7` and the same ABI, so splits should match. Confirm with one big app.
- [ ] USB test with a real phone (USB debugging on).

## 4. Roadmap (do in this order, one PR each)

### 4.1 Smooth video and real input (scrcpy via Tango). Shipped in PR #4

Draft PR #2 is included in #4. The branch `feat/scrcpy-stream` is finished.

Goal: replace the `screencap` loop (~5 fps) with a 30–60 fps H.264 stream, with real touch
(press, move, release, long-press, multi-touch) and keyboard.

Already installed (MIT, all at least 2 weeks old):
`@yume-chan/adb@2.6.4`, `@yume-chan/adb-server-node-tcp@2.5.2`, `@yume-chan/scrcpy@2.3.0`,
`@yume-chan/adb-scrcpy@2.3.2`, `@yume-chan/scrcpy-decoder-webcodecs@2.5.3`,
`@yume-chan/stream-extra@2.6.1`. Docs: https://tangoadb.dev/scrcpy/

Plan:
- [x] **Main process:** connect to the running adb server with `AdbServerClient` +
      `AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 })`, then pick the device by
      serial (`emulator-5590`, or `emulator-5592` for the Play phone).
- [x] **Server binary:** download `scrcpy-server-v<version>` from
      https://github.com/Genymobile/scrcpy/releases (Apache-2.0) on first use. The version
      must match the options class you use from `@yume-chan/scrcpy` (e.g. `ScrcpyOptions3_x` ↔
      server 3.x; check which classes 2.3.0 exports). Store it in userData, then
      `AdbScrcpyClient.pushServer`. Server 3.3.3 with `AdbScrcpyOptions3_3_3`.
- [x] **Start:** `AdbScrcpyClient.start(adb, '/data/local/tmp/scrcpy-server.jar', options)` with
      `video: true, audio: false, control: true, maxSize: 1280` (or similar),
      `videoCodec: 'h264'`.
- [x] **Video:** read `client.videoStream` packets (`configuration` and `data`) and send them to
      the renderer over IPC as plain objects (Uint8Array + pts + keyframe).
- [x] **Renderer:** build a `ReadableStream` of those packets, decode with
      `WebCodecsVideoDecoder` from `@yume-chan/scrcpy-decoder-webcodecs`, and draw to a canvas.
      The `<img>` in `DeviceScreen.tsx` stays only for the screenshot fallback.
- [x] **Input:** use `client.controller`: `injectTouch` (down/move/up from pointer events, so
      drags are real and long-press works), `injectScroll` (wheel), `injectKeyCode`
      (keydown/keyup when the canvas has focus), `injectText`, `backOrScreenOn`.
- [x] **Fallback:** keep `screen.ts` (screencap) and use it if scrcpy fails to start.
- [x] Do the same for the Play phone in the Add-app dialog.
- [x] Shipped in PR #4 and merged.
- [ ] Still to confirm: scrolling a list in the window is smooth, typing on the Mac keyboard
      types on the phone, and `npm run smoke` still passes. On the capture phone already running,
      server 3.3.3 produced 576×1280 H.264 and tap, scroll and Home were injected. `npm run smoke`
      was not re-run, because it would `adb root` that live phone. The picture in the window was
      not clicked through.

### 4.2 Frida certificate unpinning

Goal: apps that pin certificates (they appear in **Refused TLS**) can be read.

- [ ] **Frida server:** download `frida-server-<ver>-android-<arm64|x86_64>.xz` from
      https://github.com/frida/frida/releases, push it to `/data/local/tmp/frida-server`,
      `chmod 755`, and start it as root at session start. The phone is already rooted.
- [ ] **Host:** add the `frida` npm package (Node bindings; check it builds for this Electron
      version, otherwise run the `frida` CLI / Python as a child process).
- [ ] **Unpinning script:** write our own, or vendor
      https://github.com/httptoolkit/frida-interception-and-unpinning **only after checking its
      license** (it may be AGPL, which would force Sideglass's license). It must cover
      `TrustManagerImpl`, OkHttp `CertificatePinner`, Conscrypt, `NetworkSecurityConfig` and
      common libraries (Flutter needs a native hook).
- [ ] **UI:** an **Unpin** switch per app on launch. "Launch app" then spawns via Frida
      (`device.spawn(pkg)`, attach, load script, resume) instead of `monkey`.
- [ ] **Refused TLS tab:** add a "Retry with unpinning" button per host/app.
- [ ] **Done when:** an app known to pin, e.g. a sample from
      https://github.com/httptoolkit/android-ssl-pinning-demo, shows its HTTPS calls in Requests.
- [ ] **Docs:** state the limits. Apps with root or Frida detection, or Play Integrity checks,
      may still refuse.

### 4.3 Requests tagged with the app that made them

The proxy only sees TCP from the emulator, not the app. Options, best first:
- [ ] **A (recommended):** a Frida script per launched app adds an `X-Sideglass-App: <pkg>`
      header (hook OkHttp / HttpURLConnection) or reports socket connects (hook
      `connect()`, sending (pkg, local port)). The proxy matches by source port and strips the
      header before forwarding.
- [x] **B (no Frida), shipped:** the virtual phone polls `/proc/net/tcp` and `tcp6` (root)
      and `pm list packages -U`. A request is tagged when one app uid has a socket to that
      address, or when the launched app does. Several apps on the same address stay blank.
      USB phones are not tagged.
- [x] **UI:** an App column and an app filter dropdown in Requests. It follows the last launched app.

### 4.4 Timeline: tap → requests

- [x] Record every input event (tap/swipe/key/text) with a timestamp in the main process.
      Scrolls are collapsed so a flick is one entry. A Timeline tab lists them, each
      expandable to the requests that started within two seconds, with a thumbnail when the
      phone picture can provide one.
- [x] Include the timeline in the HAR export (custom `_sideglass` fields).

### 4.5 gRPC and protobuf

- [x] Detect `content-type: application/grpc*` and `application/x-protobuf`.
- [x] Parse gRPC framing (5-byte header: compressed flag + length) and gunzip compressed frames.
- [x] Decode protobuf **without a schema** (field numbers, wire types, nested messages,
      strings) and show it as a tree in the request and response body.
- [ ] Optionally let the user load a `.proto` and decode with `protobufjs`.
- [ ] Firestore and Google APIs traffic is the main test case.

### 4.6 Product polish (after the roadmap)

- [ ] Packaging and releases: see 4.7.
- [ ] Persist sessions in SQLite (`better-sqlite3`): search across sessions; open old HARs.
- [ ] Request tools: copy as cURL, replay, edit-and-replay, block or mock a URL (mockttp rules
      make this easy).
- [ ] Storage tab: browse the launched app's SQLite databases and shared_prefs
      (`run-as` / root `cp` to /data/local/tmp, then pull).
- [ ] Silence mockttp's console noise; add an app log file.
- [ ] Tests: unit tests for `subjectHashOld`, `packageFromPlayLink`, HAR export and log
      parsing; CI running typecheck and build.
- [ ] README screenshots and GIF (use `SIDEGLASS_SNAPSHOT`).

### 4.7 Downloadable release

Goal: people download Sideglass from GitHub Releases and double-click it, without cloning the
repo or running `npm run dev`. Paths are already packaging-safe: data goes to
`app.getPath('userData')` and `scrcpy-server` is downloaded on first use, so only `out/` ships.

Fix before the first public build:

- [ ] **Android SDK missing.** Many users won't have it, and Google's SDK can't be bundled.
      Add a first-run install: download Google's cmdline-tools to `~/.sideglass/android-sdk`
      (already in `candidateRoots()`) and accept the licenses with the user's consent. Until
      then, the README says "install Android Studio first".
- [ ] **No Java when launched from Finder/Dock.** `sdkmanager` and `avdmanager` need Java. A GUI
      launch doesn't load the shell profile, so `JAVA_HOME` is usually unset and first-run
      setup can fail. When `JAVA_HOME` is unset, use Android Studio's bundled JBR
      (`/Applications/Android Studio.app/Contents/jbr/Contents/Home` on macOS; `jbr/` under
      the Android Studio install on Windows/Linux) and pass it in the env from `emulator.ts`.
      `ANDROID_HOME` has the same GUI-launch problem, but `sdk.ts` already falls back to
      the usual SDK paths.
- [ ] **Windows is untested.** `sdk.ts` handles `.exe`/`.bat`, but nothing has run there. Ship
      macOS and Linux first and label Windows experimental until someone runs a smoke test.

Build and release:

- [ ] Add `electron-builder` + `electron-builder.yml`: macOS `.dmg` (arm64 + x64), Windows
      NSIS `.exe`, Linux `AppImage` + `.deb`.
- [ ] Build an unsigned macOS `.dmg` locally and check the packaged app finds the SDK and Java
      when opened from Finder.
- [ ] GitHub Actions workflow: on a `v*` tag, build on macOS, Windows and Linux runners and
      upload the files to a GitHub Release.
- [ ] Until signing is set up: the README tells macOS users to run
      `xattr -cr /Applications/Sideglass.app`, and Windows users to click past SmartScreen.

Signing (when the Apple Developer account exists):

- [ ] macOS: Apple Developer Program, US$99/yr (₹8,700/yr in India). Developer ID
      Application certificate + notarisation in CI (`CSC_LINK`, `CSC_KEY_PASSWORD`,
      `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` as repo secrets). Hardened
      runtime entitlements must allow what Electron needs (JIT, unsigned executable memory).
      Builds that were already notarised keep working if the membership lapses.
- [ ] Windows: optional code-signing certificate to remove the SmartScreen warning.
- [ ] Auto-update with `electron-updater` reading GitHub Releases (needs signed macOS builds).

## 5. Rules for this project

- Never copy code from third-party apps. Use only open-source code whose license allows it,
  with attribution.
- Don't bundle Google's emulator or system images; download them on the user's machine.
- No third-party APK mirror sites and no unofficial Google Play download APIs. Apps come from
  F-Droid, the user's own Play account on the Play phone, their USB phone, or an APK file.
- Describe the tool as being for apps you build or are allowed to test.
