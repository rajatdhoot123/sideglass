# Sideglass

See every API call an Android app makes, next to the live phone.

Open the app and it sets up a private, rooted Android emulator for you, makes it trust a
local certificate, and routes its traffic through a capture proxy. Requests show up on the
left; the phone is on the right, and you click and drag on it to use it.

> Use it on apps you build, or apps you are allowed to test.

## What works (v0.2)

- **One-click setup:** finds the Android SDK, downloads the Google APIs system image if
  needed, creates the virtual phone, boots it with no window, gets root, and installs the
  CA as a system certificate (Android 14+ Conscrypt store included, in every app's mount
  namespace, so running apps pick it up without a restart).
- **Launch hooks** (the **Hooks on** switch, on by default): apps start through
  [Frida](https://frida.re) and get a small agent before their first line runs. It makes
  the Sideglass CA trusted, drops certificate pinning (Java TLS and native BoringSSL),
  hides common root/emulator/injection checks, and rewrites locally-read Play Integrity
  and SafetyNet verdicts. If the hooks cannot start, apps simply launch normally.
- **Refused to run:** when an app blocks itself anyway (root, emulator, integrity or
  crash), Sideglass names the reason in the phone panel, so "the app did nothing" always
  has an explanation. What the app did before the check is still captured.
- **Requests:** method, status, host, path, size and time; request/response bodies (JSON
  pretty-printed) and headers. A filter and a "hide Google system traffic" switch.
- **Refused TLS:** hosts that still rejected our certificate, which usually means
  certificate pinning the hooks did not cover.
- **Phone:** live screen; click = tap, drag = swipe; back/home/recents; type text.
- **Add apps** (the **+ Add app** button):
  - **App store:** search and install free apps from F-Droid, with a featured shelf.
  - **Play Store link:** paste a link; Sideglass opens it on a second virtual phone that has
    the Play Store. Sign in there once with your own Google account and tap Install. The
    app's APK files (base and splits) are copied to the capture phone. Nothing comes from
    third-party APK sites.
  - **From my phone:** pick an app on a USB-connected phone (USB debugging on) to copy it over.
  - **APK file:** drop APKs on the phone (split APKs together).
- **Launch** an installed app from the list.
- **Logs:** logcat, filtered to the launched app.
- **Test SMS:** send an SMS from any sender to the phone.
- **Export HAR** for Chrome DevTools, Charles, Insomnia and the like.
- Chrome works too: the app tells Chrome to accept the local CA and skips its first-run screens.

## Run it

Needs Node 20+, [pnpm](https://pnpm.io), and the Android SDK (Android Studio, or the
command-line tools), with hardware virtualisation on. Apple Silicon and x86_64 both work.

```bash
pnpm install
pnpm dev          # development, with hot reload
pnpm smoke        # headless check: boot, trust, open a page, expect it captured
```

The first run downloads the `system-images;android-35;google_apis;<abi>` image (~1.5 GB)
and creates an AVD named `sideglass_api35`, on port 5590.

## How it works

| Part | Piece |
|---|---|
| Desktop shell | Electron + React + TypeScript (electron-vite) |
| Capture proxy | [mockttp](https://github.com/httptoolkit/mockttp) (Apache-2.0): HTTPS interception, HTTP/2, WebSockets; unknown protocols passed through |
| Routing | The emulator's `-http-proxy`, so every app's TCP goes through the proxy, including apps that ignore the system proxy setting |
| Trust | A generated CA, mounted over `/system/etc/security/cacerts` and `/apex/com.android.conscrypt/cacerts` on a tmpfs; nothing on the system image changes |
| Launch hooks | [Frida](https://frida.re) server pushed to the phone on first launch (pinned version, non-standard port) and our own agent (`src/main/agent.ts`): CA trust, unpinning, disguise, local verdict rewrite |
| Screen | `screencap` frames and `input` events (v0.1); a scrcpy video stream is planned |

## Limits

- Google Play system images cannot be rooted, so the capture phone has no Play Store; the
  separate Play phone downloads apps for it. Paid apps and apps Google does not offer on that
  phone cannot be fetched.
- Play Integrity verdicts that an app's **server** verifies (a Google-signed token) cannot
  be faked from the client — the hooks only rewrite verdicts the app reads locally, and a
  server-verified refusal shows up as "refused to run".
- Some apps detect Frida or hooking itself; the hooks hide the common checks (default port,
  binary name, string scans) but a determined app can still refuse.
- gRPC and protobuf bodies show as binary for now.
- Requests are not yet tied to the app that made them.

## Roadmap

1. scrcpy video stream and keyboard input
2. Hook agent hardening: Flutter pinning, per-app script choices
3. Per-app request attribution
4. Timeline linking taps to the requests that follow
5. gRPC and protobuf decoding

## License

Apache-2.0
