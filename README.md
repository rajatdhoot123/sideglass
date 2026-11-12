# Sideglass

See every API call an Android app makes, next to the live phone.

Open the app and it sets up a private, rooted Android emulator for you, makes it trust a
local certificate, and routes its traffic through a capture proxy. Requests show up on the
left; the phone is on the right, and you click and drag on it to use it.

> Use it on apps you build, or apps you are allowed to test.

## What works (v0.1)

- **Choose your phone** on first run (change it later with ⚙):
  - **Virtual phone:** Sideglass's own rooted emulator. Full HTTPS capture for every app.
  - **My phone over USB:** your own phone, no root, only USB debugging. Its traffic goes over the
    cable to Sideglass; quitting Sideglass puts the phone's proxy setting back. You see every host
    an app talks to, but HTTPS contents only for apps that trust user certificates (Chrome, or a
    debug build of your own app). Install `Download/sideglass-ca.crt` on the phone as a CA
    certificate for those.
- **One-click setup:** finds the Android SDK, downloads the Google APIs system image if
  needed, creates the virtual phone, boots it with no window, gets root, and installs the
  CA as a system certificate (Android 14+ Conscrypt store included, in every app's mount
  namespace, so running apps pick it up without a restart).
- **Requests:** method, status, app, host, path, size and time; request/response bodies (JSON
  pretty-printed, protobuf and gRPC as a field tree) and headers. A filter, an app filter, and a
  "hide Google system traffic" switch.
- **Timeline:** each tap, swipe, key and typed text, opened to the requests that followed within
  two seconds. Export HAR keeps that timeline in `_sideglass`.
- **Refused TLS:** hosts that rejected our certificate, which usually means certificate
  pinning.
- **Phone:** live H.264 video; press, drag, long-press, scroll, and type with the keyboard.
  If the video stream cannot start, it falls back to screenshots (click = tap, drag = swipe).
- **Add apps** (the **+ Add app** button):
  - **App store:** search and install free apps from F-Droid, with a featured shelf.
  - **Play Store link:** paste a link; Sideglass opens it on a second virtual phone that has
    the Play Store. Sign in there once with your own Google account and tap Install. The
    app's APK files (base and splits) are copied to the capture phone. Nothing comes from
    third-party APK sites.
  - **From my phone:** pick an app on a USB-connected phone (USB debugging on) to copy it over.
  - **APK file:** drop APKs on the phone (split APKs together).
- **Launch** an installed app from the list.
- **Clone app:** pick an installed app, give it a new package name and name, and Sideglass installs
  a second copy next to the original (base and split APKs). The binary manifest is rewritten: package,
  relative class names, provider authorities, the app's own permissions and the launcher label.
  The copy is signed with a Sideglass key, made once, using the SDK build-tools (`zipalign`, `apksigner`,
  downloaded if missing). Apps that check their own signature, Google sign-in, Play licensing or
  Play Integrity may refuse to run as a clone.
- **Apps that check their Google Play licence** (PairIP, LVL): the first launch puts the real
  Play Store on the capture phone (copied from the Play phone, kept in its writable system), so
  the app runs where its traffic is captured. Sign in to Google Play there once with the account
  that has the app.
- **Logs:** logcat, filtered to the launched app.
- **Test SMS:** send an SMS from any sender to the phone.
- **Export HAR** for Chrome DevTools, Charles, Insomnia and the like.
- Chrome works too: the app tells Chrome to accept the local CA and skips its first-run screens.

## Run it

Needs Node 20+ and the Android SDK (Android Studio, or the command-line tools), with
hardware virtualisation on. Apple Silicon and x86_64 both work.

```bash
npm install
npm run dev        # development, with hot reload
npm run smoke      # headless check: boot, trust, open a page, expect it captured
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
| Screen | [scrcpy](https://github.com/Genymobile/scrcpy) server (Apache-2.0, downloaded on first use) via [Tango](https://tangoadb.dev/scrcpy/) (MIT): H.264, decoded with WebCodecs. Screenshots if the stream cannot start |

## Limits

- Google Play system images cannot be rooted, so apps are downloaded on a separate Play phone.
  The first launch of an app that checks a Play licence copies that Play Store onto the capture
  phone. Paid apps and apps Google does not offer on the Play phone cannot be fetched.
- Signing in to Google Play on the capture phone goes through the capture proxy. A host that
  refuses the proxy shows under Refused TLS and the sign-in cannot finish until that is bypassed.
- Apps that pin certificates refuse the proxy (listed under Refused TLS). Bypassing that
  with Frida is planned.
- Apps that detect root or emulators may refuse to run.
- On the virtual phone, a request is tagged with the app that owned the socket when that can be told apart. USB phones are not tagged.
- gRPC and protobuf bodies are shown as a field tree without a schema. A `.proto` file cannot be loaded yet.

## Roadmap

1. Frida: certificate unpinning for chosen apps
2. Persist sessions, replay a request, and a downloadable release

## License

Apache-2.0
