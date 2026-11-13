# Sideglass

See every API call an Android app makes, next to the live phone.

Open the app and it sets up a private, rooted Android emulator for you, makes it trust a
local certificate, and routes its traffic through a capture proxy. Requests show up on the
left; the phone is on the right, and you click and drag on it to use it.

> Use it on apps you build, or apps you are allowed to test.

## What works (v0.1)

- **Choose your phone** on first run. Switch any time from the device menu in the top bar (or ⚙):
  - **Virtual phone:** a Play Store emulator, rooted with Magisk, so apps install with your Google account and HTTPS is captured on the same phone.
  - **Another emulator:** any emulator already running on this computer is listed too, and works like a
    USB phone (no root needed).
  - **My phone over USB:** your own phone, no root, only USB debugging. Its traffic goes over the
    cable to Sideglass; quitting Sideglass puts the phone's proxy setting back. You see every host
    an app talks to, but HTTPS contents only for apps that trust user certificates (Chrome, or a
    debug build of your own app). Install `Download/sideglass-ca.crt` on the phone as a CA
    certificate for those.
- **One-click setup:** finds the Android SDK, downloads the Play Store system image if
  needed, creates the virtual phone and boots it with no window. It then roots the phone with
  [Magisk](https://github.com/topjohnwu/Magisk): the official Magisk APK (pinned version,
  checked against its published SHA-256) is downloaded, the phone's boot ramdisk is patched once
  and cached, and the phone restarts on it. Finally the CA is installed as a system certificate
  (Android 14+ Conscrypt store included, in every app's mount namespace, so running apps pick it
  up without a restart).
- **Requests:** method, status, app, host, path, size and time; request/response bodies (JSON
  pretty-printed, protobuf and gRPC as a field tree) and headers. A filter, an app filter, and a
  "hide Google system traffic" switch.
- **Timeline:** each tap, swipe, key and typed text, opened to the requests that followed within
  two seconds. Export HAR keeps that timeline in `_sideglass`.
- **Refused TLS:** hosts that rejected our certificate, which usually means certificate
  pinning. On the rooted virtual phone, **Unpin** (or **Retry with unpinning**) restarts
  that app under Frida so those calls can be read.
- **Phone:** live H.264 video; press, drag, long-press, scroll, and type with the keyboard.
  If the video stream cannot start, it falls back to screenshots (click = tap, drag = swipe).
- **Add apps** (the **+ Add app** button):
  - **App store:** search and install free apps from F-Droid, with a featured shelf.
  - **Play Store link:** paste a link and Sideglass opens it in the Play Store on the capture
    phone itself, then taps Install for you. You only step in for what only you can do: signing
    in once with your own Google account, prompts, or paid apps. Nothing comes from third-party
    APK sites.
  - **From my phone:** pick an app on a USB-connected phone (USB debugging on) to copy it over.
  - **APK file:** drop APKs on the phone (split APKs together).
- **Launch** an installed app from the list, or tap its icon on the phone. With Hooks on, both
  start it with the agent. With Hooks off, tick **Unpin** to spawn it from the list with only
  Sideglass's own unpinning script.
- **Requests tools:** copy as cURL, replay, edit and replay, block a URL, or answer it with a
  mock body. Load a `.proto` to decode a protobuf or gRPC body with a schema.
- **Saved sessions:** captures are kept in a local SQLite file. Search them, open one, or open
  a HAR file.
- **Code:** decompile an installed app with [jadx](https://github.com/skylot/jadx) (Apache-2.0, downloaded on
  first use; needs Java) and read it in the window: a package tree, a search across every file (well-known
  libraries left out by default), and ⌘-click on a class name to open it. **Find in code** on a request
  searches for the hand-written part of its path, which is usually what a Retrofit annotation holds.
  **Export…** copies the decompiled sources and resources into a folder, to open in an editor or IDE.
  The result is kept per app version, so it opens instantly next time.
- **Storage:** databases and shared preferences of the launched app, on a rooted phone or a
  debuggable app.
