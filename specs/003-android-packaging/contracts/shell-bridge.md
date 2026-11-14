# Contract: Android shell ↔ shared web app

The shared web app is **not modified** (FR-001, SC-006). Everything below is owned by the Android
shell and is invisible to the web and desktop builds. See [research.md](../research.md) R2, R4, R7,
R8 and R11.

## 1. Origin and serving

- Origin: `https://appassets.androidplatform.net`. Every page, worker, service-worker and asset
  request is served from the APK's `assets/www/` by the shell's path handler.
- Responses carry `Content-Type` from an explicit map and **no other headers**: in particular no
  `Content-Security-Policy`, so the meta-tag policy in `index.html` governs documents only.
- A missing path returns `404` with an empty body. It never returns `null`, which would fall
  through to the network.
- A path outside `www/` after normalisation returns `404`.
- Navigation: same origin only. Exactly `https://github.com/kurtvalcorza/pdf-signer-pwa` (the
  shared app's repository link) opens in the system browser. Anything else is dropped silently.

## 2. Injected script (`shell.js`)

Injected with `WebViewCompat.addDocumentStartJavaScript(script, {"https://appassets.androidplatform.net"})`,
so it never runs in any other origin. It does exactly three things:

1. **Blob registry**: wraps `URL.createObjectURL(obj)` to record `url → obj` when `obj` is a
   `Blob`, and `URL.revokeObjectURL(url)` to remove it. The return values are unchanged.
2. **Download interception**: wraps `HTMLAnchorElement.prototype.click`. If `this.download` is
   non-empty, `this.href` starts with `blob:`, and the URL is in the registry, it sends a save
   request (§3) and returns **without** calling the original. Otherwise it calls the original
   unchanged.
3. **Notices**: renders the native-supplied disclosure panel (§5) and the engine notice when the
   shell asks for it, in the shell's own DOM node outside `#root`.

It MUST NOT read or modify the shared app's state, storage, React tree or any `#root` content, and
MUST NOT touch `fetch`, `XMLHttpRequest`, `WebSocket` or workers.

## 3. Save messages (web → native)

Channel: `WebViewCompat.addWebMessageListener(webView, "pdfSignerShell", {"https://appassets.androidplatform.net"}, listener)`.
Messages from any other origin, or from a sub-frame, are dropped.

```text
{ "type": "save-begin", "id": <int>, "name": <string>, "mime": <string>, "size": <int> }
  then either
<ArrayBuffer of exactly `size` bytes>                       (when WEB_MESSAGE_ARRAY_BUFFER is supported)
  or
{ "type": "save-chunk", "id": <int>, "seq": <int>, "data": <base64, ≤ 1 MB decoded> } …
{ "type": "save-end",   "id": <int> }
  or, at any point, when the page cannot read or send the bytes
{ "type": "save-failed", "id": <int> }
```

`save-failed` fails a transfer that is still receiving, or, when none was begun (the blob could
not be read before `save-begin`), is shown natively as a failed save on its own.

Native → web reply, on the same port: `{ "type": "save-result", "id", "status": "saved" | "cancelled" | "failed", "reason"? }`.
The shared app ignores it (its downloads are fire-and-forget). The shell itself shows the outcome
natively. See [data-model.md](../data-model.md) "Save request" for validation and states.

Refusals before the save dialog opens: `size` over the limit, a mismatch between `size` and the
bytes received, a second `save-begin` while one is active, or a malformed message.

## 4. File chooser (WebView → native)

`onShowFileChooser` maps `FileChooserParams.getAcceptTypes()`:

| accept value(s) | Intent | MIME types |
|---|---|---|
| `.pdf` | `ACTION_OPEN_DOCUMENT` | `application/pdf` |
| `image/png`, `image/jpeg` | `ACTION_OPEN_DOCUMENT` | `image/png`, `image/jpeg` |
| `image/*` with `isCaptureEnabled()` | `ACTION_IMAGE_CAPTURE` → `FileProvider` URI | n/a |
| `.p12`, `.pfx` | `ACTION_OPEN_DOCUMENT` | `application/x-pkcs12`, `application/octet-stream` |
| anything else | refused | `null` returned |

Every path, including cancel, a missing camera app and errors, calls the callback exactly once
(`null` on failure). Single selection only. No runtime permission is requested.

## 5. Disclosures shown by the shell (FR-015, FR-016, FR-017, FR-023, US2 AS3)

An "About this app" panel, opened from a small shell-owned button outside `#root`, lists:

- version, source commit, and that it is installed from outside the store and **never updates
  itself**;
- the system web view version in use, the validated floor, and that the engine depends on the
  device;
- that the app has **no network permission**, how to confirm it (Settings → Apps → PDF Signer →
  Permissions shows none), and what it doesn't cover: crash reports from the system web view,
  controlled by the device's usage & diagnostics setting;
- that remembered items live only in this app's storage, are excluded from backup and transfer to
  a new phone, and are deleted on uninstall;
- that screenshots and the recent-apps preview are blocked, and that the saved file can be opened
  elsewhere to view or share it.

The engine notice (UNVALIDATED state) is a non-blocking banner, with no "don't show again". The
REFUSED state is a native screen, and the web app is never loaded.

## 6. Native-side invariants

- `FLAG_SECURE` is set before any content; `setRecentsScreenshotEnabled(false)` on API 33+.
- WebView settings: JavaScript on, DOM storage on, `allowFileAccess` off, `allowContentAccess` off,
  multiple windows off, Safe Browsing off, and `setWebContentsDebuggingEnabled(false)` in release.
- `DownloadListener` ignores every request.
- `cache/capture/` is cleared on launch; a capture is also deleted at the next chooser and when
  the activity is destroyed.
