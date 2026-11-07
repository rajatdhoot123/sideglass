# Sideglass: handoff and TODO

Status as of 2026-11-07. Repo: https://github.com/rajatdhoot123/sideglass (public, Apache-2.0).
Local folder on the original machine: `~/project/build-with-me`.

## 1. What Sideglass is

A desktop app (Electron) that shows every API call an Android app makes, next to the live
phone. Sideglass runs its own rooted Android emulator, makes it trust a local CA, sends all its
traffic through a capture proxy, and shows requests on the left and the phone on the right.
The user never sets anything up.

Use it on apps you build or are allowed to test. Keep it local only, with no cloud capture.

## 2. State of the code

| Branch | State | Contents |
|---|---|---|
| `main` | pushed | v0.1: setup, proxy, system CA, live phone (screencap frames), Requests / Logs / Refused TLS tabs, APK drop, launch app, logcat, test SMS, HAR export. Renamed Sideglass. |
| `feat/add-apps` | **PR #1 merged into main (2026-11-07)** | **+ Add app** window: F-Droid store, Play Store link (second Play phone), USB phone, APK file. Tested headless (`scripts/apps.mts`). |
| `feat/scrcpy-stream` | draft PR #2 (base `main`) | H.264 scrcpy stream, real touch and keyboard, screenshot fallback. See 4.1. |

PR #1 is merged; continue on `feat/scrcpy-stream`.

### Layout

```
src/main/            Electron main process (Node)
  index.ts           window + IPC handlers; SIDEGLASS_SNAPSHOT=/x.png saves window screenshots every 3s
  session.ts         setup steps in order (sdk → ca → proxy → avd → boot → root → trust → ready),
                     app install/launch, Play/USB/F-Droid entry points
  sdk.ts             finds the Android SDK (ANDROID_HOME, Android Studio, Homebrew, ~/.sideglass/android-sdk)
  adb.ts             adb CLI wrapper (exec, shell, root, waitForBoot, screenSize)
  emulator.ts        PhoneSpec: CAPTURE_PHONE (google_apis, port 5590, rooted, -http-proxy)
                     and PLAY_PHONE (google_apis_playstore, port 5592, not rooted); ensureAvd, start, stop
  certificate.ts     CA create/load; installSystemCa: tmpfs over /system/etc/security/cacerts and
                     bind mount over /apex/com.android.conscrypt/cacerts in EVERY mount namespace
  proxy.ts           mockttp proxy: Exchange records, bodies (2 MB cap), TLS refusals, 5000-row cap
  screen.ts          screenshot fallback: `screencap -p` loop + `input tap/swipe/keyevent/text`
  mirror.ts          scrcpy H.264 stream (Tango) with touch, scroll, and keyboard; falls back to screen.ts
  keys.ts            DOM key codes to Android key codes
  logcat.ts          `logcat -v threadtime -T 1`, parsed, batched every 250 ms
  har.ts             HAR 1.2 export
  store/apk.ts       pm path / pull / install(-multiple); replaces differently signed user copies
  store/fdroid.ts    F-Droid search API + featured list + install (retries other ABI builds)
  store/play.ts      PlayHelper: second phone, open market:// link, wait for install, pull splits
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
- The Add-app dialog UI was only type-checked and built, not clicked through. Do a manual pass.
- Not tested: a real Google sign-in and Install on the Play phone; a real USB phone.

## 3. Add apps: checks still open after merge

- [x] UI pass of the Store tab over CDP: featured list renders, Install (Tasks, AntennaPod) → Success.
- [ ] UI pass of the Play, USB and APK-file tabs by hand.
- [ ] Real Play test: sign in on the Play phone, install a free app (e.g. Wikipedia), and confirm
      base + splits are copied and the app starts on the capture phone.
- [ ] Split-APK check: Play installs splits for ABI/density/language. Both phones are
      `pixel_7` and the same ABI, so splits should match. Confirm with one big app.
- [ ] USB test with a real phone (USB debugging on).

## 4. Roadmap (do in this order, one PR each)

### 4.1 Smooth video and real input (scrcpy via Tango). Branch `feat/scrcpy-stream`

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
- [ ] **Done when:** scrolling a list in Chrome is smooth, typing on the Mac keyboard types on
      the phone, and `npm run smoke` still passes. Checked on the already-running capture phone:
      server 3.3.3, 576×1280 H.264, packets kept flowing (~21 fps while that emulator was busy),
      and tap, scroll, and Home were injected. `npm run smoke` was not re-run: it would `adb root`
      the live `emulator-5590`. The phone picture in the window was not clicked through.

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
- [ ] **B (no Frida):** poll `/proc/net/tcp` and `tcp6` on the phone (root) every ~200 ms for
      UIDs, map UID → package with `pm list packages -U`, and match the emulator's outbound
      connection to proxy source ports. The emulator NAT makes this hard; A is simpler.
- [ ] **UI:** an App column and an app filter dropdown in Requests. Default to the launched app.

### 4.4 Timeline: tap → requests

- [ ] Record every input event (tap/swipe/key/text) with a timestamp in the main process.
- [ ] In Requests, group requests that start within ~2 s after an input under that input
      ("Tap at 540,1200 → 4 requests"). Add a Timeline view: a vertical list of inputs, each
      expandable to its requests, plus a thumbnail of the screen frame at that moment.
- [ ] Include the timeline in the HAR export (custom `_sideglass` fields).

### 4.5 gRPC and protobuf

- [ ] Detect `content-type: application/grpc*` and `application/x-protobuf`.
- [ ] Parse gRPC framing (5-byte header: compressed flag + length) and gunzip compressed frames.
- [ ] Decode protobuf **without a schema** (field numbers, wire types, nested messages,
      strings) and show it as a tree. Optionally let the user load a `.proto` and decode with
      `protobufjs`.
- [ ] Firestore and Google APIs traffic is the main test case.

### 4.6 Product polish (after the roadmap)

- [ ] Packaging: `electron-builder`, signed builds for macOS (notarised), Windows and Linux;
      auto-update.
- [ ] First-run SDK install when no Android SDK is found: download Google's cmdline-tools to
      `~/.sideglass/android-sdk` and accept licenses with user consent (Google's SDK can't be
      bundled).
- [ ] Persist sessions in SQLite (`better-sqlite3`): search across sessions; open old HARs.
- [ ] Request tools: copy as cURL, replay, edit-and-replay, block or mock a URL (mockttp rules
      make this easy).
- [ ] Storage tab: browse the launched app's SQLite databases and shared_prefs
      (`run-as` / root `cp` to /data/local/tmp, then pull).
- [ ] Silence mockttp's console noise; add an app log file.
- [ ] Tests: unit tests for `subjectHashOld`, `packageFromPlayLink`, HAR export and log
      parsing; CI running typecheck and build.
- [ ] README screenshots and GIF (use `SIDEGLASS_SNAPSHOT`).

## 5. Rules for this project

- Never copy code from third-party apps. Use only open-source code whose license allows it,
  with attribution.
- Don't bundle Google's emulator or system images; download them on the user's machine.
- No third-party APK mirror sites and no unofficial Google Play download APIs. Apps come from
  F-Droid, the user's own Play account on the Play phone, their USB phone, or an APK file.
- Describe the tool as being for apps you build or are allowed to test.