- **Launch hooks** (the **Hooks** switch on the virtual phone, on by default): Sideglass watches
  zygote, so an app gets the [Frida](https://frida.re) agent whether it is opened from the list or by
  tapping its icon. The agent trusts the Sideglass CA, drops certificate pinning (Java TLS and native
  BoringSSL), hides common root, emulator and injection checks, and rewrites Play Integrity or SafetyNet
  verdicts the app reads locally. The Frida client runs under system Node, because Electron cannot load
  Frida's native module. If the hooks cannot start, the app still launches normally. An app that was
  already open before hooks armed has to be closed once so its next start is hooked.
- **Refused to run:** when an app blocks itself anyway (root, emulator, integrity or a crash), the phone
  panel names the reason. A verdict the app's own server checks with Google cannot be changed from here.
- **Clone app:** pick an installed app, give it a new package name and name, and Sideglass installs
  a second copy next to the original (base and split APKs). The binary manifest is rewritten: package,
  relative class names, provider authorities, the app's own permissions and the launcher label.
  Names the code also has written in (such as a provider that checks its authority starts with the
  package name) are renamed in the dex files too, with [apktool](https://apktool.org) (Apache-2.0,
  downloaded on first use; needs Java). The copy is signed with a Sideglass key, made once, using the
  SDK build-tools (`zipalign`, `apksigner`, downloaded if missing). Apps that check their own
  signature, Google sign-in, Play licensing or Play Integrity may refuse to run as a clone. Push
  notifications (FCM) need the new package added to the app's Firebase project.
- **Apps that check their Google Play licence** (PairIP, LVL): the capture phone is a Play Store
  image, so they run there. Sign in to Google Play once with the account that has the app.
- **Logs:** logcat, filtered to the launched app.
- **Test SMS:** send an SMS from any sender to the phone.
- **Export HAR** for Chrome DevTools, Charles, Insomnia and the like.
- Chrome works too: the app tells Chrome to accept the local CA and skips its first-run screens.

## Run it

Needs Node 22+, [pnpm](https://pnpm.io) 11, and the Android SDK (Android Studio, or the
command-line tools), with hardware virtualisation on. Apple Silicon and x86_64 both work.
Java is only needed for **Clone app**.

```bash
pnpm install       # also runs the Electron and Frida install steps (see pnpm-workspace.yaml)
pnpm dev           # development, with hot reload
pnpm test
pnpm typecheck
pnpm smoke         # headless check: boot, trust, open a page, expect it captured
pnpm build && pnpm pack   # unsigned installers in release/
```

The first run downloads the `system-images;android-35;google_apis_playstore;<abi>` image
(~1.5 GB) and creates an AVD named `sideglass_play_api35`, on port 5590. The capture proxy
listens on 8890. Sideglass keeps its CA, Magisk files, signing key and saved sessions in the
Electron user-data folder.

Pushing a `v*` tag builds macOS, Linux and Windows packages in GitHub Actions.

## How it works

| Part | Piece |
|---|---|
| Desktop shell | Electron + React + TypeScript (electron-vite) |
| Capture proxy | [mockttp](https://github.com/httptoolkit/mockttp) (Apache-2.0): HTTPS interception, HTTP/2, WebSockets; unknown protocols passed through |
| Virtual phone | A `google_apis_playstore` API 35 emulator, started with `-writable-system` and a Magisk-patched ramdisk |
| Root | [Magisk](https://github.com/topjohnwu/Magisk) (GPL-3.0), downloaded from its official release at runtime and never bundled. The ramdisk patch is Sideglass's own code (`src/main/magisk.ts`) |
| Routing | The emulator's `-http-proxy`, so every app's TCP goes through the proxy, including apps that ignore the system proxy setting. USB phones use `adb reverse` and the global proxy setting |
| Trust | A generated CA, mounted over `/system/etc/security/cacerts` and `/apex/com.android.conscrypt/cacerts` on a tmpfs; nothing on the system image changes |
| App tagging | Each request's socket is matched to its app through `/proc/net` on the phone |
| Launch hooks and unpinning | [Frida](https://frida.re) 17.26.2 (wxWindows Library Licence). `frida-server` is downloaded on first use and pushed to the phone (non-standard port). The host library runs under system Node (`scripts/hooks-host.mjs`, `scripts/frida-host.mjs`), because Electron's Node ABI is different. The agent (`src/main/agent.ts`) and unpinning script are original; the HTTP Toolkit script is AGPL and is not included |
| Screen | [scrcpy](https://github.com/Genymobile/scrcpy) server (Apache-2.0, downloaded on first use) via [Tango](https://tangoadb.dev/scrcpy/) (MIT): H.264, decoded with WebCodecs. Screenshots if the stream cannot start |
| Clone app | Binary manifest and resource table rewritten in place; [apktool](https://apktool.org) only when the dex has the names too; SDK `zipalign` and `apksigner` |
| Decompiler | [jadx](https://github.com/skylot/jadx) 1.5.6 (Apache-2.0), downloaded on first use and checked against its release digest; run with the same Java as Clone app |
| History | `node:sqlite` |

## Limits

- Apps Google Play does not offer on the emulator's device profile cannot be installed from a link.
  Use an APK file or **From my phone** for those.
- Play Integrity verdicts that an app's server checks with Google cannot be changed, and a
  determined root, Frida or pinning check can still win. The phone panel names the refusal.
- USB phones have no root: no hooks, no unpinning, no per-app tagging, HTTPS bodies only for
  apps that trust user certificates, and apps that ignore the system proxy are not seen.
- The capture proxy needs port 8890. If something else holds it, setup stops and says so.
- The downloadable build (`electron-builder.yml`) is unsigned. macOS users run
  `xattr -cr /Applications/Sideglass.app` after copying it out of the disk image. Windows
  SmartScreen warns until the app is signed. Windows itself has not been run.

## Roadmap

1. Harden the hook agent: Flutter pinning, per-app script choices
2. Code signing and a Windows run of the unsigned release

## License

Apache-2.0
