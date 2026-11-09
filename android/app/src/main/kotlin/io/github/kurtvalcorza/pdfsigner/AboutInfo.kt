package io.github.kurtvalcorza.pdfsigner

/**
 * Text for the shell's "About this app" panel and engine notice (contract shell-bridge §5, FR-015,
 * FR-016, FR-017, FR-023, US2 AS3). Pure Kotlin, so the JVM tests can check every disclosure.
 */
object AboutInfo {
  /** The size the Android release gate signs (research.md G2): larger PDFs may exceed WebView memory. */
  const val TESTED_LARGE_PDF_MB = 25

  data class Inputs(
    val version: String,
    val commit: String,
    val webViewVersion: String?,
    val validatedFloor: Int,
    val engine: EngineCheck.State,
  )

  fun title(i: Inputs) = "PDF Signer for Android ${i.version}"

  fun lines(i: Inputs): List<String> = listOf(
    "Version ${i.version}, built from source commit ${i.commit.take(12)}.",
    "Installed from outside the Play Store. This app never updates itself: install a new version " +
      "from the project's GitHub release page after checking its signing fingerprint.",
    "Engine: the phone's system WebView, version ${i.webViewVersion ?: "unknown"}. This release was " +
      "validated with WebView ${i.validatedFloor} and later. The WebView updates with the phone, not " +
      "with this app, so how the app behaves depends on this device.",
    "No network permission: Android does not let this app open network connections. To confirm, " +
      "open Settings → Apps → PDF Signer: Permissions says \"No permissions requested\". What this does not cover: " +
      "the system WebView's own crash reports, which follow this phone's usage & diagnostics setting.",
    "A remembered certificate or signature stays in this app's storage only. It is excluded from " +
      "backups and from transfer to a new phone, and it is deleted when you uninstall the app.",
    "Screenshots, screen recording and the recent-apps preview are blocked while the app is open. " +
      "To view or share a signed PDF, open the saved file in another app.",
    "Large files: PDFs above about $TESTED_LARGE_PDF_MB MB may fail to sign on Android because of the " +
      "system WebView's memory limit. The app says so and nothing is saved. Use the web or desktop " +
      "version for those files.",
  )

  /** The non-blocking engine notice: only below the validated floor, with no "don't show again". */
  fun banner(i: Inputs): String? =
    if (i.engine == EngineCheck.State.UNVALIDATED) {
      "This phone's system WebView (${i.webViewVersion ?: "unknown"}) is older than the version this " +
        "release was tested with (${i.validatedFloor}). Signing should work, but it is not verified " +
        "on this engine. Update Android System WebView to remove this notice."
    } else {
      null
    }
}
