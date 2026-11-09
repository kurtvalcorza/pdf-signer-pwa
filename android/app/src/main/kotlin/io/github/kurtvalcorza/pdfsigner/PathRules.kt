package io.github.kurtvalcorza.pdfsigner

/**
 * Pure path and MIME rules for the asset handler (contract shell-bridge §1, R2, R3).
 * No Android imports, so the JVM unit tests run without a device.
 */
object PathRules {
  sealed interface Resolved
  data class Asset(val assetPath: String, val mime: String, val encoding: String?) : Resolved
  data object NotFound : Resolved

  private val mimeByExtension = mapOf(
    "html" to "text/html",
    "js" to "text/javascript",
    "mjs" to "text/javascript",
    "css" to "text/css",
    "json" to "application/json",
    "webmanifest" to "application/manifest+json",
    "png" to "image/png",
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "svg" to "image/svg+xml",
    "ico" to "image/x-icon",
    "wasm" to "application/wasm",
    "woff2" to "font/woff2",
    "txt" to "text/plain",
  )

  /** [path] is the handler's path, relative to the origin root, without a leading slash. */
  fun resolve(path: String): Resolved {
    val p = path.ifEmpty { "index.html" }
    if (p.startsWith("/") || p.contains('\\') || p.contains('%')) return NotFound
    if (p.split('/').any { it.isEmpty() || it == "." || it == ".." }) return NotFound
    val mime = mimeFor(p)
    val textual = mime.startsWith("text/") || mime.endsWith("json") || mime == "image/svg+xml"
    return Asset("www/$p", mime, if (textual) "utf-8" else null)
  }

  fun mimeFor(path: String): String =
    mimeByExtension[path.substringAfterLast('/').substringAfterLast('.', "").lowercase()]
      ?: "application/octet-stream"

  /**
   * Response headers for every asset: always empty. A Content-Security-Policy header here
   * would govern workers too and break pdf.js (R3); the meta tag in index.html governs
   * documents only.
   */
  fun headers(): Map<String, String> = emptyMap()
}
