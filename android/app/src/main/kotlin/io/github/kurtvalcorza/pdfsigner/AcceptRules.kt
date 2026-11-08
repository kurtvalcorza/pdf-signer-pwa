package io.github.kurtvalcorza.pdfsigner

/**
 * Maps a file input's accept values to MIME types for the system picker (contract shell-bridge §4).
 * Pure Kotlin, no Android imports.
 */
object AcceptRules {
  private val images = setOf("image/png", "image/jpeg")

  /**
   * Returns the MIME types to open, or null when the request is refused. Entries arrive both as
   * separate items and comma-joined (spike S7).
   */
  fun mimeTypes(acceptTypes: Array<String>?): Array<String>? {
    val accept = acceptTypes.orEmpty()
      .flatMap { it.split(',') }
      .map { it.trim().lowercase() }
      .filter { it.isNotEmpty() }
      .toSet()
    if (accept.isEmpty()) return null
    return when {
      accept == setOf(".pdf") || accept == setOf(".pdf", "application/pdf") -> arrayOf("application/pdf")
      accept.all { it == ".p12" || it == ".pfx" || it == "application/x-pkcs12" } ->
        arrayOf("application/x-pkcs12", "application/octet-stream")
      accept.all { it in images } -> images.filter { it in accept }.toTypedArray()
      else -> null
    }
  }
}
